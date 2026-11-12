import type { AgentCodingAgentStatus, CodingAgentTerminal } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { Kysely } from "kysely";

/**
 * Add each terminal's project to what the workspace agent reported. The agent
 * runs in the student's container, so a terminal id the database does not
 * hold for this workspace, or one outside any project, is dropped. One query
 * per call.
 *
 * A terminal question goes only to the workspace's owner and only for a
 * terminal tab; it is dropped for anyone else and for a chat (SPEC.md 10.8,
 * 24.1). Callers already send the list to the owner alone; this is the
 * second guard.
 */
export async function withProjects(
	db: Kysely<Database>,
	workspaceId: string,
	states: AgentCodingAgentStatus[],
	viewerIsOwner: boolean,
): Promise<CodingAgentTerminal[]> {
	if (states.length === 0) return [];
	const rows = await db
		.selectFrom("terminals")
		.select(["id", "project_id", "name", "kind"])
		.where("workspace_id", "=", workspaceId)
		.where(
			"id",
			"in",
			states.map((state) => state.terminalId),
		)
		.execute();
	const found = new Map(rows.map((row) => [row.id, row]));
	const joined: CodingAgentTerminal[] = [];
	for (const state of states) {
		const row = found.get(state.terminalId);
		if (row?.project_id) {
			const kind = row.kind === "chat" ? "chat" : "terminal";
			const { question, ...rest } = state;
			joined.push({
				...rest,
				...(question && viewerIsOwner && kind === "terminal" ? { question } : {}),
				projectId: row.project_id,
				name: row.name,
				kind,
			});
		}
	}
	return joined;
}
