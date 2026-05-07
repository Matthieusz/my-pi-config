import { complete } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";

const MAX_DIFF_CHARS = 50000;

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
	pi.registerCommand("pr", {
		description: "Generate a PR title and description for the current branch",
		getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
			const branches = ["main", "master", "develop"];
			const filtered = branches.filter((b) => b.startsWith(prefix));
			return filtered.length > 0
				? filtered.map((b) => ({ value: b, label: b }))
				: null;
		},
		handler: async (args, ctx) => {
			await ctx.waitForIdle();

			if (!(await isGitRepo(pi, ctx.cwd))) {
				if (ctx.hasUI) ctx.ui.notify("Not a git repository", "error");
				else console.error("Not a git repository");
				return;
			}

			let baseBranch = args.trim();
			if (!baseBranch) {
				const mainCheck = await pi.exec("git", ["rev-parse", "--verify", "main"], {
					cwd: ctx.cwd,
				});
				baseBranch = mainCheck.code === 0 ? "main" : "master";
				const fallbackCheck = await pi.exec(
					"git",
					["rev-parse", "--verify", baseBranch],
					{ cwd: ctx.cwd },
				);
				if (fallbackCheck.code !== 0) {
					const msg =
						"Could not detect base branch (tried 'main' and 'master'). Use /pr <base-branch>";
					if (ctx.hasUI) ctx.ui.notify(msg, "error");
					else console.error(msg);
					return;
				}
			} else {
				const branchCheck = await pi.exec(
					"git",
					["rev-parse", "--verify", baseBranch],
					{ cwd: ctx.cwd },
				);
				if (branchCheck.code !== 0) {
					const msg = `Base branch '${baseBranch}' not found`;
					if (ctx.hasUI) ctx.ui.notify(msg, "error");
					else console.error(msg);
					return;
				}
			}

			const currentBranch = await pi.exec("git", ["branch", "--show-current"], {
				cwd: ctx.cwd,
			});
			if (currentBranch.stdout.trim() === baseBranch) {
				const msg = `Currently on ${baseBranch}. Switch to a feature branch first.`;
				if (ctx.hasUI) ctx.ui.notify(msg, "warning");
				else console.log(msg);
				return;
			}

			const log = await pi.exec(
				"git",
				["log", `${baseBranch}..HEAD`, "--oneline", "--no-merges"],
				{ cwd: ctx.cwd },
			);
			const diffResult = await pi.exec(
				"git",
				["diff", `${baseBranch}...HEAD`],
				{ cwd: ctx.cwd },
			);

			if (log.stdout.trim().length === 0) {
				const msg = `No commits found on current branch compared to ${baseBranch}`;
				if (ctx.hasUI) ctx.ui.notify(msg, "info");
				else console.log(msg);
				return;
			}

			let diff = diffResult.stdout;
			const truncated = diff.length > MAX_DIFF_CHARS;
			if (truncated) {
				diff = diff.slice(0, MAX_DIFF_CHARS) + "\n\n... (diff truncated)";
			}

			const prompt = [
				`Generate a pull request title and description for the current branch compared to ${baseBranch}.`,
				"Format the response as:",
				"",
				"## Title",
				"<concise, descriptive PR title>",
				"",
				"## Description",
				"<summary of changes, motivation, and any breaking changes or notes for reviewers>",
				"",
				"Commits on this branch:",
				"```",
				log.stdout,
				"```",
				"",
				"Changes:",
				"```diff",
				diff,
				"```",
			].join("\n");

			const description = await callModel(pi, ctx, prompt);
			if (!description) return;

			if (ctx.hasUI) {
				ctx.ui.notify(description, "info");
			} else {
				console.log(description);
			}
		},
	});
}
