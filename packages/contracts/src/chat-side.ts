import { z } from "zod";

/**
 * Side conversations in a chat tab (SPEC.md §10.2, ADR 0083): a question
 * asked beside the main conversation, answered from what the agent already
 * knows, without disturbing the main turn. The browser sends these three
 * messages; the host answers with `side` frames, which `chat.ts` defines
 * beside the `subagent` frame because they reuse its event schema.
 */

/** Longest side question, in characters. */
export const MAX_CHAT_SIDE_TEXT_CHARS = 4000;

/** Ask a side question. The text must hold something besides spaces. */
export const SideAskMessage = z
	.object({
		type: z.literal("side.ask"),
		text: z
			.string()
			.max(MAX_CHAT_SIDE_TEXT_CHARS)
			.refine((text) => text.trim() !== "", { message: "Ask something" }),
	})
	.strict();

/** Stop the side question that is running; the conversation stays. */
export const SideStopMessage = z.object({ type: z.literal("side.stop") }).strict();

/** Close the side conversation and forget it. */
export const SideEndMessage = z.object({ type: z.literal("side.end") }).strict();

/** An earlier side question and its answer, which a driver is handed with the next one. */
export const SideExchange = z.object({
	question: z.string(),
	answer: z.string(),
});
export type SideExchange = z.infer<typeof SideExchange>;
