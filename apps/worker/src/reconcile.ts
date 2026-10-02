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
	clearGuardAtStop,
	createWorkspace,
	dockerGiBOf,
	endOpenTerminals,
	inFlightIds,
	moveToStarting,
	runInBackground,
	runOperation,
	startedNow,
	startInstance,
	stopInBackground,
	toControllerError,
	userMessage,
} from "./lifecycle.js";
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

/** How long an errored workspace rests before the sweep retries a start. */
const ERROR_RETRY_SECONDS = 10;

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

const INSTANCE_MISSING_MESSAGE =
	"Your workspace instance no longer exists. Please contact your administrator.";

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
		await startInBackground(ctx, ws, "stopped");
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
): Promise<void> {
	const { db, controller, config, now, log } = ctx;
	const name = ws.incus_instance_name;
	if (!name) return;
	if (!(await moveToStarting(db, ws.id, fromState, now))) return;
	ctx.transitions++;
	runInBackground(ws.id, "start", log, () =>
		startInstance(db, controller, config, { ...ws, incus_instance_name: name }),
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
	const { db, now, record } = ctx;
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
		.where(notInFlight())
		.execute();

	for (const ws of errorRetryStart) {
		record(ws.id, "retry start");
		await startInBackground(ctx, ws, "error");
	}

	// Note: error with desired=stopped is at rest (nothing to retry).
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

type ListedInstance = Awaited<ReturnType<ControllerClient["list"]>>[number];

interface TrackedRow {
	id: string;
	incus_instance_name: string;
	state: WorkspaceState;
	agent_address: string | null;
}

/** Step 4: the instance the row tracks is gone (SPEC §25.4). */
async function resolveMissingInstance(
	ctx: SweepContext,
	ws: TrackedRow,
): Promise<void> {
	const { db, now, record } = ctx;
	// An error row with no instance keeps its error, but its old address may be leased elsewhere.
	if (ws.state === "error") {
		if (ws.agent_address !== null) {
			await db
				.updateTable("workspaces")
				.set({ agent_address: null })
				.where("id", "=", ws.id)
				.execute();
		}
		return;
	}

	// Say so instead of reporting a state that cannot be true.
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
}

/** Step 4: keep the recorded agent address in step with the instance. */
async function syncAgentAddress(
	ctx: SweepContext,
	ws: TrackedRow,
	inst: ListedInstance,
): Promise<void> {
	// A stopped instance's old address may be leased to another student's instance.
	// A running instance briefly without an address keeps its last one.
	const address =
		inst.ipv4 ??
		(inst.status === "Running" && ws.state !== "error" ? ws.agent_address : null);
	if (address !== ws.agent_address) {
		await ctx.db
			.updateTable("workspaces")
			.set({ agent_address: address })
			.where("id", "=", ws.id)
			.execute();
	}
}

/** Step 4: a running or stopped row whose instance says otherwise. */
async function resolveDrift(
	ctx: SweepContext,
	ws: TrackedRow,
	inst: ListedInstance,
): Promise<void> {
	const { db, now, record } = ctx;
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
	if (ws.state === "stopped" && inst.status === "Running") {
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
}

/** Step 5: resolve a stale starting row. */
async function resolveStarting(
	ctx: SweepContext,
	ws: TrackedRow,
	inst: ListedInstance,
): Promise<void> {
	const { db, now, record } = ctx;
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

/** Step 5: resolve a stale stopping row. */
async function resolveStopping(
	ctx: SweepContext,
	ws: TrackedRow,
	inst: ListedInstance,
): Promise<void> {
	const { db, now, record } = ctx;
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
		const updated = await casUpdate(db, ws.id, "stopping", { state: "running" }, now);
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

/** Steps 4 and 5 for one tracked row with no controller call in flight. */
async function reconcileTracked(
	ctx: SweepContext,
	ws: TrackedRow,
	instanceMap: Map<string, ListedInstance>,
): Promise<void> {
	const inst = instanceMap.get(ws.incus_instance_name);
	if (!inst) {
		await resolveMissingInstance(ctx, ws);
		return;
	}
	await syncAgentAddress(ctx, ws, inst);
	await resolveDrift(ctx, ws, inst);
	if (ws.state === "starting") {
		await resolveStarting(ctx, ws, inst);
	}
	if (ws.state === "stopping") {
		await resolveStopping(ctx, ws, inst);
	}
}

/** Step 4: read list(), recording the start of an outage once (SPEC §25.4). */
async function listInstances(
	ctx: SweepContext,
	wasUnreachable: boolean,
): Promise<
	| { instances: ListedInstance[] }
	| { instances: null; refreshError: { code: string; message: string } }
> {
	try {
		return { instances: await ctx.controller.list() };
	} catch (e) {
		const err = toControllerError(e);
		if (!wasUnreachable) {
			ctx.log.error({ errorCode: err.code }, "controller unreachable");
			await recordAudit(ctx.db, {
				actor: "worker",
				target: "controller",
				action: "controller.unreachable",
				result: "failed",
				metadata: {
					errorCode: err.code,
				},
			});
		}
		return { instances: null, refreshError: { code: err.code, message: err.message } };
	}
}

/** Steps 4 and 5: reconcile drift from list() and resolve stale starting and stopping rows. */
async function refreshFromList(
	ctx: SweepContext,
	lastRefreshAt: Date | null,
	controllerUnreachable: boolean,
): Promise<Omit<SweepResult, "transitions">> {
	const { db, config, now } = ctx;
	// (4) Periodic drift reconciliation from list().
	const shouldRefresh =
		lastRefreshAt === null ||
		now.getTime() - lastRefreshAt.getTime() >= config.STATUS_REFRESH_SECONDS * 1000;
	if (!shouldRefresh) {
		return { lastRefreshAt, controllerUnreachable, refreshError: null };
	}

	// A call in flight, or one that ends while list() runs, leaves the list
	// older than the row, so those rows wait for the next refresh.
	const inFlightDuringList = new Set(inFlightIds());
	const listed = await listInstances(ctx, controllerUnreachable);
	if (listed.instances === null) {
		return {
			lastRefreshAt,
			controllerUnreachable: true,
			refreshError: listed.refreshError,
		};
	}

	const instanceMap = new Map(listed.instances.map((i) => [i.name, i]));
	// Find rows that might be drifted.
	const tracked = await db
		.selectFrom("workspaces")
		.select(["id", "incus_instance_name", "state", "agent_address"])
		.where("incus_instance_name", "is not", null)
		.where("state", "in", ["running", "stopped", "starting", "stopping", "error"])
		.execute();
	for (const ws of tracked) {
		if (!ws.incus_instance_name) continue;
		if (inFlightDuringList.has(ws.id)) continue;
		await reconcileTracked(
			ctx,
			{ ...ws, incus_instance_name: ws.incus_instance_name },
			instanceMap,
		);
	}

	// Only count a refresh that actually happened.
	return { lastRefreshAt: now, controllerUnreachable: false, refreshError: null };
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
