import type {
	AgentCreateRecoveryPointResponse,
	RecoveryReason,
} from "@portikus/contracts";
import { type Kysely, type Selectable, sql } from "kysely";
import type { Database } from "./schema.js";

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
 * Archive a project through the caller's agent call, then record the point
 * (SPEC.md §15.2, ADR 0020). The row is written only after the archive
 * exists, so a failed call leaves no row and its error reaches the caller.
 * Returns null when the agent skipped an unchanged project.
 */
export async function recordRecoveryPoint(
	db: Kysely<Database>,
	input: {
		projectId: string;
		workspaceId: string;
		reason: RecoveryReason;
		createdBy: string;
		retentionDays: number;
		archive: (pointId: string) => Promise<AgentCreateRecoveryPointResponse>;
	},
): Promise<RecoveryPointRow | null> {
	const pointId = crypto.randomUUID();
	const result = await input.archive(pointId);
	if (!result.created) return null;
	// The archive may take minutes, so the point is stamped when it exists.
	const madeAt = new Date();
	return db
		.insertInto("recovery_points")
		.values({
			id: pointId,
			project_id: input.projectId,
			workspace_id: input.workspaceId,
			reason: input.reason,
			created_at: madeAt.toISOString(),
			created_by: input.createdBy,
			size_bytes: result.sizeBytes,
			sha256: result.sha256,
			fingerprint: result.fingerprint,
			expires_at: new Date(
				madeAt.getTime() + input.retentionDays * DAY_MS,
			).toISOString(),
		})
		.returningAll()
		.executeTakeFirstOrThrow();
}
