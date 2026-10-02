import type { ApiConfig } from "@portikus/config";
import type { RecoveryReason } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import { type Kysely, type Selectable, sql } from "kysely";
import { AgentCallError, type AgentClient } from "../agent-client.js";
import type { ProjectRow } from "./project-scope.js";

export type RecoveryPointRow = Selectable<Database["recovery_points"]>;

const DAY_MS = 24 * 60 * 60 * 1000;
/** At most this many points per project. */
export const MAX_POINTS_PER_PROJECT = 200;

/** How many recovery points one project holds now. */
export async function countProjectPoints(
	db: Kysely<Database>,
	projectId: string,
): Promise<number> {
	const row = await db
		.selectFrom("recovery_points")
		.select(sql<string>`count(*)::text`.as("n"))
		.where("project_id", "=", projectId)
		.executeTakeFirstOrThrow();
	return Number(row.n);
}

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
	const pointId = crypto.randomUUID();
	const created = await agent.createRecoveryPoint(
		input.project.slug,
		{ projectId: input.project.id, pointId },
		input.timeoutMs,
	);
	// No skip fingerprint was sent, so a skip is the agent misbehaving.
	if (!created.created) {
		throw new AgentCallError("AGENT_UNAVAILABLE", "The agent did not make the point.");
	}
	const now = new Date();
	return db
		.insertInto("recovery_points")
		.values({
			id: pointId,
			project_id: input.project.id,
			workspace_id: input.workspaceId,
			reason: input.reason,
			created_at: now.toISOString(),
			created_by: input.createdBy,
			size_bytes: created.sizeBytes,
			sha256: created.sha256,
			fingerprint: created.fingerprint,
			expires_at: new Date(
				now.getTime() + config.RECOVERY_RETENTION_DAYS * DAY_MS,
			).toISOString(),
		})
		.returningAll()
		.executeTakeFirstOrThrow();
}
