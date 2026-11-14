import type { CodingAgent } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { Kysely } from "kysely";
import { AgentCallError, agentClientFor } from "../agent-client.js";
import { launcherFields } from "./launcher-env.js";
import type { WorkspaceRow } from "./workspace-view.js";

/**
 * Swap the coding agent of an open chat tab (SPEC.md §10.8): the agent
 * replaces the chat's host with the other agent's, which is handed the
 * conversation and only its own institutional key (§10.6). Null when it
 * worked; else why not.
 */
export async function switchChatAgent(
	db: Kysely<Database>,
	config: { AGENT_PORT: number },
	workspace: WorkspaceRow,
	terminalId: string,
	to: CodingAgent,
): Promise<{
	status: 404 | 409 | 503;
	code: "TERMINAL_NOT_FOUND" | "BUSY" | "AGENT_UNAVAILABLE";
	message: string;
} | null> {
	const row = await db
		.selectFrom("terminals")
		.select(["kind", "agent"])
		.where("id", "=", terminalId)
		.where("workspace_id", "=", workspace.id)
		.where("ended_at", "is", null)
		.executeTakeFirst();
	if (row?.kind !== "chat") {
		return { status: 404, code: "TERMINAL_NOT_FOUND", message: "Terminal not found" };
	}
	if (row.agent === to) return null;
	const agent = agentClientFor(workspace, config.AGENT_PORT);
	if (workspace.state !== "running" || !agent) {
		return {
			status: 409,
			code: "AGENT_UNAVAILABLE",
			message: "The workspace is not running yet. Start it and try again.",
		};
	}
	try {
		await agent.switchChatAgent(terminalId, {
			agent: to,
			...launcherFields(to),
		});
		return null;
	} catch (error) {
		if (error instanceof AgentCallError && error.code === "CHAT_BUSY") {
			return {
				status: 409,
				code: "BUSY",
				message: "Wait for the reply to finish before switching agents.",
			};
		}
		if (error instanceof AgentCallError && error.code === "TERMINAL_NOT_FOUND") {
			return {
				status: 404,
				code: "TERMINAL_NOT_FOUND",
				message: "Terminal not found",
			};
		}
		return {
			status: 503,
			code: "AGENT_UNAVAILABLE",
			message: "The workspace agent could not switch the chat's agent.",
		};
	}
}
