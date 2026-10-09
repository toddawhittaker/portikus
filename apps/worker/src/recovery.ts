import { randomUUID } from "node:crypto";
import type { RecoveryReason } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import { errorMessage, type Logger, silentLogger } from "@portikus/observability";
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

/** An archive with no row is only removed once it is this old (SPEC.md §15.10). */
const ORPHAN_MIN_AGE_MS = 60 * 60 * 1000;

/**
 * Orphans deleted per workspace per sweep. Orphans are rare, so this only
 * bounds how long one workspace's agent can hold up a sweep (SPEC.md §24).
 */
const ORPHAN_DELETES_PER_SWEEP = 20;

/** Operations that wait for a point of every active project, and the reason they record. */
const BEFORE_OPERATION_REASON: Record<string, RecoveryReason> = {
	rebuild: "before-rebuild",
	"rebuild-reset-docker": "before-rebuild",
	"replace-home": "before-replace-home",
};

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
		const beforeReason = BEFORE_OPERATION_REASON[ws.pending_operation ?? ""];
		const rebuilding = beforeReason !== undefined;
		// Rebuilds need every active project tried (SPEC.md §22.3); periodic
		// points only the ones due.
		let reason: RecoveryReason | null = null;
		let projects: { id: string; slug: string }[] = [];
		if (rebuilding) {
			reason = beforeReason;
			projects = await activeProjects(db, ws.id, undefined, true);
		} else if (ws.pending_operation === null) {
			reason = "periodic";
			const cutoff = new Date(now.getTime() - config.RECOVERY_INTERVAL_SECONDS * 1000);
			projects = await activeProjects(db, ws.id, cutoff);
		}
		for (const [i, p] of projects.entries()) {
			const outcome = await makePoint(
				db,
				agent,
				ws.id,
				p,
				reason as RecoveryReason,
				!rebuilding,
				config,
				now,
				log,
			);
			if (outcome === "created") created++;
			if (outcome === "unreachable") {
				// One timeout per sweep is enough, so a hung agent cannot hold a lane
				// for hours. A rebuild leaves the rest untried; its query puts them
				// first next sweep, so each gets a real attempt (SPEC.md §22.3).
				if (!rebuilding) {
					await markChecked(
						db,
						projects.slice(i + 1).map((rest) => rest.id),
						now,
					);
				}
				return;
			}
		}
		// Await first: `deleted += await` would read `deleted` before other lanes add to it.
		const removed = await applyRetention(db, agent, ws.id, config, now, log);
		deleted += removed;
		const orphans = await removeOrphanArchives(db, agent, ws.id, now, log);
		deleted += orphans;
	};

	let next = 0;
	const lane = async (): Promise<void> => {
		while (next < running.length) {
			const ws = running[next++] as (typeof running)[number];
			try {
				await sweepOne(ws);
			} catch (e) {
				log.warn(
					{ workspaceId: ws.id, error: errorMessage(e) },
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
	leastRecentFirst = false,
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
	if (leastRecentFirst) {
		query = query.orderBy(sql`recovery_checked_at asc nulls first`);
	}
	return query.orderBy("created_at").execute();
}

/**
 * Ask the agent for a point and record it. `recovery_checked_at` is stamped
 * whatever happens, so a broken project is retried next interval, not every
 * sweep, and a pending rebuild can tell the attempt was made. Says whether
 * a point was written, or whether the agent could not be reached at all.
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
): Promise<"created" | "none" | "unreachable"> {
	const pointId = randomUUID();
	let outcome: "created" | "none" | "unreachable" = "none";
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
			outcome = "created";
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
		const errorCode = (e as { code?: string }).code ?? "UNKNOWN";
		if (errorCode === "AGENT_UNAVAILABLE") outcome = "unreachable";
		const fields = { workspaceId, projectId: project.id, reason, errorCode };
		// The student removed the folder since the last sync; nothing is wrong.
		if (errorCode === "PROJECT_NOT_FOUND") {
			log.info(fields, "recovery point skipped: project folder is gone");
		} else {
			log.warn(fields, "recovery point failed");
		}
	}
	await markChecked(db, [project.id], now);
	return outcome;
}

/** Stamp projects as tried for a point at `now`. */
async function markChecked(
	db: Kysely<Database>,
	projectIds: string[],
	now: Date,
): Promise<void> {
	if (projectIds.length === 0) return;
	await db
		.updateTable("projects")
		.set({ recovery_checked_at: now.toISOString() })
		.where("id", "in", projectIds)
		.execute();
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

/**
 * Delete archives no `recovery_points` row accounts for, such as one written
 * by an agent whose caller crashed before recording it (SPEC.md §15.10).
 * A file younger than an hour is left alone, since its row may still be on
 * its way. At most ORPHAN_DELETES_PER_SWEEP go per sweep, and the first
 * failed delete ends this workspace's pass, as a failed point delete does;
 * the rest wait for the next sweep. An agent too old to list archives
 * answers 404 and is skipped.
 */
async function removeOrphanArchives(
	db: Kysely<Database>,
	agent: RecoveryAgent,
	workspaceId: string,
	now: Date,
	log: Logger,
): Promise<number> {
	let archives: Awaited<ReturnType<RecoveryAgent["listRecoveryArchives"]>>["archives"];
	try {
		archives = (await agent.listRecoveryArchives()).archives;
	} catch (e) {
		if ((e as { status?: number }).status === 404) return 0;
		log.warn(
			{ workspaceId, errorCode: (e as { code?: string }).code ?? "UNKNOWN" },
			"recovery archive listing failed",
		);
		return 0;
	}
	const cutoff = now.getTime() - ORPHAN_MIN_AGE_MS;
	// An archive and its `.partial` share one point id; one delete removes both.
	const old = new Map<string, string>();
	for (const a of archives) {
		if (Date.parse(a.modifiedAt) < cutoff) old.set(a.pointId, a.projectId);
	}
	if (old.size === 0) return 0;
	const known = await db
		.selectFrom("recovery_points")
		.select("id")
		.where("id", "in", [...old.keys()])
		.execute();
	for (const row of known) old.delete(row.id);

	let deleted = 0;
	for (const [pointId, projectId] of old) {
		if (deleted >= ORPHAN_DELETES_PER_SWEEP) break;
		try {
			await agent.deleteRecoveryPoint(projectId, pointId);
		} catch (e) {
			log.warn(
				{
					workspaceId,
					projectId,
					pointId,
					errorCode: (e as { code?: string }).code ?? "UNKNOWN",
				},
				"orphan recovery archive delete failed",
			);
			return deleted;
		}
		log.info({ workspaceId, projectId, pointId }, "orphan recovery archive deleted");
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
