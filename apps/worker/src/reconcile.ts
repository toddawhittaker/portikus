import { randomBytes } from "node:crypto";
import {
	type ControllerErrorCode,
	DEFAULT_KEEP_RUNNING_MAX_HOURS,
	DEFAULT_TIMEZONE,
	isSystemTimezone,
	PendingOperation,
} from "@portikus/contracts";
import { type Database, recordAudit } from "@portikus/db";
import { errorMessage, type Logger, silentLogger } from "@portikus/observability";
import { type ExpressionBuilder, type Kysely, sql } from "kysely";
import { runReplaceHome } from "./backups.js";
import type { ControllerClient } from "./controller-client.js";
import { ControllerClientError } from "./controller-client.js";
import { dockerStartConfig } from "./docker-start.js";
import { rebuildPointsDone } from "./recovery.js";

/** Config values the reconciler reads. */
export interface ReconcileConfig {
	PRESENCE_TTL_SECONDS: number;
	SHUTDOWN_GRACE_SECONDS: number;
	START_TIMEOUT_SECONDS: number;
	STOP_TIMEOUT_SECONDS: number;
	STATUS_REFRESH_SECONDS: number;
	WORKSPACE_HOME_SIZE_GIB: number;
	WORKSPACE_DOCKER_SIZE_GIB: number;
	WORKSPACE_RECOVERY_SIZE_GIB: number;
	PREVIEW_SUFFIX: string;
}

/** How many creates, and then starts, one sweep runs at once. */
const START_CONCURRENCY = 6;

export interface SweepResult {
	transitions: number;
	lastRefreshAt: Date | null;
	/** True when the last status refresh could not reach the controller. */
	controllerUnreachable: boolean;
	/** Details of that failure, for the caller to log. */
	refreshError: { code: string; message: string } | null;
}

/** How long "Still working?" shows before an idle workspace stops; fixed (ADR 0032). */
export const IDLE_WARNING_MS = 5 * 60_000;

/** How long an errored workspace rests before the sweep retries a start. */
const ERROR_RETRY_SECONDS = 10;

/**
 * Waits between create attempts when the controller is unreachable, so a
 * controller restart during a deploy does not leave a workspace in error.
 */
export const CREATE_RETRY_DELAYS_MS: readonly number[] = [1000, 2000, 4000, 8000];

/**
 * Run `task` on every item, at most `limit` at a time. Each task must catch
 * its own errors, so one failure never stops the others.
 */
async function forEachBounded<T>(
	items: readonly T[],
	limit: number,
	task: (item: T) => Promise<void>,
): Promise<void> {
	let next = 0;
	const runner = async (): Promise<void> => {
		while (next < items.length) {
			const item = items[next++] as T;
			await task(item);
		}
	};
	const runners = Array.from({ length: Math.min(limit, items.length) }, runner);
	await Promise.all(runners);
}

const INSTANCE_MISSING_MESSAGE =
	"Your workspace instance no longer exists. Please contact your administrator.";

/**
 * Leaves desired_state alone unless it is still 'restarting', so a
 * connect that arrives while a slow stop is in flight is not overwritten
 * by a value read before the stop began (SPEC.md §6.3).
 */
const settleRestarting = sql`case when desired_state = 'restarting' then 'running' else desired_state end`;

/** Maps controller error codes to user-friendly messages (SPEC section 28). */
function userMessage(code: ControllerErrorCode): string {
	switch (code) {
		case "STORAGE_FULL":
			return "Your workspace could not start because its storage is full.";
		case "POOL_FULL":
			return "There is no room for a new workspace right now. Your administrator has been told.";
		case "IMAGE_NOT_FOUND":
			return "The workspace image is not available. Please contact your administrator.";
		case "TIMEOUT":
			return "The operation timed out. Please try again.";
		case "INCUS_UNAVAILABLE":
			return "The workspace infrastructure is temporarily unavailable. Please try again later.";
		default:
			return "An unexpected error occurred. Please try again or contact your administrator.";
	}
}

/** Normalise anything thrown by the controller client. */
function toControllerError(e: unknown): ControllerClientError {
	return e instanceof ControllerClientError
		? e
		: new ControllerClientError("OPERATION_FAILED", String(e));
}

/**
 * Compare-and-set update: transitions a workspace from one state to
 * another only if the current state matches. Returns the updated row
 * or null if someone else changed it first.
 */
async function casUpdate(
	db: Kysely<Database>,
	id: string,
	fromState: string,
	updates: Record<string, unknown>,
	now: Date,
): Promise<{ id: string } | null> {
	const rows = await db
		.updateTable("workspaces")
		.set({
			...updates,
			updated_at: now.toISOString(),
		})
		.where("id", "=", id)
		.where("state", "=", fromState)
		.returning("id")
		.execute();
	return rows[0] ?? null;
}

/**
 * Mint a fresh agent token for a workspace and store it (ADR 0009; SPEC.md
 * section 23.5). Every start rotates the token, so a token that leaked from a
 * previous run is worthless. Never log or audit the returned value.
 */
async function rotateAgentToken(db: Kysely<Database>, id: string): Promise<string> {
	const token = randomBytes(32).toString("hex");
	await db
		.updateTable("workspaces")
		.set({ agent_token: token })
		.where("id", "=", id)
		.execute();
	return token;
}

/**
 * Mark every still-open terminal of a workspace as ended. Called from every
 * path that takes a workspace out of running (SPEC.md section 9.7).
 */
async function endOpenTerminals(
	db: Kysely<Database>,
	workspaceId: string,
	now: Date,
): Promise<void> {
	await db
		.updateTable("terminals")
		.set({ ended_at: now.toISOString() })
		.where("workspace_id", "=", workspaceId)
		.where("ended_at", "is", null)
		.execute();
}

/**
 * Clear what the resource guard holds for a workspace that has stopped: the
 * throttle, the memory flag and the idle warning, auditing each cleared mark
 * with reason "stopped" (ADR 0032). Samples are kept so usage is remembered
 * across restarts, except that a cleared throttle drops the samples from
 * before it, so a restart after a throttle starts fresh. A held throttle
 * (SPEC.md §19.4) is kept, with its samples, and the next start passes its
 * allowance; otherwise the controller removes the allowance at the next start.
 */
async function clearGuardAtStop(db: Kysely<Database>, id: string): Promise<void> {
	const before = await db
		.selectFrom("workspaces")
		.select(["cpu_throttle", "memory_flag"])
		.where("id", "=", id)
		.executeTakeFirst();
	const held = before?.cpu_throttle?.held !== undefined;
	await db
		.updateTable("workspaces")
		.set({
			...(held ? {} : { cpu_throttle: null }),
			memory_flag: null,
			idle_stop_at: null,
		})
		.where("id", "=", id)
		.execute();
	if (before?.cpu_throttle && !held) {
		await db
			.deleteFrom("workspace_usage_samples")
			.where("workspace_id", "=", id)
			.where("observed_at", "<=", new Date(before.cpu_throttle.at))
			.execute();
		await recordAudit(db, {
			actor: "worker",
			target: id,
			action: "workspace.cpu_throttle_lifted",
			result: "ok",
			metadata: { reason: "stopped" },
		});
	}
	if (before?.memory_flag) {
		await recordAudit(db, {
			actor: "worker",
			target: id,
			action: "workspace.memory_flag_cleared",
			result: "ok",
			metadata: { reason: "stopped" },
		});
	}
}

/** A held throttle's allowance, so a start never runs at full speed (SPEC.md §19.4). */
async function heldAllowance(
	db: Kysely<Database>,
	id: string,
): Promise<string | undefined> {
	const row = await db
		.selectFrom("workspaces")
		.select("cpu_throttle")
		.where("id", "=", id)
		.executeTakeFirst();
	return row?.cpu_throttle?.held ? row.cpu_throttle.allowance : undefined;
}

/** A workspace that has just started counts as active, so it never starts idle (ADR 0032). */
function startedNow(now: Date): Record<string, unknown> {
	return { last_activity_at: now.toISOString(), idle_stop_at: null };
}

/**
 * Settle every "keep running until" hold (#955, Epic 28 ruling R1). A hold
 * past its cap is cut to the cap from now, or ended when the cap is 0. An
 * ended hold restarts both timers from its end, as if the student had just
 * acted, so "Still working?" and its warning still come. After this, any
 * hold left is ahead of now, and the grace and idle steps skip its workspace.
 */
export async function settleKeepRunning(
	db: Kysely<Database>,
	now: Date,
): Promise<void> {
	const at = now.toISOString();
	// The target row's own columns only, so a concurrent end or shorter hold
	// committed first is rechecked under READ COMMITTED, not overwritten.
	const cap = sql`coalesce((w.guard_config->>'keepRunningMaxHours')::int,
		(select s.keep_running_max_hours from settings s where s.id = 1),
		${DEFAULT_KEEP_RUNNING_MAX_HOURS}::int)`;

	const off = await sql<{ id: string }>`
		update workspaces w
		set keep_running_until = null, last_activity_at = ${at}::timestamptz, idle_stop_at = null,
			disconnected_at = case when w.disconnected_at is null then null else ${at}::timestamptz end
		where w.keep_running_until > ${at}::timestamptz and ${cap} = 0
		returning w.id
	`.execute(db);
	for (const ws of off.rows) {
		await recordAudit(db, {
			actor: "worker",
			target: ws.id,
			action: "workspace.keep_running_ended",
			result: "ok",
			metadata: {
				reason: "cut_by_cap",
			},
		});
	}

	const cut = await sql<{ id: string; until: Date; max_hours: number }>`
		update workspaces w
		set keep_running_until = ${at}::timestamptz + ${cap} * interval '1 hour'
		where w.keep_running_until > ${at}::timestamptz + ${cap} * interval '1 hour'
		returning w.id, w.keep_running_until as until, ${cap} as max_hours
	`.execute(db);
	for (const ws of cut.rows) {
		await recordAudit(db, {
			actor: "worker",
			target: ws.id,
			action: "workspace.keep_running_set",
			result: "ok",
			metadata: {
				until: new Date(ws.until).toISOString(),
				reason: "cut_by_cap",
				maxHours: ws.max_hours,
			},
		});
	}

	const expired = await sql<{ id: string }>`
		update workspaces w
		set keep_running_until = null, idle_stop_at = null,
			last_activity_at = greatest(w.last_activity_at, w.keep_running_until),
			disconnected_at = case when w.disconnected_at is null then null
				else greatest(w.disconnected_at, w.keep_running_until) end
		where w.keep_running_until <= ${at}::timestamptz
		returning w.id
	`.execute(db);
	for (const ws of expired.rows) {
		await recordAudit(db, {
			actor: "worker",
			target: ws.id,
			action: "workspace.keep_running_ended",
			result: "ok",
			metadata: { reason: "expired" },
		});
	}
}

/** Optional inputs to one sweep; tests pass the last two. */
export interface ReconcileOptions {
	/** When the last list() refresh happened, or null for never. */
	lastRefreshAt?: Date | null;
	/** The same field from the previous sweep (SPEC §25.4). */
	controllerUnreachable?: boolean;
	log?: Logger;
	createRetryDelaysMs?: readonly number[];
}

/** What every step of one sweep shares. */
interface SweepContext {
	db: Kysely<Database>;
	controller: ControllerClient;
	config: ReconcileConfig;
	now: Date;
	log: Logger;
	createRetryDelaysMs: readonly number[];
	transitions: number;
	/** Note an action for the per-workspace debug line. */
	record: (id: string, action: string) => void;
}

/** Step 1: delete stale workspace_connections rows. */
async function expireConnections(ctx: SweepContext): Promise<void> {
	const { db, config, now } = ctx;
	// (1) Delete stale workspace_connections rows.
	const ttlCutoff = new Date(now.getTime() - config.PRESENCE_TTL_SECONDS * 1000);
	await db
		.deleteFrom("workspace_connections")
		.where("last_seen_at", "<", ttlCutoff)
		.execute();
}

/** Step 2: track disconnection and recompute shutdown deadlines. */
async function trackDisconnections(ctx: SweepContext): Promise<void> {
	const { db, config, now } = ctx;
	// (2) Track disconnection and recompute shutdown deadlines.
	// A running workspace with no connections gets a disconnected_at stamp;
	// one with connections loses both the stamp and any deadline.
	const noConnections = (eb: ExpressionBuilder<Database, "workspaces">) =>
		eb(
			eb
				.selectFrom("workspace_connections")
				.select(db.fn.countAll<string>().as("cnt"))
				.whereRef("workspace_connections.workspace_id", "=", "workspaces.id"),
			"=",
			"0",
		);

	await db
		.updateTable("workspaces")
		.set({ disconnected_at: now.toISOString(), updated_at: now.toISOString() })
		.where("state", "=", "running")
		.where("disconnected_at", "is", null)
		.where(noConnections)
		.execute();

	await db
		.updateTable("workspaces")
		.set({
			disconnected_at: null,
			shutdown_deadline: null,
			updated_at: now.toISOString(),
		})
		.where("state", "=", "running")
		.where((eb) =>
			eb.or([
				eb("disconnected_at", "is not", null),
				eb("shutdown_deadline", "is not", null),
			]),
		)
		.where((eb) => eb.not(noConnections(eb)))
		.execute();

	// Recompute every disconnected workspace's deadline from settings an
	// administrator can change while we run (SPEC.md §6.4). A per-user override
	// wins over the platform value, and zero means "never shut down", so the
	// deadline is cleared. Rows whose deadline already matches are left alone.
	const grace = sql`coalesce(u.shutdown_grace_seconds, s.shutdown_grace_seconds, ${sql.lit(
		config.SHUTDOWN_GRACE_SECONDS,
	)})`;
	await sql`
		update workspaces w
		set shutdown_deadline = d.new_deadline, updated_at = ${now.toISOString()}::timestamptz
		from (
			select
				ws.id,
				case when ${grace} = 0 or ws.keep_running_until is not null then null
					else ws.disconnected_at + ${grace} * interval '1 second' end as new_deadline
			from workspaces ws
			join users u on u.id = ws.owner_user_id
			left join settings s on s.id = 1
			where ws.state = 'running' and ws.disconnected_at is not null
		) d
		where w.id = d.id and w.shutdown_deadline is distinct from d.new_deadline
	`.execute(db);
}

/** Step 3a: create provisioning workspaces. */
async function createProvisioning(ctx: SweepContext): Promise<void> {
	const { db, controller, config, now, createRetryDelaysMs, record } = ctx;
	// 3a: provisioning -> create -> stopped/error
	const provisioning = await db
		.selectFrom("workspaces")
		.select(["id", "incus_instance_name", "error_code"])
		.where("state", "=", "provisioning")
		.execute();

	await forEachBounded(provisioning, START_CONCURRENCY, async (ws) => {
		if (!ws.incus_instance_name) return;
		const outcome = await createWorkspace(
			db,
			controller,
			config,
			{
				id: ws.id,
				incus_instance_name: ws.incus_instance_name,
				error_code: ws.error_code,
			},
			now,
			createRetryDelaysMs,
		);
		if (outcome) {
			ctx.transitions++;
			record(ws.id, outcome);
		}
	});
}

/** Step 3b: start stopped workspaces that should run. */
async function startStopped(ctx: SweepContext): Promise<void> {
	const { db, controller, config, now, record } = ctx;
	// 3b: stopped with desired running (or restarting) -> start. A pending
	// maintenance operation runs first (ADR 0021).
	const toStart = await db
		.selectFrom("workspaces")
		.select(["id", "incus_instance_name", "label", "quota_config"])
		.where("state", "=", "stopped")
		.where("desired_state", "in", ["running", "restarting"])
		.where("pending_operation", "is", null)
		.where("archived_at", "is", null)
		.execute();

	await forEachBounded(toStart, START_CONCURRENCY, async (ws) => {
		record(ws.id, "start");
		const n = await startWorkspace(db, controller, config, ws, "stopped", now);
		ctx.transitions += n;
	});
}

/** Step 3c: stop running workspaces that should stop or whose grace period passed. */
async function stopRunning(ctx: SweepContext): Promise<void> {
	const { db, controller, config, now, log, record } = ctx;
	// 3c: running -> stopping (desired stopped/restarting, or deadline passed)
	// First: explicit desired stopped or restarting, or archived whatever it wants.
	const toStopExplicit = await db
		.selectFrom("workspaces")
		.select(["id", "incus_instance_name"])
		.where("state", "=", "running")
		.where((eb) =>
			eb.or([
				eb("desired_state", "in", ["stopped", "restarting"]),
				eb("archived_at", "is not", null),
			]),
		)
		.execute();

	for (const ws of toStopExplicit) {
		if (!ws.incus_instance_name) continue;
		const moved = await casUpdate(db, ws.id, "running", { state: "stopping" }, now);
		if (!moved) continue;
		ctx.transitions++;
		record(ws.id, "stop requested");
		await endOpenTerminals(db, ws.id, now);
		stopInBackground(db, controller, config, ws, log);
	}

	// A pending maintenance operation stops a running workspace without
	// touching desired_state, so it restarts afterwards (ADR 0021). A rebuild
	// first waits for the recovery loop to try a point of each project.
	const toStopForOperation = await db
		.selectFrom("workspaces")
		.select(["id", "incus_instance_name", "pending_operation", "pending_operation_at"])
		.where("state", "=", "running")
		.where("pending_operation", "is not", null)
		.execute();

	for (const ws of toStopForOperation) {
		if (!ws.incus_instance_name) continue;
		if (
			ws.pending_operation !== "reset-docker" &&
			!(await rebuildPointsDone(db, ws.id, ws.pending_operation_at ?? now))
		) {
			continue;
		}
		const moved = await casUpdate(db, ws.id, "running", { state: "stopping" }, now);
		if (!moved) continue;
		ctx.transitions++;
		record(ws.id, `stop for ${ws.pending_operation}`);
		await endOpenTerminals(db, ws.id, now);
		stopInBackground(db, controller, config, ws, log);
	}

	// Deadline passed with zero connections: single UPDATE with count subquery.
	// Setting desired_state here is safe because the same statement asserts
	// there are no connections; a connect that lands later wins on its own.
	const deadlinePassed = await db
		.updateTable("workspaces")
		.set({
			state: "stopping",
			desired_state: sql`case when desired_state = 'restarting' then 'running' else 'stopped' end`,
			updated_at: now.toISOString(),
		})
		.where("state", "=", "running")
		.where("shutdown_deadline", "<=", now)
		.where(({ eb, selectFrom }) =>
			eb(
				selectFrom("workspace_connections")
					.select(db.fn.countAll<string>().as("cnt"))
					.whereRef("workspace_connections.workspace_id", "=", "workspaces.id"),
				"=",
				"0",
			),
		)
		.returning(["id", "incus_instance_name"])
		.execute();

	for (const ws of deadlinePassed) {
		ctx.transitions++;
		record(ws.id, "stop after grace period");
		await endOpenTerminals(db, ws.id, now);
		if (!ws.incus_instance_name) continue;
		stopInBackground(db, controller, config, ws, log);
	}
}

/** Idle stop: warn, then stop a workspace idle for too long. */
async function stopIdle(ctx: SweepContext): Promise<void> {
	const { db, controller, config, now, log, record } = ctx;
	// Idle stop (ADR 0032): a workspace override wins over the platform value,
	// and 0 means never. It runs whether or not a browser is connected; the
	// grace period above may still stop a workspace first.
	const idle = sql`coalesce((ws.guard_config->>'idleStopMinutes')::int, s.idle_stop_minutes)`;

	// Idle turned off since the warning, or a hold set: withdraw it.
	await sql`
		update workspaces w set idle_stop_at = null
		from workspaces ws left join settings s on s.id = 1
		where w.id = ws.id and ws.idle_stop_at is not null
			and (coalesce(${idle}, 0) = 0 or ws.keep_running_until is not null)
	`.execute(db);

	// Idle for long enough: warn, and stop five minutes later. A shortened
	// setting also warns first, never stops at once.
	await sql`
		update workspaces w set idle_stop_at = ${new Date(now.getTime() + IDLE_WARNING_MS).toISOString()}::timestamptz
		from workspaces ws left join settings s on s.id = 1
		where w.id = ws.id and ws.state = 'running' and ws.idle_stop_at is null
			and ws.keep_running_until is null
			and ${idle} > 0
			and ws.last_activity_at + ${idle} * interval '1 minute' <= ${now.toISOString()}::timestamptz
	`.execute(db);

	const idlePassed = await sql<{
		id: string;
		incus_instance_name: string | null;
		idle_minutes: number;
	}>`
		update workspaces w
		set state = 'stopping',
			desired_state = case when w.desired_state = 'restarting' then 'running' else 'stopped' end,
			updated_at = ${now.toISOString()}::timestamptz
		from workspaces ws left join settings s on s.id = 1
		where w.id = ws.id and w.state = 'running' and w.idle_stop_at <= ${now.toISOString()}::timestamptz
		returning w.id, w.incus_instance_name, ${idle} as idle_minutes
	`.execute(db);

	for (const ws of idlePassed.rows) {
		ctx.transitions++;
		record(ws.id, "stop after idle");
		await recordAudit(db, {
			actor: "worker",
			target: ws.id,
			action: "workspace.idle_stopped",
			result: "ok",
			metadata: {
				idleMinutes: ws.idle_minutes,
			},
		});
		await endOpenTerminals(db, ws.id, now);
		if (!ws.incus_instance_name) continue;
		stopInBackground(db, controller, config, ws, log);
	}
}

/** Step 3d: retry a start for an errored workspace that should run. */
async function retryErrored(ctx: SweepContext): Promise<void> {
	const { db, controller, config, now, record } = ctx;
	// 3d: error with desired running (or restarting) -> retry a start, but
	// only after a short rest so a broken controller is not hammered.
	const retryCutoff = new Date(now.getTime() - ERROR_RETRY_SECONDS * 1000);
	const errorRetryStart = await db
		.selectFrom("workspaces")
		.select(["id", "incus_instance_name", "label", "quota_config"])
		.where("state", "=", "error")
		.where("desired_state", "in", ["running", "restarting"])
		.where("updated_at", "<", retryCutoff)
		.where("pending_operation", "is", null)
		.where("archived_at", "is", null)
		.execute();

	await forEachBounded(errorRetryStart, START_CONCURRENCY, async (ws) => {
		record(ws.id, "retry start");
		const n = await startWorkspace(db, controller, config, ws, "error", now);
		ctx.transitions += n;
	});

	// Note: error with desired=stopped is at rest (nothing to retry).
}

/** Step 3e: run a pending maintenance operation. */
async function runMaintenance(ctx: SweepContext): Promise<void> {
	const { db, controller, config, now, record } = ctx;
	// 3e: run a pending maintenance operation on a stopped or errored
	// workspace. Step 3b restarts it on the next sweep if it should run.
	const toMaintain = await db
		.selectFrom("workspaces")
		.select([
			"id",
			"incus_instance_name",
			"state",
			"pending_operation",
			"pending_operation_by",
			"pending_operation_at",
			"pending_operation_args",
			"quota_config",
		])
		.where("state", "in", ["stopped", "error"])
		.where("pending_operation", "is not", null)
		.execute();

	for (const ws of toMaintain) {
		if (!ws.incus_instance_name || !ws.pending_operation) continue;
		record(ws.id, ws.pending_operation);
		// Replace home spans several sweeps while the host imports (ADR 0040).
		if (ws.pending_operation === "replace-home") {
			ctx.transitions += await runReplaceHome(
				db,
				controller,
				{
					id: ws.id,
					instance: ws.incus_instance_name,
					state: ws.state,
					pendingAt: ws.pending_operation_at,
					pendingBy: ws.pending_operation_by,
					args: ws.pending_operation_args,
				},
				now,
			);
			continue;
		}
		ctx.transitions += await runOperation(
			db,
			controller,
			{
				id: ws.id,
				incus_instance_name: ws.incus_instance_name,
				state: ws.state,
				// The column has a check constraint, so this never throws.
				pending_operation: PendingOperation.parse(ws.pending_operation),
				pending_operation_by: ws.pending_operation_by,
				dockerGiB: dockerGiBOf(ws.quota_config, config),
			},
			now,
		);
	}
}

/** Steps 4 and 5: reconcile drift from list() and resolve stale starting and stopping rows. */
async function refreshFromList(
	ctx: SweepContext,
	lastRefreshAt: Date | null,
	controllerUnreachable: boolean,
): Promise<Omit<SweepResult, "transitions">> {
	const { db, controller, config, now, log, record } = ctx;
	let refreshAt = lastRefreshAt;
	let unreachable = controllerUnreachable;
	let refreshError: { code: string; message: string } | null = null;
	// (4) Periodic drift reconciliation from list().
	const shouldRefresh =
		refreshAt === null ||
		now.getTime() - refreshAt.getTime() >= config.STATUS_REFRESH_SECONDS * 1000;

	if (shouldRefresh) {
		let instances: Awaited<ReturnType<ControllerClient["list"]>> | null = null;
		// A stop that ends while list() runs leaves a list older than the row.
		const stoppingDuringList = new Set(stopsInFlight.keys());
		try {
			instances = await controller.list();
			// Only count a refresh that actually happened.
			refreshAt = now;
			unreachable = false;
		} catch (e) {
			const err = toControllerError(e);
			refreshError = { code: err.code, message: err.message };
			if (!unreachable) {
				// Record the start of a failure streak once (SPEC §25.4).
				log.error({ errorCode: err.code }, "controller unreachable");
				await recordAudit(db, {
					actor: "worker",
					target: "controller",
					action: "controller.unreachable",
					result: "failed",
					metadata: {
						errorCode: err.code,
					},
				});
			}
			unreachable = true;
		}

		if (instances !== null) {
			const instanceMap = new Map(instances.map((i) => [i.name, i]));

			// Find rows that might be drifted.
			const tracked = await db
				.selectFrom("workspaces")
				.select(["id", "incus_instance_name", "state", "agent_address"])
				.where("incus_instance_name", "is not", null)
				.where("state", "in", ["running", "stopped", "starting", "stopping", "error"])
				.execute();

			for (const ws of tracked) {
				if (!ws.incus_instance_name) continue;
				const inst = instanceMap.get(ws.incus_instance_name);
				// An error row with no instance keeps its error, but its old address may be leased elsewhere.
				if (!inst && ws.state === "error") {
					if (ws.agent_address !== null) {
						await db
							.updateTable("workspaces")
							.set({ agent_address: null })
							.where("id", "=", ws.id)
							.execute();
					}
					continue;
				}

				// The instance the row tracks is gone: say so instead of
				// reporting a state that cannot be true (SPEC §25.4).
				if (!inst) {
					const updated = await casUpdate(
						db,
						ws.id,
						ws.state,
						{
							state: "error",
							error_code: "INSTANCE_MISSING",
							error_message: INSTANCE_MISSING_MESSAGE,
							shutdown_deadline: null,
							disconnected_at: null,
						},
						now,
					);
					if (updated) {
						ctx.transitions++;
						await endOpenTerminals(db, ws.id, now);
						await clearGuardAtStop(db, ws.id);
						record(ws.id, "instance missing");
						await recordAudit(db, {
							actor: "worker",
							target: ws.id,
							action: "workspace.instance_missing",
							result: "failed",
							metadata: {
								instanceName: ws.incus_instance_name,
							},
						});
					}
					continue;
				}

				// Keep the recorded agent address in step with the instance. A stopped
				// instance's old address may be leased to another student's instance.
				// A running instance briefly without an address keeps its last one.
				const address =
					inst.ipv4 ??
					(inst.status === "Running" && ws.state !== "error" ? ws.agent_address : null);
				if (address !== ws.agent_address) {
					await db
						.updateTable("workspaces")
						.set({ agent_address: address })
						.where("id", "=", ws.id)
						.execute();
				}

				// Drift: row says running but instance is Stopped.
				if (ws.state === "running" && inst.status === "Stopped") {
					const updated = await casUpdate(
						db,
						ws.id,
						"running",
						{ state: "stopped", shutdown_deadline: null, disconnected_at: null },
						now,
					);
					if (updated) {
						ctx.transitions++;
						await endOpenTerminals(db, ws.id, now);
						await clearGuardAtStop(db, ws.id);
						record(ws.id, "observed stopped");
						await recordAudit(db, {
							actor: "worker",
							target: ws.id,
							action: "workspace.observed_stopped",
							result: "ok",
						});
					}
				}

				// Drift: row says stopped but instance is Running.
				if (
					ws.state === "stopped" &&
					inst.status === "Running" &&
					!stoppingDuringList.has(ws.id)
				) {
					const updated = await casUpdate(
						db,
						ws.id,
						"stopped",
						{ state: "running", ...startedNow(now) },
						now,
					);
					if (updated) {
						ctx.transitions++;
						record(ws.id, "observed running");
						await recordAudit(db, {
							actor: "worker",
							target: ws.id,
							action: "workspace.observed_running",
							result: "ok",
						});
					}
				}

				// (5) Resolve stale starting/stopping rows.
				if (ws.state === "starting") {
					if (inst.status === "Running") {
						const updated = await casUpdate(
							db,
							ws.id,
							"starting",
							{ state: "running", ...startedNow(now) },
							now,
						);
						if (updated) {
							ctx.transitions++;
							record(ws.id, "start resolved as running");
							await recordAudit(db, {
								actor: "worker",
								target: ws.id,
								action: "workspace.start",
								result: "ok",
								metadata: {
									resolvedFromList: true,
								},
							});
						}
					} else if (inst.status === "Stopped") {
						const updated = await casUpdate(
							db,
							ws.id,
							"starting",
							{
								state: "error",
								error_code: "OPERATION_FAILED",
								error_message: userMessage("OPERATION_FAILED"),
							},
							now,
						);
						if (updated) {
							ctx.transitions++;
							await endOpenTerminals(db, ws.id, now);
							record(ws.id, "start resolved as failed");
							await recordAudit(db, {
								actor: "worker",
								target: ws.id,
								action: "workspace.start_failed",
								result: "failed",
								metadata: {
									resolvedFromList: true,
								},
							});
						}
					}
				}

				if (
					ws.state === "stopping" &&
					!stopsInFlight.has(ws.id) &&
					!stoppingDuringList.has(ws.id)
				) {
					if (inst.status === "Stopped") {
						const updated = await casUpdate(
							db,
							ws.id,
							"stopping",
							{ state: "stopped", shutdown_deadline: null, disconnected_at: null },
							now,
						);
						if (updated) {
							ctx.transitions++;
							await endOpenTerminals(db, ws.id, now);
							await clearGuardAtStop(db, ws.id);
							record(ws.id, "stop resolved as stopped");
							await recordAudit(db, {
								actor: "worker",
								target: ws.id,
								action: "workspace.stop",
								result: "ok",
								metadata: {
									resolvedFromList: true,
								},
							});
						}
					} else if (inst.status === "Running") {
						const updated = await casUpdate(
							db,
							ws.id,
							"stopping",
							{ state: "running" },
							now,
						);
						if (updated) {
							ctx.transitions++;
							record(ws.id, "stop resolved as running");
							await recordAudit(db, {
								actor: "worker",
								target: ws.id,
								action: "workspace.observed_running",
								result: "ok",
								metadata: {
									resolvedFromList: true,
								},
							});
						}
					}
				}
			}
		}
	}

	return { lastRefreshAt: refreshAt, controllerUnreachable: unreachable, refreshError };
}

/**
 * Run one reconciliation sweep (ADR 0006; SPEC section 6.3-6.5, 25.3).
 *
 * Steps: (1) expire stale connections, (2) manage deadlines,
 * (3) drive state transitions, (4) periodic drift reconciliation,
 * (5) resolve timed-out starting/stopping rows.
 *
 * `controllerUnreachable` is the same field from the previous sweep, so
 * a controller outage is recorded once per failure streak (SPEC §25.4).
 */
export async function reconcile(
	db: Kysely<Database>,
	controller: ControllerClient,
	config: ReconcileConfig,
	now: Date,
	options: ReconcileOptions = {},
): Promise<SweepResult> {
	const log = options.log ?? silentLogger();
	// What this sweep decided per workspace, written out as debug lines at the
	// end so each live workspace gets exactly one line, "none" included.
	const actions = new Map<string, string[]>();
	const ctx: SweepContext = {
		db,
		controller,
		config,
		now,
		log,
		createRetryDelaysMs: options.createRetryDelaysMs ?? CREATE_RETRY_DELAYS_MS,
		transitions: 0,
		record: (id, action) => {
			const taken = actions.get(id);
			if (taken) taken.push(action);
			else actions.set(id, [action]);
		},
	};

	await expireConnections(ctx);
	// (1b) Keep running until: settle holds before the timers below.
	await settleKeepRunning(db, now);
	await trackDisconnections(ctx);

	// Snapshot every workspace after the deadline maths, so the debug lines
	// show the values the decisions below were made from. Only at debug: this
	// runs every second.
	const debugging = log.isLevelEnabled("debug");
	const snapshot = debugging
		? await db
				.selectFrom("workspaces")
				.select([
					"id",
					"state",
					"desired_state",
					"shutdown_deadline",
					"disconnected_at",
				])
				.execute()
		: [];

	// (3) Drive actionable state transitions.
	await createProvisioning(ctx);
	await startStopped(ctx);
	await stopRunning(ctx);
	await stopIdle(ctx);
	await retryErrored(ctx);
	await runMaintenance(ctx);

	const refresh = await refreshFromList(
		ctx,
		options.lastRefreshAt ?? null,
		options.controllerUnreachable ?? false,
	);

	if (debugging) {
		for (const ws of snapshot) {
			log.debug(
				{
					workspaceId: ws.id,
					state: ws.state,
					desiredState: ws.desired_state,
					shutdownDeadline: ws.shutdown_deadline,
					disconnectedAt: ws.disconnected_at,
					action: actions.get(ws.id)?.join(", ") ?? "none",
				},
				"workspace decision",
			);
		}
	}

	return { transitions: ctx.transitions, ...refresh };
}

/**
 * The zone the workspace's owner chose (issue #287). Anything missing or no
 * longer a known zone name reads as the platform default, so a start is
 * never held up by a stored value.
 */
async function ownerTimezone(
	db: Kysely<Database>,
	workspaceId: string,
): Promise<string> {
	const row = await db
		.selectFrom("workspaces")
		.innerJoin("users", "users.id", "workspaces.owner_user_id")
		.select("users.editor_settings")
		.where("workspaces.id", "=", workspaceId)
		.executeTakeFirst();
	const stored = row?.editor_settings?.timezone;
	return isSystemTimezone(stored) ? stored : DEFAULT_TIMEZONE;
}

/** The Docker size an administrator set on the row, else the default (SPEC.md §20.1). */
function dockerGiBOf(
	quota: { dockerGiB?: number } | null,
	config: ReconcileConfig,
): number {
	return quota?.dockerGiB ?? config.WORKSPACE_DOCKER_SIZE_GIB;
}

/** True for a failure that a later attempt may not hit: the controller was unreachable. */
function isTransient(err: ControllerClientError): boolean {
	return err.code === "INCUS_UNAVAILABLE";
}

/**
 * Create the Incus instance for a provisioning workspace and move it to
 * stopped, or to error if the create fails (SPEC.md §6.3). The controller
 * answers an existing instance with `created: false`, which is adopted like
 * a fresh one. Unreachable-controller failures are retried with backoff.
 * A full storage pool leaves the row in provisioning, to be tried again next
 * sweep (SPEC.md §20.1). Returns what happened for the debug line, or null if
 * the row moved on or nothing changed.
 */
async function createWorkspace(
	db: Kysely<Database>,
	controller: ControllerClient,
	config: ReconcileConfig,
	ws: { id: string; incus_instance_name: string; error_code: string | null },
	now: Date,
	retryDelaysMs: readonly number[],
): Promise<string | null> {
	const request = {
		name: ws.incus_instance_name,
		homeGiB: config.WORKSPACE_HOME_SIZE_GIB,
		dockerGiB: config.WORKSPACE_DOCKER_SIZE_GIB,
		recoveryGiB: config.WORKSPACE_RECOVERY_SIZE_GIB,
	};
	for (let attempt = 0; ; attempt++) {
		try {
			const result = await controller.create(request);
			const updated = await casUpdate(
				db,
				ws.id,
				"provisioning",
				{
					state: "stopped",
					image_version: result.imageFingerprint,
					quota_config: JSON.stringify({
						...result.quota,
						recoveryGiB: config.WORKSPACE_RECOVERY_SIZE_GIB,
					}),
					quota_applied: JSON.stringify(result.quota),
					error_code: null,
					error_message: null,
				},
				now,
			);
			if (!updated) return null;
			await recordAudit(db, {
				actor: "worker",
				target: ws.id,
				action: "workspace.provisioned",
				result: "ok",
				metadata: {
					imageFingerprint: result.imageFingerprint,
					created: result.created,
					attempts: attempt + 1,
				},
			});
			return result.created ? "created" : "adopted existing instance";
		} catch (e) {
			const err = toControllerError(e);
			const delay = retryDelaysMs[attempt];
			if (isTransient(err) && delay !== undefined) {
				await new Promise((resolve) => setTimeout(resolve, delay));
				continue;
			}
			if (err.code === "POOL_FULL") {
				// Audit only the first refusal, so a long wait is one row, not one per sweep.
				if (ws.error_code === "POOL_FULL") return null;
				const refused = await casUpdate(
					db,
					ws.id,
					"provisioning",
					{ error_code: err.code, error_message: userMessage(err.code) },
					now,
				);
				if (!refused) return null;
				await recordAudit(db, {
					actor: "worker",
					target: ws.id,
					action: "workspace.provision_refused",
					result: "refused",
					metadata: {
						errorCode: err.code,
					},
				});
				return "create refused: storage pool full";
			}
			const updated = await casUpdate(
				db,
				ws.id,
				"provisioning",
				{
					state: "error",
					error_code: err.code,
					error_message: userMessage(err.code),
				},
				now,
			);
			if (!updated) return null;
			await recordAudit(db, {
				actor: "worker",
				target: ws.id,
				action: "workspace.provision_failed",
				result: "failed",
				metadata: {
					errorCode: err.code,
					message: err.message,
					attempts: attempt + 1,
				},
			});
			return "create failed";
		}
	}
}

/**
 * Move a workspace from `fromState` into starting and start it. Returns
 * the number of state transitions made. Shared by the stopped->running
 * path and the retry-after-error path (SPEC.md §6.3).
 */
async function startWorkspace(
	db: Kysely<Database>,
	controller: ControllerClient,
	config: ReconcileConfig,
	ws: {
		id: string;
		incus_instance_name: string | null;
		label: string;
		quota_config: { dockerGiB?: number } | null;
	},
	fromState: string,
	now: Date,
): Promise<number> {
	if (!ws.incus_instance_name) return 0;

	const moved = await casUpdate(
		db,
		ws.id,
		fromState,
		{
			state: "starting",
			error_code: null,
			error_message: null,
			desired_state: settleRestarting,
			// A restart is a fresh session: stale timers must not stop it again.
			disconnected_at: null,
			shutdown_deadline: null,
		},
		now,
	);
	if (!moved) return 0;
	let transitions = 1;

	// Rotate before the start call so the row always holds the token the
	// agent is about to be given.
	const agentToken = await rotateAgentToken(db, ws.id);

	try {
		const result = await controller.start(ws.incus_instance_name, {
			timeoutSeconds: config.START_TIMEOUT_SECONDS,
			agentToken,
			hostname: ws.label,
			previewHostSuffix: config.PREVIEW_SUFFIX,
			timezone: await ownerTimezone(db, ws.id),
			dockerGiB: dockerGiBOf(ws.quota_config, config),
			recoveryGiB: config.WORKSPACE_RECOVERY_SIZE_GIB,
			cpuAllowance: await heldAllowance(db, ws.id),
			docker: await dockerStartConfig(db),
		});
		const updated = await casUpdate(
			db,
			ws.id,
			"starting",
			{ state: "running", agent_address: result.ipv4, ...startedNow(now) },
			now,
		);
		if (updated) {
			transitions++;
			await recordAudit(db, {
				actor: "worker",
				target: ws.id,
				action: "workspace.start",
				result: "ok",
				metadata: { ipv4: result.ipv4 },
			});
		}
	} catch (e) {
		const err = toControllerError(e);
		const updated = await casUpdate(
			db,
			ws.id,
			"starting",
			{
				state: "error",
				error_code: err.code,
				error_message: userMessage(err.code),
			},
			now,
		);
		if (updated) transitions++;
		await recordAudit(db, {
			actor: "worker",
			target: ws.id,
			action: "workspace.start_failed",
			result: "failed",
			metadata: {
				errorCode: err.code,
				message: err.message,
			},
		});
	}

	return transitions;
}

/** Stops still running, by workspace id; step 5 leaves these rows alone. */
const stopsInFlight = new Map<string, Promise<void>>();

/**
 * Start a stop without waiting for it, so a slow stop never delays the
 * next sweep's starts (SPEC.md §6.5). On worker exit it is abandoned and
 * step 5 resolves the row after the restart.
 */
function stopInBackground(
	db: Kysely<Database>,
	controller: ControllerClient,
	config: ReconcileConfig,
	ws: { id: string; incus_instance_name: string | null },
	log: Logger,
): void {
	const running = doStop(db, controller, config, ws)
		.catch((e: unknown) => {
			log.error(
				{ workspaceId: ws.id, error: errorMessage(e) },
				"background stop failed",
			);
		})
		.finally(() => {
			stopsInFlight.delete(ws.id);
		});
	stopsInFlight.set(ws.id, running);
}

/** Wait for every stop in flight to finish; for tests. */
export async function settleStops(): Promise<void> {
	await Promise.all(stopsInFlight.values());
}

/**
 * Execute a stop on a workspace that is already in 'stopping' state.
 * Exported for tests that need to drive it directly.
 */
export async function doStop(
	db: Kysely<Database>,
	controller: ControllerClient,
	config: ReconcileConfig,
	ws: { id: string; incus_instance_name: string | null },
): Promise<void> {
	if (!ws.incus_instance_name) return;
	try {
		const result = await controller.stop(
			ws.incus_instance_name,
			config.STOP_TIMEOUT_SECONDS,
		);
		await casUpdate(
			db,
			ws.id,
			"stopping",
			{
				state: "stopped",
				shutdown_deadline: null,
				desired_state: settleRestarting,
				disconnected_at: null,
			},
			// The stop may have taken minutes; stamp when it ended.
			new Date(),
		);
		// The stop happened, so record it even if another pass already
		// moved the row out of 'stopping' (SPEC.md §6.5).
		await recordAudit(db, {
			actor: "worker",
			target: ws.id,
			action: "workspace.stop",
			result: "ok",
			metadata: { forced: result.forced },
		});
		await clearGuardAtStop(db, ws.id);
		if (result.forced) {
			await recordAudit(db, {
				actor: "worker",
				target: ws.id,
				action: "workspace.force_stop",
				result: "ok",
			});
		}
	} catch (e) {
		const err = toControllerError(e);
		await casUpdate(
			db,
			ws.id,
			"stopping",
			{
				state: "error",
				error_code: err.code,
				error_message: userMessage(err.code),
			},
			// The stop may have taken minutes; stamp when it ended.
			new Date(),
		);
		await recordAudit(db, {
			actor: "worker",
			target: ws.id,
			action: "workspace.stop_failed",
			result: "failed",
			metadata: {
				errorCode: err.code,
				message: err.message,
			},
		});
	}
}

/** What the student sees when a maintenance operation fails (SPEC.md §28). */
const OPERATION_FAILED_MESSAGE: Record<PendingOperation, string> = {
	"reset-docker":
		"Docker could not be reset. Please try again or contact your administrator.",
	rebuild: "The workspace could not be rebuilt. Please contact your administrator.",
	"rebuild-reset-docker":
		"The workspace could not be rebuilt. Please contact your administrator.",
	// runReplaceHome in backups.ts writes its own message; this keeps the map whole.
	"replace-home":
		"Your home folder could not be replaced. Please contact your administrator.",
};

/**
 * Run one maintenance operation on a stopped or errored workspace, clear it,
 * and audit the result (SPEC.md §16.4, §17.2, §24.11; ADR 0021). A failure
 * clears it too, so a broken controller is not retried every second, and
 * leaves the workspace in error with a message for the student.
 */
async function runOperation(
	db: Kysely<Database>,
	controller: ControllerClient,
	ws: {
		id: string;
		incus_instance_name: string;
		state: string;
		pending_operation: PendingOperation;
		pending_operation_by: string | null;
		dockerGiB: number;
	},
	now: Date,
): Promise<number> {
	const clear = {
		pending_operation: null,
		pending_operation_at: null,
		pending_operation_by: null,
	};
	const isReset = ws.pending_operation === "reset-docker";
	const metadata = {
		operation: ws.pending_operation,
		requestedBy: ws.pending_operation_by,
	};
	try {
		let imageFingerprint: string | null = null;
		if (isReset) {
			await controller.resetDocker(ws.incus_instance_name, {
				dockerGiB: ws.dockerGiB,
			});
		} else {
			const result = await controller.rebuild(ws.incus_instance_name, {
				resetDocker: ws.pending_operation === "rebuild-reset-docker",
				dockerGiB: ws.dockerGiB,
			});
			imageFingerprint = result.imageFingerprint;
		}
		const updated = await casUpdate(
			db,
			ws.id,
			ws.state,
			{
				...clear,
				state: "stopped",
				error_code: null,
				error_message: null,
				...(imageFingerprint ? { image_version: imageFingerprint } : {}),
			},
			now,
		);
		await recordAudit(db, {
			actor: "worker",
			target: ws.id,
			action: isReset ? "workspace.docker_reset" : "workspace.rebuilt",
			result: "ok",
			metadata: imageFingerprint ? { ...metadata, imageFingerprint } : metadata,
		});
		return updated && ws.state !== "stopped" ? 1 : 0;
	} catch (e) {
		const err = toControllerError(e);
		const updated = await casUpdate(
			db,
			ws.id,
			ws.state,
			{
				...clear,
				state: "error",
				error_code: err.code,
				error_message: OPERATION_FAILED_MESSAGE[ws.pending_operation],
			},
			now,
		);
		await recordAudit(db, {
			actor: "worker",
			target: ws.id,
			action: isReset ? "workspace.docker_reset_failed" : "workspace.rebuild_failed",
			result: "failed",
			metadata: { ...metadata, errorCode: err.code },
		});
		return updated && ws.state !== "error" ? 1 : 0;
	}
}
