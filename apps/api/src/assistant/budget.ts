import type { Database } from "@portikus/db";
import type { Kysely } from "kysely";
import type { ReadyAiSettings } from "../ai/settings.js";
import { recordUsage, type StepUsage, usedThisMonth } from "../ai/usage.js";
import { addTokens, tokensUsed } from "./store.js";

/**
 * The assistant's limits (SPEC.md section 20.4), counted in code from each
 * reply's usage: steps per message, the conversation's token budget and the
 * site's monthly cap.
 */

/** Model steps one person's message may lead to, approvals included. */
export const MAX_STEPS_PER_MESSAGE = 12;

export type SpentLimit = "monthly-cap" | "conversation";

export const LIMIT_TEXT: Record<SpentLimit | "steps", string> = {
	"monthly-cap":
		"I have to stop here: the site has used this month's token allowance for the assistant. It works again next month, or an administrator can raise the allowance.",
	conversation:
		"I have to stop here: this conversation has used its token budget. Start a new conversation to go on.",
	steps: `I stopped after ${MAX_STEPS_PER_MESSAGE} steps for one message. Tell me if you want me to go on.`,
};

/** Which limit is spent, if any, before the next step. */
export async function spentLimit(
	db: Kysely<Database>,
	conversationId: string,
	settings: Pick<ReadyAiSettings, "monthlyTokenCap" | "conversationTokenBudget">,
): Promise<SpentLimit | null> {
	if ((await usedThisMonth(db)) >= settings.monthlyTokenCap) return "monthly-cap";
	if ((await tokensUsed(db, conversationId)) >= settings.conversationTokenBudget) {
		return "conversation";
	}
	return null;
}

/** Count one step's tokens on the conversation and in the site's daily usage. */
export async function chargeStep(
	db: Kysely<Database>,
	step: { conversationId: string; userId: string; model: string; usage: StepUsage },
): Promise<void> {
	await addTokens(db, step.conversationId, step.usage.input + step.usage.output);
	await recordUsage(db, {
		userId: step.userId,
		purpose: "assistant",
		model: step.model,
		usage: step.usage,
	});
}
