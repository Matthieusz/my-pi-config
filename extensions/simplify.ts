import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("simplify", {
		description: "Ask the agent to simplify/refactor code",
		handler: async (args, ctx) => {
			await ctx.waitForIdle();

			const filePath = args.trim();
			if (filePath) {
				pi.sendUserMessage(
					`Simplify and refactor the code in \`${filePath}\`. ` +
						`Make it more concise, readable, and maintainable while preserving all existing behavior. ` +
						`Avoid changing public APIs unless necessary for clarity. Apply the changes directly.`,
				);
			} else {
				pi.sendUserMessage(
					`Please review and simplify the most recently discussed code or the last code you wrote. ` +
						`Focus on conciseness, readability, and removing redundancy while preserving behavior. ` +
						`Apply the changes directly.`,
				);
			}
		},
	});
}
