import {
	getSessionInfo,
	getSessionMessages,
	query,
	type SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";

/** The three SDK calls the host makes, so tests can stand in for them. */
export interface ChatSdk {
	query: typeof query;
	sessionExists: (id: string, dir: string) => Promise<boolean>;
	sessionMessages: (id: string, dir: string) => Promise<SessionMessage[]>;
}

export const realSdk: ChatSdk = {
	query,
	sessionExists: async (id, dir) => (await getSessionInfo(id, { dir })) !== undefined,
	sessionMessages: (id, dir) => getSessionMessages(id, { dir }),
};
