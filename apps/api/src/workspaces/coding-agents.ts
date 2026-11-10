import type { AgentCodingAgentStatus, CodingAgentTerminal } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { Kysely } from "kysely";

/**
 * Add each terminal's project to what the workspace agent reported. The agent
 * runs in the student's container, so a terminal id the database does not
 * hold for this workspace, or one outside any project, is dropped. One query
 * per call.
 */
export async function withProjects(
	db: Kysely<Database>,
	workspaceId: string,
	states: AgentCodingAgentStatus[],
): Promise<CodingAgentTerminal[]> {
	if (states.length === 0) return [];
	const rows = await db
		.selectFrom("terminals")
		.select(["id", "project_id", "name"])
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
		if (row?.project_id)
			joined.push({ ...state, projectId: row.project_id, name: row.name });
	}
	return joined;
}
