import type { ApiConfig } from "@portikus/config";
import type { RecoveryReason } from "@portikus/contracts";
import {
	type Database,
	type RecoveryPointRow,
	recordRecoveryPoint,
} from "@portikus/db";
import type { Kysely } from "kysely";
import { AgentCallError, type AgentClient } from "../agent-client.js";
import type { ProjectRow } from "./project-scope.js";

/**
 * Ask the agent to archive a project and record the point (SPEC.md §15.2,
 * ADR 0020). Throws the agent's failure so each caller decides whether it
 * is fatal. Only ids and the reason are logged, never a path (SPEC.md §24.8).
 */
export async function makeRecoveryPoint(
	db: Kysely<Database>,
	config: ApiConfig,
	agent: AgentClient,
	input: {
		workspaceId: string;
		project: Pick<ProjectRow, "id" | "slug">;
		reason: RecoveryReason;
		createdBy: string;
		timeoutMs?: number;
	},
): Promise<RecoveryPointRow> {
	const row = await recordRecoveryPoint(db, {
		projectId: input.project.id,
		workspaceId: input.workspaceId,
		reason: input.reason,
		createdBy: input.createdBy,
		retentionDays: config.RECOVERY_RETENTION_DAYS,
		archive: (pointId) =>
			agent.createRecoveryPoint(
				input.project.slug,
				{ projectId: input.project.id, pointId },
				input.timeoutMs,
			),
	});
	// No skip fingerprint was sent, so a skip is the agent misbehaving.
	if (!row) {
		throw new AgentCallError("AGENT_UNAVAILABLE", "The agent did not make the point.");
	}
	return row;
}
