import { complete } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";

async function callModel(
	pi: ExtensionAPI,
	ctx: ExtensionCommandContext,
	prompt: string,
): Promise<string | undefined> {
	const model = ctx.model;
	if (!model) {
		if (ctx.hasUI) ctx.ui.notify("No model selected", "error");
		else console.error("No model selected");
		return undefined;
	}

	const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
	if (!auth?.ok || !auth.apiKey) {
		const msg = auth?.error ?? "No API key available for current model";
		if (ctx.hasUI) ctx.ui.notify(msg, "error");
		else console.error(msg);
		return undefined;
	}

	const messages = [
		{
			role: "user" as const,
			content: [{ type: "text" as const, text: prompt }],
			timestamp: Date.now(),
		},
	];

	const response = await complete(
		model,
		{ messages },
		{
			apiKey: auth.apiKey,
			headers: auth.headers,
		},
	);

	return response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map((c) => c.text)
		.join("\n")
		.trim();
}

function isGitRepo(pi: ExtensionAPI, cwd: string): Promise<boolean> {
	return pi
		.exec("git", ["rev-parse", "--git-dir"], { cwd })
		.then((r) => r.code === 0);
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("cmt", {
		description: "Generate a commit message from staged changes and commit",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const opts = ["-a", "--stage-all"];
			const filtered = opts.filter((o) => o.startsWith(prefix));
			return filtered.length > 0
				? filtered.map((o) => ({ value: o, label: o }))
				: null;
		},
		handler: async (args, ctx) => {
			await ctx.waitForIdle();

			if (!(await isGitRepo(pi, ctx.cwd))) {
				if (ctx.hasUI) ctx.ui.notify("Not a git repository", "error");
				else console.error("Not a git repository");
				return;
			}

			const stageAll = args.trim() === "--stage-all" || args.trim() === "-a";

			if (stageAll) {
				const { code, stderr } = await pi.exec("git", ["add", "-A"], {
					cwd: ctx.cwd,
				});
				if (code !== 0) {
					const msg = `Failed to stage changes: ${stderr.trim()}`;
					if (ctx.hasUI) ctx.ui.notify(msg, "error");
					else console.error(msg);
					return;
				}
			}

			const diff = await pi.exec("git", ["diff", "--cached"], {
				cwd: ctx.cwd,
			});
			if (diff.stdout.trim().length === 0) {
				const msg = stageAll
					? "No changes to commit"
					: "No staged changes. Stage some changes first, or use /cmt -a";
				if (ctx.hasUI) ctx.ui.notify(msg, "warning");
				else console.log(msg);
				return;
			}

			const prompt = [
				"Generate a concise git commit message for the following staged changes.",
				"Use conventional commits format (type: description) when appropriate.",
				"Be specific but brief. Body is optional — only add it if needed for context.",
				"",
				"```diff",
				diff.stdout,
				"```",
			].join("\n");

			const message = await callModel(pi, ctx, prompt);
			if (!message) return;

			if (ctx.hasUI) {
				const ok = await ctx.ui.confirm("Commit with this message?", message);
				if (!ok) {
					ctx.ui.notify("Commit cancelled", "info");
					return;
				}
			} else {
				console.log(`Commit message:\n${message}`);
			}

			const { code, stderr } = await pi.exec(
				"git",
				["commit", "-m", message],
				{ cwd: ctx.cwd },
			);

			if (code === 0) {
				const firstLine = message.split("\n")[0] ?? message;
				if (ctx.hasUI) ctx.ui.notify(`Committed: ${firstLine}`, "success");
				else console.log(`Committed: ${firstLine}`);
			} else {
				const msg = `Commit failed: ${stderr.trim()}`;
				if (ctx.hasUI) ctx.ui.notify(msg, "error");
				else console.error(msg);
			}
		},
	});
}
