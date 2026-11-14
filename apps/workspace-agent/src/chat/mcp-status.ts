import type { McpServerStatus } from "@anthropic-ai/claude-agent-sdk";
import {
	ChatMcpServer,
	type ChatMcpStatus,
	MAX_CHAT_MCP_SERVERS,
} from "@portikus/contracts";

/**
 * What the chat says when an MCP server asks the student for input. The
 * chat has no form for it, so the request is declined (SPEC.md §10.8).
 */
export const ELICITATION_NOTICE =
	"An MCP server asked for input. Use a terminal tab to answer it.";

/** The SDK's word for how a server stands, as the chat names it. */
const STATUS: Record<McpServerStatus["status"], ChatMcpStatus> = {
	connected: "connected",
	pending: "starting",
	failed: "failed",
	"needs-auth": "needsAuth",
	disabled: "disabled",
};

/**
 * The chat's list from the SDK's MCP server status: each server's name and
 * how it stands, and nothing else. A URL, tool list or error text never
 * leaves this function (ADR 0012). A row the contract would refuse, or one
 * with a status this host does not know, is left out.
 */
export function chatMcpServers(rows: readonly McpServerStatus[]): ChatMcpServer[] {
	const servers: ChatMcpServer[] = [];
	for (const row of rows) {
		const status = STATUS[row.status];
		const server = ChatMcpServer.safeParse({ name: row.name, status });
		if (server.success) servers.push(server.data);
		if (servers.length === MAX_CHAT_MCP_SERVERS) break;
	}
	return servers;
}

/**
 * Read the session's MCP servers and tell `onChange` the list. A failed
 * read tells nothing, so the chat keeps its last list. Returns whether the
 * list was read and the session is still the current one.
 */
export async function refreshMcp(
	read: () => Promise<McpServerStatus[]>,
	stillCurrent: () => boolean,
	onChange: (servers: ChatMcpServer[]) => void,
): Promise<boolean> {
	try {
		const servers = chatMcpServers(await read());
		if (!stillCurrent()) return false;
		onChange(servers);
		return true;
	} catch {
		return false;
	}
}
