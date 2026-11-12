import {
	getSessionInfo,
	getSessionMessages,
	getSubagentMessages,
	listSubagents,
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
