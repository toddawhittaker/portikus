import {
	getSessionInfo,
	getSessionMessages,
	getSubagentMessages,
	listSubagents,
	type Query,
	query,
	renameSession,
	type SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";

/** The SDK calls the host makes, so tests can stand in for them. */
export interface ChatSdk {
	query: typeof query;
	sessionExists: (id: string, dir: string) => Promise<boolean>;
	sessionMessages: (id: string, dir: string) => Promise<SessionMessage[]>;
	/** The session's title: the student's own, else Claude Code's summary. */
	sessionTitle: (id: string, dir: string) => Promise<string | null>;
	renameSession: (id: string, title: string, dir: string) => Promise<void>;
	/** The ids of the subagents whose transcripts the session keeps. */
	subagentIds: (id: string, dir: string) => Promise<string[]>;
	subagentMessages: (
		id: string,
		agentId: string,
		dir: string,
		limit?: number,
	) => Promise<SessionMessage[]>;
}

export const realSdk: ChatSdk = {
	query,
	sessionExists: async (id, dir) => (await getSessionInfo(id, { dir })) !== undefined,
	sessionMessages: (id, dir) => getSessionMessages(id, { dir }),
	sessionTitle: async (id, dir) => {
		const info = await getSessionInfo(id, { dir });
		return info?.customTitle || info?.summary || null;
	},
	renameSession: (id, title, dir) => renameSession(id, title, { dir }),
	subagentIds: (id, dir) => listSubagents(id, { dir }),
	subagentMessages: (id, agentId, dir, limit) =>
		getSubagentMessages(id, agentId, limit === undefined ? { dir } : { dir, limit }),
};

/** A side question's answer, as Claude Code gives it. */
interface SideAnswer {
	response: string;
	/** Claude Code made the answer itself rather than asking the model. */
	synthetic: boolean;
}

/**
 * Asks Claude a side question about the session as it stands, without
 * adding to its transcript, or null when the answer was cut off.
 */
export type SideQuestion = (
	question: string,
	options: { history: { question: string; response: string }[]; signal: AbortSignal },
) => Promise<SideAnswer | null>;

/**
 * The SDK's `Query.askSideQuestion`, which Claude Code's own /btw uses but
 * the SDK does not declare (ADR 0083). Null when this SDK has no such
 * method, so the chat offers no /btw. claude-real.test.ts pins its shape.
 */
export function sideQuestionOf(session: Query): SideQuestion | null {
	const ask = (session as unknown as { askSideQuestion?: unknown }).askSideQuestion;
	if (typeof ask !== "function") return null;
	return async (question, options) => {
		const answer: unknown = await ask.call(session, question, options);
		if (answer === null || answer === undefined) return null;
		const { response, synthetic } = answer as {
			response?: unknown;
			synthetic?: unknown;
		};
		if (typeof response !== "string")
			throw new Error("Claude Code gave no side answer.");
		return { response, synthetic: synthetic === true };
	};
}
