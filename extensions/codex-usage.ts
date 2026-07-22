import {
    getAgentDir,
    type ExtensionAPI,
    type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { readFile, writeFile } from "fs/promises";
import { join } from "path";
import { homedir } from "os";

const CODEX_PROVIDER = "openai-codex";
const OPENCODE_GO_PROVIDER = "opencode-go";
const STATUS_ID = "model-usage";
const POLL_INTERVAL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;
const WEEK_SECONDS = 7 * 24 * 60 * 60;
const BAR_WIDTH = 8;
const GO_BAR_WIDTH = 4;
const OPENCODE_GO_CONFIG_PATH = join(getAgentDir(), "opencode-go-usage.json");

type UsageWindow = {
    used_percent?: number;
    limit_window_seconds?: number;
    reset_after_seconds?: number;
    reset_at?: number;
};

type UsagePayload = {
    rate_limit?: {
        primary_window?: UsageWindow | null;
        secondary_window?: UsageWindow | null;
    } | null;
};

type ResolvedAuth = {
    auth: {
        apiKey?: string;
        headers?: Record<string, string>;
    };
};

type OpenCodeGoConfig = {
    workspaceId: string;
    authCookie: string;
};

type OpenCodeGoWindow = {
    label: string;
    usagePercent: number;
    resetInSec: number;
};

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function decodeAccountId(accessToken: string): string | undefined {
    try {
        const payload = JSON.parse(
            Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString("utf8"),
        );
        return payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
    } catch {
        return undefined;
    }
}

function usageUrl(baseUrl?: string): string {
    const base = (baseUrl || "https://chatgpt.com/backend-api").replace(/\/+$/, "");
    return base.includes("/backend-api")
        ? `${base}/wham/usage`
        : `${base}/api/codex/usage`;
}

function findWeeklyWindow(payload: UsagePayload): UsageWindow | undefined {
    const windows = [
        payload.rate_limit?.primary_window,
        payload.rate_limit?.secondary_window,
    ].filter((window): window is UsageWindow => Boolean(window));

    return windows
        .filter((window) => typeof window.limit_window_seconds === "number")
        .sort(
            (a, b) =>
                Math.abs((a.limit_window_seconds ?? 0) - WEEK_SECONDS) -
                Math.abs((b.limit_window_seconds ?? 0) - WEEK_SECONDS),
        )[0];
}

function formatRelative(resetSeconds: number): string {
    const totalMinutes = Math.ceil(Math.max(0, resetSeconds) / 60);
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;

    return days > 0
        ? `${days}d ${hours}h`
        : hours > 0
          ? `${hours}h ${minutes}m`
          : `${minutes}m`;
}

function formatReset(resetAtSeconds: number): string {
    const reset = new Date(resetAtSeconds * 1000);
    const totalMinutes = Math.ceil(Math.max(0, reset.getTime() - Date.now()) / 60_000);
    const days = Math.floor(totalMinutes / 1440);
    const hours = Math.floor((totalMinutes % 1440) / 60);
    const minutes = totalMinutes % 60;

    const relative = formatRelative(totalMinutes * 60);
    return relative;
}

function makeBar(remaining: number, width: number): string {
    const rounded = Math.round(clamp(remaining, 0, 100));
    const filled = Math.round((rounded / 100) * width);
    return "━".repeat(filled) + "─".repeat(width - filled);
}

function barColor(remaining: number): "error" | "warning" | "success" {
    const rounded = Math.round(clamp(remaining, 0, 100));
    return rounded <= 10 ? "error" : rounded <= 25 ? "warning" : "success";
}

function renderBar(ctx: ExtensionContext, label: string, remaining: number, resetAt?: number): string {
    const rounded = Math.round(clamp(remaining, 0, 100));
    const bar = makeBar(remaining, BAR_WIDTH);
    const reset = resetAt ? ` · resets ${formatReset(resetAt)}` : "";
    const color = barColor(remaining);

    return (
        ctx.ui.theme.fg("dim", `${label} `) +
        ctx.ui.theme.fg(color, `[${bar}] ${rounded}% left`) +
        ctx.ui.theme.fg("dim", reset)
    );
}

function renderCodexStatus(ctx: ExtensionContext, window: UsageWindow): string {
    const used = clamp(window.used_percent ?? 0, 0, 100);
    const remaining = 100 - used;
    const resetAt = window.reset_at ??
        (window.reset_after_seconds
            ? Math.floor(Date.now() / 1000) + window.reset_after_seconds
            : undefined);

    return renderBar(ctx, "Codex", remaining, resetAt);
}

function parseOpenCodeGoWindows(html: string): OpenCodeGoWindow[] {
    const labels: Record<string, string> = {
        rollingUsage: "5h",
        weeklyUsage: "W",
        monthlyUsage: "M",
    };

    return Object.entries(labels).flatMap(([key, label]) => {
        const match = new RegExp(
            `${key}:\\$R\\[\\d+\\]=\\{[^}]*usagePercent:([\\d.]+)[^}]*resetInSec:(\\d+)[^}]*\\}|` +
                `${key}:\\$R\\[\\d+\\]=\\{[^}]*resetInSec:(\\d+)[^}]*usagePercent:([\\d.]+)[^}]*\\}`,
        ).exec(html);
        if (!match) return [];
        const usagePercent = Number(match[1] ?? match[4]);
        const resetInSec = Number(match[2] ?? match[3]);
        if (!Number.isFinite(usagePercent) || !Number.isFinite(resetInSec)) return [];
        return [{ label, usagePercent, resetInSec }];
    });
}

async function readOpenCodeGoConfigFile(path: string): Promise<OpenCodeGoConfig | undefined> {
    try {
        const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<OpenCodeGoConfig>;
        const workspaceId = parsed.workspaceId?.trim();
        const authCookie = parsed.authCookie?.trim();
        return workspaceId && authCookie ? { workspaceId, authCookie } : undefined;
    } catch {
        return undefined;
    }
}

function extractWorkspaceId(value: string): string | undefined {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    if (trimmed.includes("/workspace/")) {
        const after = trimmed.split("/workspace/")[1] ?? "";
        return after.split("/")[0] || undefined;
    }
    if (trimmed.includes("/")) {
        const seg = trimmed.replace(/\/+$/, "").split("/").pop() ?? "";
        return seg || undefined;
    }
    return trimmed || undefined;
}

async function writeOpenCodeGoConfig(config: OpenCodeGoConfig): Promise<void> {
    await writeFile(
        OPENCODE_GO_CONFIG_PATH,
        JSON.stringify(config, null, 2) + "\n",
        { mode: 0o600 },
    );
}

async function resolveOpenCodeGoConfig(): Promise<OpenCodeGoConfig | undefined> {
    const workspaceId = process.env.OPENCODE_GO_WORKSPACE_ID?.trim();
    const authCookie = process.env.OPENCODE_GO_AUTH_COOKIE?.trim();
    if (workspaceId && authCookie) return { workspaceId, authCookie };

    const paths = [
        OPENCODE_GO_CONFIG_PATH,
        join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "opencode", "opencode-quota", "opencode-go.json"),
        join(homedir(), ".opencode", "opencode-quota", "opencode-go.json"),
    ];
    for (const path of paths) {
        const config = await readOpenCodeGoConfigFile(path);
        if (config) return config;
    }
    return undefined;
}

function renderOpenCodeGoStatus(ctx: ExtensionContext, windows: OpenCodeGoWindow[]): string {
    const now = Math.floor(Date.now() / 1000);
    const parts = windows.map((window) => {
        const remaining = 100 - clamp(window.usagePercent, 0, 100);
        const bar = makeBar(remaining, GO_BAR_WIDTH);
        const color = barColor(remaining);
        const reset = formatRelative(window.resetInSec);
        return ctx.ui.theme.fg("dim", `${window.label} `) +
            ctx.ui.theme.fg(color, `[${bar}] ${Math.round(remaining)}%`) +
            ctx.ui.theme.fg("dim", ` ${reset}`);
    });
    return ctx.ui.theme.fg("dim", "Go ") + parts.join(ctx.ui.theme.fg("dim", " · "));
}

export default function (pi: ExtensionAPI) {
    let timer: ReturnType<typeof setInterval> | undefined;
    let initialRefreshTimer: ReturnType<typeof setTimeout> | undefined;
    let refreshing = false;

    async function refreshCodex(ctx: ExtensionContext, signal: AbortSignal): Promise<void> {
        const authStatus = ctx.modelRegistry.getProviderAuthStatus(CODEX_PROVIDER);
        if (!authStatus.configured) {
            ctx.ui.setStatus(STATUS_ID, undefined);
            return;
        }

        const auth = (await ctx.modelRegistry.getProviderAuth(CODEX_PROVIDER)) as
            | ResolvedAuth
            | undefined;
        const apiKey = auth?.auth.apiKey;
        if (!apiKey) throw new Error("Codex OAuth login not found");

        const headers: Record<string, string> = {
            ...auth.auth.headers,
            authorization: `Bearer ${apiKey}`,
            accept: "application/json",
            "user-agent": "pi-usage-extension",
        };
        const hasAccountHeader = Object.keys(headers).some(
            (name) => name.toLowerCase() === "chatgpt-account-id",
        );
        if (!hasAccountHeader) {
            const accountId = decodeAccountId(apiKey);
            if (accountId) headers["chatgpt-account-id"] = accountId;
        }

        const provider = ctx.modelRegistry.getProvider(CODEX_PROVIDER);
        const response = await fetch(usageUrl(provider?.baseUrl), { headers, signal });
        if (!response.ok) throw new Error(`usage request failed (${response.status})`);

        const payload = (await response.json()) as UsagePayload;
        const weekly = findWeeklyWindow(payload);
        if (!weekly) throw new Error("weekly usage window unavailable");

        ctx.ui.setStatus(STATUS_ID, renderCodexStatus(ctx, weekly));
    }

    async function refreshOpenCodeGo(ctx: ExtensionContext, signal: AbortSignal): Promise<void> {
        const config = await resolveOpenCodeGoConfig();
        if (!config) throw new Error("OpenCode Go usage requires OPENCODE_GO_WORKSPACE_ID and OPENCODE_GO_AUTH_COOKIE");

        const response = await fetch(
            `https://opencode.ai/workspace/${encodeURIComponent(config.workspaceId)}/go`,
            {
                headers: {
                    accept: "text/html",
                    cookie: `auth=${config.authCookie}`,
                    "user-agent": "pi-usage-extension",
                },
                signal,
            },
        );
        if (!response.ok) throw new Error(`OpenCode Go usage request failed (${response.status})`);

        const windows = parseOpenCodeGoWindows(await response.text());
        if (windows.length === 0) throw new Error("OpenCode Go usage windows unavailable");

        ctx.ui.setStatus(STATUS_ID, renderOpenCodeGoStatus(ctx, windows));
    }

    async function refresh(ctx: ExtensionContext, notifyOnError = false): Promise<void> {
        if (!ctx.hasUI || refreshing) return;

        const provider = ctx.model?.provider;
        if (provider !== CODEX_PROVIDER && provider !== OPENCODE_GO_PROVIDER) {
            ctx.ui.setStatus(STATUS_ID, undefined);
            return;
        }

        refreshing = true;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

        try {
            await (provider === CODEX_PROVIDER
                ? refreshCodex(ctx, controller.signal)
                : refreshOpenCodeGo(ctx, controller.signal));
        } catch (error) {
            ctx.ui.setStatus(
                STATUS_ID,
                ctx.ui.theme.fg("warning", "Usage unavailable"),
            );
            if (notifyOnError) {
                ctx.ui.notify(
                    error instanceof Error ? error.message : String(error),
                    "warning",
                );
            }
        } finally {
            clearTimeout(timeout);
            refreshing = false;
        }
    }

    pi.on("session_start", (_event, ctx) => {
        if (!ctx.hasUI) return;
        initialRefreshTimer = setTimeout(() => void refresh(ctx), 1_000);
        timer = setInterval(() => void refresh(ctx), POLL_INTERVAL_MS);
    });

    pi.on("agent_settled", async (_event, ctx) => {
        await refresh(ctx);
    });

    pi.on("model_select", async (_event, ctx) => {
        await refresh(ctx);
    });

    pi.on("session_shutdown", (_event, ctx) => {
        if (initialRefreshTimer) clearTimeout(initialRefreshTimer);
        if (timer) clearInterval(timer);
        initialRefreshTimer = undefined;
        timer = undefined;
        if (ctx.hasUI) ctx.ui.setStatus(STATUS_ID, undefined);
    });

    pi.registerCommand("usage-setup", {
        description: "Configure OpenCode Go usage credentials (workspace id + auth cookie)",
        handler: async (_args, ctx) => {
            if (!ctx.hasUI) return;
            const workspaceInput = await ctx.ui.input(
                "OpenCode Go workspace",
                "workspace id, or paste https://opencode.ai/workspace/<id>/go",
            );
            if (!workspaceInput) {
                ctx.ui.notify("Cancelled", "info");
                return;
            }
            const workspaceId = extractWorkspaceId(workspaceInput);
            if (!workspaceId) {
                ctx.ui.notify("Could not parse workspace id", "warning");
                return;
            }
            const authCookie = (await ctx.ui.input(
                "OpenCode Go auth cookie",
                "value of the 'auth' cookie from opencode.ai",
            ))?.trim();
            if (!authCookie) {
                ctx.ui.notify("Cancelled", "info");
                return;
            }
            await writeOpenCodeGoConfig({ workspaceId, authCookie });
            ctx.ui.notify(
                `Saved OpenCode Go usage credentials to ${OPENCODE_GO_CONFIG_PATH}`,
                "info",
            );
            await refresh(ctx, true);
        },
    });

    pi.registerCommand("usage", {
        description: "Refresh current model subscription usage",
        handler: async (_args, ctx) => {
            await refresh(ctx, true);
        },
    });
}
