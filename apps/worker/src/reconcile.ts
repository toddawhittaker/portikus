import {
	DEFAULT_KEEP_RUNNING_MAX_HOURS,
	PendingOperation,
	type WorkspaceState,
} from "@portikus/contracts";
import { type Database, recordAudit } from "@portikus/db";
import { type Logger, silentLogger } from "@portikus/observability";
import { type ExpressionBuilder, type Kysely, sql } from "kysely";
import { runReplaceHome } from "./backups.js";
import type { ControllerClient } from "./controller-client.js";
import {
	casUpdate,
	createWorkspace,
	dockerGiBOf,
	endOpenTerminals,
	inFlightIds,
	moveToStarting,
	runInBackground,
	runOperation,
	startInstance,
	stopInBackground,
} from "./lifecycle.js";
import { refreshFromList } from "./reconcile-drift.js";
import { rebuildPointsDone } from "./recovery.js";
import { MAX_START_RETRIES, retryWaitMs } from "./start-backoff.js";

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

export interface SweepResult {
	transitions: number;
	lastRefreshAt: Date | null;
	/** True when the last status refresh could not reach the controller. */
	controllerUnreachable: boolean;
	/** Details of that failure, for the caller to log. */
	refreshError: { code: string; message: string } | null;
}

/** How long "Still working?" shows before an idle workspace stops; fixed (ADR 0032). */
const IDLE_WARNING_MS = 5 * 60_000;

/**
 * Waits between create attempts when the controller is unreachable, so a
 * controller restart during a deploy does not leave a workspace in error.
 */
const CREATE_RETRY_DELAYS_MS: readonly number[] = [1000, 2000, 4000, 8000];

/**
 * Only rows with no controller call in flight, so a row never gets two
 * calls at once (SPEC.md §6.5; ADR 0034).
 */
function notInFlight() {
	return sql<boolean>`workspaces.id <> all(${inFlightIds()}::uuid[])`;
}

/**
 * Settle every "keep running until" hold. A hold
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
export interface SweepContext {
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
	const { db, controller, config, log, createRetryDelaysMs, record } = ctx;
	// 3a: provisioning -> create -> stopped/error
	const provisioning = await db
		.selectFrom("workspaces")
		.select(["id", "incus_instance_name", "error_code", "quota_config"])
		.where("state", "=", "provisioning")
		.where(notInFlight())
		.execute();

	for (const ws of provisioning) {
		const name = ws.incus_instance_name;
		if (!name) continue;
		record(ws.id, "create");
		runInBackground(ws.id, "create", log, async () => {
			const outcome = await createWorkspace(
				db,
				controller,
				config,
				{ ...ws, incus_instance_name: name },
				createRetryDelaysMs,
			);
			if (outcome)
				log.debug({ workspaceId: ws.id, action: outcome }, "create finished");
		});
	}
}

/** Step 3b: start stopped workspaces that should run. */
async function startStopped(ctx: SweepContext): Promise<void> {
	const { db, record } = ctx;
	// 3b: stopped with desired running (or restarting) -> start. A pending
	// maintenance operation runs first (ADR 0021).
	const toStart = await db
		.selectFrom("workspaces")
		.select(["id", "incus_instance_name", "label", "quota_config"])
		.where("state", "=", "stopped")
		.where("desired_state", "in", ["running", "restarting"])
		.where("pending_operation", "is", null)
		.where("archived_at", "is", null)
		.where(notInFlight())
		.execute();

	for (const ws of toStart) {
		record(ws.id, "start");
		await startInBackground(ctx, ws, "stopped", false);
	}
}

/** Move a row into starting, then make the start call in the background. */
async function startInBackground(
	ctx: SweepContext,
	ws: {
		id: string;
		incus_instance_name: string | null;
		label: string;
		quota_config: { dockerGiB?: number; recoveryGiB?: number } | null;
	},
	fromState: WorkspaceState,
	lastRetry: boolean,
): Promise<void> {
	const { db, controller, config, now, log } = ctx;
	const name = ws.incus_instance_name;
	if (!name) return;
	if (!(await moveToStarting(db, ws.id, fromState, now))) return;
	ctx.transitions++;
	runInBackground(ws.id, "start", log, () =>
		startInstance(
			db,
			controller,
			config,
			{ ...ws, incus_instance_name: name },
			log,
			lastRetry,
		),
	);
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
		.where(notInFlight())
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
		.where(notInFlight())
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
		.where(notInFlight())
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
			and w.id <> all(${inFlightIds()}::uuid[])
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
	const { db, now, record, log } = ctx;
	// 3d: error with desired running (or restarting) -> retry a start, after
	// a wait that grows with each retry, at most MAX_START_RETRIES times.
	const errorRetryStart = await db
		.selectFrom("workspaces")
		.select([
			"id",
			"incus_instance_name",
			"label",
			"quota_config",
			"start_retries",
			"updated_at",
		])
		.where("state", "=", "error")
		.where("desired_state", "in", ["running", "restarting"])
		.where("start_retries", "<", MAX_START_RETRIES)
		.where("pending_operation", "is", null)
		.where("archived_at", "is", null)
		.where(notInFlight())
		.execute();

	for (const ws of errorRetryStart) {
		const wait = retryWaitMs(ws.start_retries);
		if (wait === null || ws.updated_at.getTime() + wait > now.getTime()) continue;
		const attempt = ws.start_retries + 1;
		record(ws.id, "retry start");
		log.info({ workspaceId: ws.id, attempt }, "retrying a failed start");
		await startInBackground(ctx, ws, "error", attempt === MAX_START_RETRIES);
	}

	// Error with desired stopped is at rest here; step 4 stops an instance
	// that still runs, since only list() knows whether it does.
}

/** Step 3e: run a pending maintenance operation. */
async function runMaintenance(ctx: SweepContext): Promise<void> {
	const { db, controller, config, now, log, record } = ctx;
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
		.where(notInFlight())
		.execute();

	for (const ws of toMaintain) {
		const instance = ws.incus_instance_name;
		if (!instance || !ws.pending_operation) continue;
		record(ws.id, ws.pending_operation);
		// Replace home spans several sweeps while the host imports (ADR 0040).
		if (ws.pending_operation === "replace-home") {
			runInBackground(ws.id, ws.pending_operation, log, async () => {
				await runReplaceHome(
					db,
					controller,
					{
						id: ws.id,
						instance,
						state: ws.state,
						pendingAt: ws.pending_operation_at,
						pendingBy: ws.pending_operation_by,
						args: ws.pending_operation_args,
					},
					now,
				);
			});
			continue;
		}
		const operation = {
			id: ws.id,
			incus_instance_name: instance,
			state: ws.state,
			// The column has a check constraint, so this never throws.
			pending_operation: PendingOperation.parse(ws.pending_operation),
			pending_operation_by: ws.pending_operation_by,
			dockerGiB: dockerGiBOf(ws.quota_config, config),
		};
		runInBackground(ws.id, ws.pending_operation, log, async () => {
			await runOperation(db, controller, operation);
		});
	}
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
