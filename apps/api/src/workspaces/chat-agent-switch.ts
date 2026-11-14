import type { CodingAgent } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { Kysely } from "kysely";
import { AgentCallError, type AgentClient, agentClientFor } from "../agent-client.js";
import { launcherFields } from "./launcher-env.js";
import type { WorkspaceRow } from "./workspace-view.js";

/**
 * Swap the coding agent of an open chat tab (SPEC.md §10.8): the agent
 * replaces the chat's host with the other agent's, which is handed the
 * conversation and only its own institutional key (§10.6). The row is
 * claimed first, so of two swaps at once only one reaches the chat, and
 * given back if the swap fails. `beforeSwitch` runs once the claim holds
 * and before the new agent starts. Null when it worked; else why not.
 */
export async function switchChatAgent(
	db: Kysely<Database>,
	config: { AGENT_PORT: number },
	workspace: WorkspaceRow,
	terminalId: string,
	to: CodingAgent,
	beforeSwitch: (agent: AgentClient, projectId: string | null) => Promise<unknown>,
): Promise<{
	status: 404 | 409 | 503;
	code: "TERMINAL_NOT_FOUND" | "BUSY" | "AGENT_UNAVAILABLE";
	message: string;
} | null> {
	const row = await db
		.selectFrom("terminals")
		.select(["kind", "agent", "project_id"])
		.where("id", "=", terminalId)
		.where("workspace_id", "=", workspace.id)
		.where("ended_at", "is", null)
		.executeTakeFirst();
	if (row?.kind !== "chat" || row.agent === null) {
		return { status: 404, code: "TERMINAL_NOT_FOUND", message: "Terminal not found" };
	}
	const from = row.agent as CodingAgent;
	if (from === to) return null;
	const agent = agentClientFor(workspace, config.AGENT_PORT);
	if (workspace.state !== "running" || !agent) {
		return {
			status: 409,
			code: "AGENT_UNAVAILABLE",
			message: "The workspace is not running yet. Start it and try again.",
		};
	}
	const claimed = await setAgent(db, terminalId, from, to);
	if (!claimed) {
		return {
			status: 409,
			code: "BUSY",
			message: "The chat is already switching agents.",
		};
	}
	await beforeSwitch(agent, row.project_id);
	// Only to start the running agent again if the new one cannot start.
	const previous = launcherFields(from).institutionalEnv;
	try {
		await agent.switchChatAgent(terminalId, {
			agent: to,
			...launcherFields(to),
			...(previous ? { previousInstitutionalEnv: previous } : {}),
		});
		return null;
	} catch (error) {
		const code = error instanceof AgentCallError ? error.code : null;
		// The host already runs that agent, so the claimed row is right.
		if (code === "CHAT_SAME_AGENT") return null;
		await setAgent(db, terminalId, to, from);
		if (code === "CHAT_BUSY") {
			return {
				status: 409,
				code: "BUSY",
				message: "Wait for the reply to finish before switching agents.",
			};
		}
		if (code === "TERMINAL_NOT_FOUND") {
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

/** Change the row's agent only if it is still `from`; false when it was not. */
async function setAgent(
	db: Kysely<Database>,
	terminalId: string,
	from: CodingAgent,
	to: CodingAgent,
): Promise<boolean> {
	const result = await db
		.updateTable("terminals")
		.set({ agent: to })
		.where("id", "=", terminalId)
		.where("agent", "=", from)
		.executeTakeFirst();
	return result.numUpdatedRows > 0n;
}
