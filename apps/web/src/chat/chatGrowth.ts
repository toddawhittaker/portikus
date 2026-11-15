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
	/** Context size once the first message, the agent's warm-up, finished; null until it has. */
	usedAfterFirstMessage: number | null;
	/** Context reports the first message took. */
	firstMessageEvents: number;
}

export const NO_GROWTH: ChatGrowth = {
	firstUsedTokens: null,
	messagesSent: 0,
	contextEvents: 0,
	usedAfterFirstMessage: null,
	firstMessageEvents: 0,
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

/** A turn finished with `usedTokens` in use; the first message's end is kept as its warm-up. */
export function turnFinished(growth: ChatGrowth, usedTokens: number): ChatGrowth {
	if (growth.messagesSent !== 1 || growth.usedAfterFirstMessage !== null) return growth;
	if (usedTokens <= 0) return growth;
	return {
		...growth,
		usedAfterFirstMessage: usedTokens,
		firstMessageEvents: growth.contextEvents,
	};
}

type HostGrowth = NonNullable<Extract<ChatServerEvent, { type: "context" }>["growth"]>;

/** The host's own counts, which outlive a reload; the browser counts only when a host sends none. */
export function fromHost(growth: HostGrowth): ChatGrowth {
	return {
		firstUsedTokens: growth.startTokens > 0 ? growth.startTokens : null,
		messagesSent: growth.messages,
		contextEvents: growth.requests,
		usedAfterFirstMessage:
			growth.firstMessageTokens && growth.firstMessageTokens > 0
				? growth.firstMessageTokens
				: null,
		firstMessageEvents: growth.firstMessageRequests ?? 0,
	};
}
