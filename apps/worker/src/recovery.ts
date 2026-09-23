import { randomUUID } from "node:crypto";
import type { RecoveryReason } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import { type Logger, silentLogger } from "@portikus/observability";
import { type Kysely, sql } from "kysely";
import type { AgentFactory, RecoveryAgent } from "./agent-client.js";

/** Config values the recovery sweep reads (SPEC.md §15.6, §15.7). */
export interface RecoveryConfig {
	WORKSPACE_RECOVERY_SIZE_GIB: number;
	RECOVERY_INTERVAL_SECONDS: number;
	RECOVERY_RETENTION_DAYS: number;
}

export interface RecoverySweepResult {
	created: number;
	deleted: number;
}

/** Retention keeps each workspace at or below this share of its allowance (ADR 0020). */
const RETENTION_TARGET = 0.75;

/** Sizes count as whole filesystem blocks, so many tiny archives are counted fairly. */
const BLOCK_BYTES = 4096;

/** Workspaces swept at once, so one slow agent cannot hold up the rest. */
const SWEEP_CONCURRENCY = 4;

const GIB = 1024 ** 3;

const REBUILD_OPERATIONS = ["rebuild", "rebuild-reset-docker"];

interface RunningWorkspace {
	id: string;
	agent_address: string;
	agent_token: string;
}

/**
 * One pass of the recovery loop, which runs on its own timer so a slow archive
 * never delays the reconcile loop (ADR 0006, ADR 0020). It makes the
 * before-rebuild points a pending rebuild waits for, then periodic points of
 * changed projects, then applies retention. It never touches `state`.
 */
export async function recoverySweep(
	db: Kysely<Database>,
	agentFor: AgentFactory,
	config: RecoveryConfig,
	now: Date,
	log: Logger = silentLogger(),
): Promise<RecoverySweepResult> {
	let created = 0;
	let deleted = 0;

	const running = (await db
		.selectFrom("workspaces")
		.select(["id", "agent_address", "agent_token", "pending_operation"])
		.where("state", "=", "running")
		.where("agent_address", "is not", null)
		.where("agent_token", "is not", null)
		.execute()) as (RunningWorkspace & { pending_operation: string | null })[];

	const sweepOne = async (ws: (typeof running)[number]): Promise<void> => {
		const agent = agentFor(ws.agent_address, ws.agent_token);
		const rebuilding = REBUILD_OPERATIONS.includes(ws.pending_operation ?? "");
		if (rebuilding) {
			// Every active project gets a point before the root is replaced
			// (SPEC.md §22.3). Reconcile stops the workspace once each is tried.
			const projects = await activeProjects(db, ws.id);
			for (const p of projects) {
				if (
					await makePoint(
						db,
						agent,
						ws.id,
						p,
						"before-rebuild",
						false,
						config,
						now,
						log,
					)
				) {
					created++;
				}
			}
		} else if (ws.pending_operation === null) {
			const cutoff = new Date(now.getTime() - config.RECOVERY_INTERVAL_SECONDS * 1000);
			const due = await activeProjects(db, ws.id, cutoff);
			for (const p of due) {
				if (await makePoint(db, agent, ws.id, p, "periodic", true, config, now, log)) {
					created++;
				}
			}
		}
		// Await first: `deleted += await` would read `deleted` before other lanes add to it.
		const removed = await applyRetention(db, agent, ws.id, config, now, log);
		deleted += removed;
	};

	let next = 0;
	const lane = async (): Promise<void> => {
		while (next < running.length) {
			const ws = running[next++] as (typeof running)[number];
			try {
				await sweepOne(ws);
			} catch (e) {
				log.warn(
					{ workspaceId: ws.id, error: e instanceof Error ? e.message : String(e) },
					"recovery sweep of workspace failed",
				);
			}
		}
	};
	await Promise.all(Array.from({ length: SWEEP_CONCURRENCY }, lane));

	return { created, deleted };
}

/** Active projects of a workspace, optionally only those not checked since `cutoff`. */
async function activeProjects(
	db: Kysely<Database>,
	workspaceId: string,
	cutoff?: Date,
): Promise<{ id: string; slug: string }[]> {
	let query = db
		.selectFrom("projects")
		.select(["id", "slug"])
		.where("workspace_id", "=", workspaceId)
		.where("state", "=", "active");
	if (cutoff) {
		query = query.where((eb) =>
			eb.or([
				eb("recovery_checked_at", "is", null),
				eb("recovery_checked_at", "<", cutoff),
			]),
		);
	}
	return query.orderBy("created_at").execute();
}

/**
 * Ask the agent for a point and record it. `recovery_checked_at` is stamped
 * whatever happens, so a broken project is retried next interval, not every
 * sweep, and a pending rebuild can tell the attempt was made. Returns true
 * when a point was written.
 */
async function makePoint(
	db: Kysely<Database>,
	agent: RecoveryAgent,
	workspaceId: string,
	project: { id: string; slug: string },
	reason: RecoveryReason,
	skipUnchanged: boolean,
	config: RecoveryConfig,
	now: Date,
	log: Logger,
): Promise<boolean> {
	const pointId = randomUUID();
	let written = false;
	try {
		const latest = skipUnchanged
			? await db
					.selectFrom("recovery_points")
					.select("fingerprint")
					.where("project_id", "=", project.id)
					.orderBy("created_at", "desc")
					.limit(1)
					.executeTakeFirst()
			: undefined;
		const result = await agent.createRecoveryPoint(project.slug, {
			projectId: project.id,
			pointId,
			...(latest ? { skipIfFingerprint: latest.fingerprint } : {}),
		});
		if (result.created) {
			// The archive may take minutes, so the point is stamped when it exists.
			const madeAt = new Date();
			await db
				.insertInto("recovery_points")
				.values({
					id: pointId,
					project_id: project.id,
					workspace_id: workspaceId,
					reason,
					created_at: madeAt.toISOString(),
					created_by: "worker",
					size_bytes: result.sizeBytes,
					sha256: result.sha256,
					fingerprint: result.fingerprint,
					expires_at: new Date(
						madeAt.getTime() + config.RECOVERY_RETENTION_DAYS * 86_400_000,
					).toISOString(),
				})
				.execute();
			written = true;
			// Ids, reason and size only: never file names (ADR 0012).
			log.info(
				{
					workspaceId,
					projectId: project.id,
					pointId,
					reason,
					sizeBytes: result.sizeBytes,
				},
				"recovery point created",
			);
		}
	} catch (e) {
		log.warn(
			{
				workspaceId,
				projectId: project.id,
				reason,
				errorCode: (e as { code?: string }).code ?? "UNKNOWN",
			},
			"recovery point failed",
		);
	}
	await db
		.updateTable("projects")
		.set({ recovery_checked_at: now.toISOString() })
		.where("id", "=", project.id)
		.execute();
	return written;
}

/**
 * Delete expired points, then the oldest points until the workspace is at or
 * below 75% of its allowance. The newest point of each project is never
 * deleted (SPEC.md §15.7, ADR 0020). The file goes first, then the row, so a
 * failed delete leaves the row that accounts for the file.
 */
async function applyRetention(
	db: Kysely<Database>,
	agent: RecoveryAgent,
	workspaceId: string,
	config: RecoveryConfig,
	now: Date,
	log: Logger,
): Promise<number> {
	const ws = await db
		.selectFrom("workspaces")
		.select("quota_config")
		.where("id", "=", workspaceId)
		.executeTakeFirstOrThrow();
	const quotaBytes =
		(ws.quota_config?.recoveryGiB ?? config.WORKSPACE_RECOVERY_SIZE_GIB) * GIB;

	const points = await db
		.selectFrom("recovery_points")
		.select(["id", "project_id", "size_bytes", "expires_at"])
		.where("workspace_id", "=", workspaceId)
		.orderBy("created_at", "asc")
		.orderBy("id", "asc")
		.execute();

	const newest = new Map<string, string>();
	for (const p of points) newest.set(p.project_id, p.id);

	let total = points.reduce((sum, p) => sum + allocated(p.size_bytes), 0);
	const target = quotaBytes * RETENTION_TARGET;
	let deleted = 0;

	for (const p of points) {
		if (newest.get(p.project_id) === p.id) continue;
		const expired = p.expires_at.getTime() <= now.getTime();
		if (!expired && total <= target) continue;
		try {
			await agent.deleteRecoveryPoint(p.project_id, p.id);
		} catch (e) {
			// The agent's delete succeeds for a file already gone, so any
			// error means the file may still be there.
			log.warn(
				{
					workspaceId,
					pointId: p.id,
					errorCode: (e as { code?: string }).code ?? "UNKNOWN",
				},
				"recovery point delete failed",
			);
			return deleted;
		}
		await db.deleteFrom("recovery_points").where("id", "=", p.id).execute();
		total -= allocated(p.size_bytes);
		deleted++;
	}
	return deleted;
}

/** A point's on-disk size: its bytes rounded up to a whole block. */
function allocated(sizeBytes: number | string | bigint): number {
	return Math.ceil(Number(sizeBytes) / BLOCK_BYTES) * BLOCK_BYTES;
}

/**
 * True when every active project of a workspace has been tried for a point
 * since `since`. A pending rebuild waits for this before it stops the
 * workspace (SPEC.md §22.3).
 */
export async function rebuildPointsDone(
	db: Kysely<Database>,
	workspaceId: string,
	since: Date,
): Promise<boolean> {
	const row = await db
		.selectFrom("projects")
		.select(sql<string>`count(*)`.as("cnt"))
		.where("workspace_id", "=", workspaceId)
		.where("state", "=", "active")
		.where((eb) =>
			eb.or([
				eb("recovery_checked_at", "is", null),
				eb("recovery_checked_at", "<", since),
			]),
		)
		.executeTakeFirstOrThrow();
	return Number(row.cnt) === 0;
}
