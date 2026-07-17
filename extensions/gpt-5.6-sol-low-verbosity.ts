import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Set OpenAI Responses API output verbosity to low for GPT-5.6 Sol. */
export default function (pi: ExtensionAPI) {
	pi.on("before_provider_request", (event, ctx) => {
		if (
			ctx.model?.provider !== "openai" ||
			ctx.model.id !== "gpt-5.6-sol" ||
			ctx.model.api !== "openai-responses"
		) {
			return;
		}

		const payload = event.payload as Record<string, unknown>;
		const text =
			typeof payload.text === "object" && payload.text !== null
				? (payload.text as Record<string, unknown>)
				: {};

		return {
			...payload,
			text: {
				...text,
				verbosity: "low",
			},
		};
	});
}
