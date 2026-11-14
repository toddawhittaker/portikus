import type { ChatServerEvent } from "@portikus/contracts";

/**
 * How a chat's conversation has grown since it started or was last reset,
 * the observations the fresh-chat hint estimates from (SPEC.md §10.8).
 */

export interface ChatGrowth {
	/** The first nonzero used-token figure of the conversation; null until one arrives. */
	firstUsedTokens: number | null;
	/** Messages the student has sent. */
	messagesSent: number;
	/** Context reports with tokens in use; each is one request to the model. */
	contextEvents: number;
}

export const NO_GROWTH: ChatGrowth = {
	firstUsedTokens: null,
	messagesSent: 0,
	contextEvents: 0,
};

/** A context report arrived. */
export function grownBy(growth: ChatGrowth, usedTokens: number): ChatGrowth {
	if (usedTokens <= 0) return growth;
	return {
		...growth,
		firstUsedTokens: growth.firstUsedTokens ?? usedTokens,
		contextEvents: growth.contextEvents + 1,
	};
}

/** The student sent a message. */
export function sentOne(growth: ChatGrowth): ChatGrowth {
	return { ...growth, messagesSent: growth.messagesSent + 1 };
}

type HostGrowth = NonNullable<Extract<ChatServerEvent, { type: "context" }>["growth"]>;

/** The host's own counts, which outlive a reload; the browser counts only when a host sends none. */
export function fromHost(growth: HostGrowth): ChatGrowth {
	return {
		firstUsedTokens: growth.startTokens > 0 ? growth.startTokens : null,
		messagesSent: growth.messages,
		contextEvents: growth.requests,
	};
}
