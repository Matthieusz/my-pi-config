import { access, readFile, readdir, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
    SessionManager,
    type ExtensionAPI,
    type ExtensionCommandContext,
    type SessionInfo,
} from "@earendil-works/pi-coding-agent";

const DAY_MS = 24 * 60 * 60 * 1000;
const TRASH_BATCH_SIZE = 100;
const UNLINK_BATCH_SIZE = 25;

interface CleanupPlan {
    readonly candidates: readonly SessionInfo[];
    readonly protectedNamedCount: number;
    readonly protectedActiveCount: number;
}

interface TrashResult {
    readonly movedCount: number;
    readonly remainingPaths: readonly string[];
}

interface TrashedSession {
    readonly filePath: string;
    readonly infoPath: string;
    readonly size: number;
}

function hasName(session: SessionInfo): boolean {
    return (session.name?.trim().length ?? 0) > 0;
}

function samePath(left: string, right: string | undefined): boolean {
    return right !== undefined && resolve(left) === resolve(right);
}

function buildCleanupPlan(
    sessions: readonly SessionInfo[],
    cutoff: Date,
    activeSessionPath: string | undefined,
): CleanupPlan {
    const candidates: SessionInfo[] = [];
    let protectedNamedCount = 0;
    let protectedActiveCount = 0;

    for (const session of sessions) {
        if (session.modified.getTime() >= cutoff.getTime()) continue;

        if (hasName(session)) {
            protectedNamedCount += 1;
            continue;
        }

        if (samePath(session.path, activeSessionPath)) {
            protectedActiveCount += 1;
            continue;
        }

        candidates.push(session);
    }

    return { candidates, protectedNamedCount, protectedActiveCount };
}

async function pathExists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

async function runTrashCommand(
    pi: ExtensionAPI,
    paths: readonly string[],
    command: string,
    prefixArguments: readonly string[],
): Promise<TrashResult> {
    let movedCount = 0;
    const remainingPaths: string[] = [];

    for (let start = 0; start < paths.length; start += TRASH_BATCH_SIZE) {
        const batch = paths.slice(start, start + TRASH_BATCH_SIZE);
        await pi.exec(command, [...prefixArguments, ...batch], {
            timeout: 60_000,
        });

        const existence = await Promise.all(batch.map(pathExists));
        for (let index = 0; index < batch.length; index += 1) {
            const path = batch[index];
            if (existence[index]) {
                remainingPaths.push(path);
            } else {
                movedCount += 1;
            }
        }
    }

    return { movedCount, remainingPaths };
}

async function moveToTrash(
    pi: ExtensionAPI,
    paths: readonly string[],
): Promise<TrashResult> {
    const trashCliResult = await runTrashCommand(pi, paths, "trash", []);
    if (trashCliResult.remainingPaths.length === 0) return trashCliResult;

    const gioResult = await runTrashCommand(
        pi,
        trashCliResult.remainingPaths,
        "gio",
        ["trash"],
    );
    return {
        movedCount: trashCliResult.movedCount + gioResult.movedCount,
        remainingPaths: gioResult.remainingPaths,
    };
}

async function permanentlyDelete(
    paths: readonly string[],
): Promise<{ readonly deletedCount: number; readonly failedCount: number }> {
    let deletedCount = 0;
    let failedCount = 0;

    for (let start = 0; start < paths.length; start += UNLINK_BATCH_SIZE) {
        const batch = paths.slice(start, start + UNLINK_BATCH_SIZE);
        const results = await Promise.allSettled(batch.map((path) => unlink(path)));
        for (const result of results) {
            if (result.status === "fulfilled") {
                deletedCount += 1;
            } else {
                failedCount += 1;
            }
        }
    }

    return { deletedCount, failedCount };
}

function isWithin(root: string, path: string): boolean {
    const pathFromRoot = relative(root, path);
    return (
        pathFromRoot.length > 0 &&
        pathFromRoot !== ".." &&
        !pathFromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
        !isAbsolute(pathFromRoot)
    );
}

function parseTrashedPath(contents: string): string | undefined {
    const encodedPath = contents.match(/^Path=(.*)$/m)?.[1];
    if (encodedPath === undefined) return undefined;

    try {
        return decodeURIComponent(encodedPath);
    } catch {
        return undefined;
    }
}

async function findTrashedSessions(): Promise<readonly TrashedSession[]> {
    const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
    const trashRoot = join(dataHome, "Trash");
    const trashInfoDirectory = join(trashRoot, "info");
    const trashFilesDirectory = join(trashRoot, "files");
    const agentDirectory =
        process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
    const sessionRoot = resolve(agentDirectory, "sessions");

    let infoNames: string[];
    try {
        infoNames = await readdir(trashInfoDirectory);
    } catch {
        return [];
    }

    const sessions: TrashedSession[] = [];
    for (const infoName of infoNames) {
        if (!infoName.endsWith(".trashinfo")) continue;

        const infoPath = join(trashInfoDirectory, infoName);
        try {
            const originalPath = parseTrashedPath(await readFile(infoPath, "utf8"));
            if (
                originalPath === undefined ||
                !originalPath.endsWith(".jsonl") ||
                !isWithin(sessionRoot, resolve(originalPath))
            ) {
                continue;
            }

            const trashName = infoName.slice(0, -".trashinfo".length);
            const filePath = join(trashFilesDirectory, trashName);
            const fileStat = await stat(filePath);
            if (!fileStat.isFile()) continue;

            sessions.push({ filePath, infoPath, size: fileStat.size });
        } catch {
            // Ignore malformed, stale, or concurrently removed trash entries.
        }
    }

    return sessions;
}

function formatSize(bytes: number): string {
    const units = ["B", "KB", "MB", "GB"] as const;
    let value = bytes;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex += 1;
    }
    return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

async function emptySessionTrash(ctx: ExtensionCommandContext): Promise<void> {
    const sessions = await findTrashedSessions();
    if (sessions.length === 0) return;

    const totalSize = sessions.reduce((sum, session) => sum + session.size, 0);
    const confirmed = await ctx.ui.confirm(
        `Permanently delete ${sessions.length} Pi session(s) from Trash?`,
        `Approximate size: ${formatSize(totalSize)}\nOnly Pi session files will be removed. This cannot be undone.`,
    );
    if (!confirmed) return;

    let deletedCount = 0;
    let failedCount = 0;
    for (let start = 0; start < sessions.length; start += UNLINK_BATCH_SIZE) {
        const batch = sessions.slice(start, start + UNLINK_BATCH_SIZE);
        const results = await Promise.all(
            batch.map(async (session) => {
                const result = await Promise.allSettled([
                    unlink(session.filePath),
                    unlink(session.infoPath),
                ]);
                return result.every((item) => item.status === "fulfilled");
            }),
        );
        for (const deleted of results) {
            if (deleted) deletedCount += 1;
            else failedCount += 1;
        }
    }

    if (failedCount > 0) {
        ctx.ui.notify(
            `Permanently deleted ${deletedCount} trashed Pi session(s); ${failedCount} failed`,
            "error",
        );
        return;
    }
    ctx.ui.notify(
        `Permanently deleted ${deletedCount} Pi session(s) from Trash`,
        "info",
    );
}

function parseDays(value: string): number | undefined {
    if (!/^\d+$/.test(value)) return undefined;
    const days = Number(value);
    return Number.isSafeInteger(days) && days > 0 ? days : undefined;
}

async function chooseDays(
    ctx: ExtensionCommandContext,
    argument: string,
): Promise<number | undefined> {
    if (argument.length > 0) {
        const days = parseDays(argument);
        if (days === undefined) {
            ctx.ui.notify("Usage: /clean-sessions [days]", "error");
        }
        return days;
    }

    const choice = await ctx.ui.select("Delete unnamed sessions older than:", [
        "30 days",
        "90 days",
        "180 days",
        "365 days",
        "Custom…",
    ]);
    if (choice === undefined) return undefined;
    if (choice !== "Custom…") return parseDays(choice.split(" ")[0] ?? "");

    const custom = await ctx.ui.input("Age in days:", "90");
    if (custom === undefined) return undefined;

    const days = parseDays(custom.trim());
    if (days === undefined) {
        ctx.ui.notify("Enter a positive whole number of days", "error");
    }
    return days;
}

function formatDate(date: Date): string {
    return date.toISOString().slice(0, 10);
}

/** Registers an interactive command for safely removing old, unnamed Pi sessions. */
export default function cleanSessionsExtension(pi: ExtensionAPI): void {
    pi.registerCommand("clean-sessions", {
        description:
            "Bulk-remove old sessions while protecting named and active sessions",
        handler: async (args, ctx) => {
            if (!ctx.hasUI) {
                ctx.ui.notify("/clean-sessions requires an interactive UI", "error");
                return;
            }

            const days = await chooseDays(ctx, args.trim());
            if (days === undefined) return;

            const scope = await ctx.ui.select("Clean sessions from:", [
                "Current folder",
                "All folders",
            ]);
            if (scope === undefined) return;

            ctx.ui.notify("Loading session history…", "info");
            const sessions =
                scope === "Current folder"
                    ? await SessionManager.list(
                          ctx.cwd,
                          ctx.sessionManager.getSessionDir(),
                      )
                    : await SessionManager.listAll();

            const cutoff = new Date(Date.now() - days * DAY_MS);
            const plan = buildCleanupPlan(
                sessions,
                cutoff,
                ctx.sessionManager.getSessionFile(),
            );

            if (plan.candidates.length === 0) {
                ctx.ui.notify(
                    `Nothing to clean. Protected ${plan.protectedNamedCount} named session(s).`,
                    "info",
                );
                await emptySessionTrash(ctx);
                return;
            }

            const oldest = plan.candidates.reduce((earliest, session) =>
                session.modified < earliest ? session.modified : earliest,
            plan.candidates[0].modified);
            const confirmed = await ctx.ui.confirm(
                `Trash ${plan.candidates.length} old session(s)?`,
                [
                    `Scope: ${scope}`,
                    `Last modified before: ${formatDate(cutoff)}`,
                    `Oldest match: ${formatDate(oldest)}`,
                    `Protected named sessions: ${plan.protectedNamedCount}`,
                    "The active session is always protected.",
                ].join("\n"),
            );
            if (!confirmed) return;

            ctx.ui.notify("Moving sessions to trash…", "info");
            const trashResult = await moveToTrash(
                pi,
                plan.candidates.map((session) => session.path),
            );

            if (trashResult.remainingPaths.length === 0) {
                ctx.ui.notify(
                    `Moved ${trashResult.movedCount} session(s) to trash`,
                    "info",
                );
            } else {
                const permanentlyDeleteConfirmed = await ctx.ui.confirm(
                    "Trash was unavailable or failed",
                    `${trashResult.remainingPaths.length} session(s) remain. Permanently delete them instead? This cannot be undone.`,
                );
                if (!permanentlyDeleteConfirmed) {
                    ctx.ui.notify(
                        `Moved ${trashResult.movedCount} session(s) to trash; kept ${trashResult.remainingPaths.length}`,
                        "warning",
                    );
                } else {
                    const deletion = await permanentlyDelete(
                        trashResult.remainingPaths,
                    );
                    const removedCount =
                        trashResult.movedCount + deletion.deletedCount;
                    if (deletion.failedCount > 0) {
                        ctx.ui.notify(
                            `Removed ${removedCount} session(s); failed to remove ${deletion.failedCount}`,
                            "error",
                        );
                    } else {
                        ctx.ui.notify(`Removed ${removedCount} session(s)`, "info");
                    }
                }
            }

            await emptySessionTrash(ctx);
        },
    });
}
