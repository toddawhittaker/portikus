import { type ChatMcpStatus, MAX_CHAT_MCP_SERVERS } from "@portikus/contracts";
import type { ChatSink } from "../agent.js";
import type { AppServerClient as Client } from "./app-server.js";
import { McpStartupNotification, McpStatusList, parsed } from "./protocol.js";

/** Codex's own connector server for ChatGPT apps; not one of the student's servers. */
const CODEX_APPS_SERVER = "codex_apps";

/** A thread's runtime status as the chat's MCP list words it. */
function mcpStatus(
	runtime: string | null | undefined,
	auth?: string | null,
): ChatMcpStatus {
	switch (runtime) {
		case "connected":
		case "ready":
			return "connected";
		case "failed":
		case "cancelled":
			return "failed";
		case "authenticationRequired":
			return "needsAuth";
		case "disabled":
			return "disabled";
		default:
			return auth === "notLoggedIn" ? "needsAuth" : "starting";
	}
}

/** The student's MCP servers: names and status only (ADR 0012). */
export class CodexMcp {
	private readonly servers = new Map<string, ChatMcpStatus>();

	constructor(
		private readonly sink: () => ChatSink,
		private readonly threadId: () => string | null,
	) {}

	/** Read every server's status, a few pages at most. */
	async read(client: Client): Promise<void> {
		const seen = new Map<string, ChatMcpStatus>();
		let cursor: string | null | undefined;
		try {
			for (let page = 0; page < 5; page += 1) {
				const list = parsed(
					McpStatusList,
					await client.request("mcpServerStatus/list", {
						detail: "toolsAndAuthOnly",
						threadId: this.threadId(),
						limit: MAX_CHAT_MCP_SERVERS,
						...(cursor ? { cursor } : {}),
					}),
				);
				if (!list) break;
				for (const server of list.data) {
					if (server.name !== CODEX_APPS_SERVER) {
						seen.set(server.name, mcpStatus(server.runtimeStatus, server.authStatus));
					}
				}
				cursor = list.nextCursor;
				if (!cursor) break;
			}
		} catch {
			return;
		}
		this.servers.clear();
		for (const [name, status] of seen) this.servers.set(name, status);
		this.publish();
	}

	/** A server's startup status changed. */
	changed(params: unknown): void {
		const update = parsed(McpStartupNotification, params);
		if (!update || update.name === CODEX_APPS_SERVER) return;
		if (update.threadId && update.threadId !== this.threadId()) return;
		const status = mcpStatus(update.status);
		if (this.servers.get(update.name) === status) return;
		this.servers.set(update.name, status);
		this.publish();
	}

	private publish(): void {
		const servers = [...this.servers]
			.filter(([name]) => name.length >= 1 && name.length <= 64)
			.slice(0, MAX_CHAT_MCP_SERVERS)
			.map(([name, status]) => ({ name, status }));
		this.sink().mcp(servers);
	}
}
