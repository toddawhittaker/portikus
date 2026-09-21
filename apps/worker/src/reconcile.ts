import { randomBytes } from "node:crypto";
import {
	type ControllerErrorCode,
	DEFAULT_TIMEZONE,
	isSystemTimezone,
} from "@portikus/contracts";
import type { Database } from "@portikus/db";
import { type Logger, silentLogger } from "@portikus/observability";
import { type ExpressionBuilder, type Kysely, sql } from "kysely";
import type { ControllerClient } from "./controller-client.js";
import { ControllerClientError } from "./controller-client.js";

/** Config values the reconciler reads. */
export interface ReconcileConfig {
	PRESENCE_TTL_SECONDS: number;
	SHUTDOWN_GRACE_SECONDS: number;
	START_TIMEOUT_SECONDS: number;
	STOP_TIMEOUT_SECONDS: number;
	STATUS_REFRESH_SECONDS: number;
	WORKSPACE_HOME_SIZE_GIB: number;
	WORKSPACE_DOCKER_SIZE_GIB: number;
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

/** How long an errored workspace rests before the sweep retries a start. */
const ERROR_RETRY_SECONDS = 10;

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

/** Write an audit_events row. */
async function audit(
	db: Kysely<Database>,
	target: string,
	action: string,
	result: string,
	metadata?: Record<string, unknown>,
): Promise<void> {
	await db
		.insertInto("audit_events")
		.values({
			actor: "worker",
			target,
			action,
			result,
			metadata: metadata ? JSON.stringify(metadata) : null,
		})
		.execute();
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
	lastRefreshAt: Date | null = null,
	controllerUnreachable = false,
	log: Logger = silentLogger(),
): Promise<SweepResult> {
	let transitions = 0;
	// What this sweep decided per workspace, written out as debug lines at the
	// end so each live workspace gets exactly one line, "none" included.
	const actions = new Map<string, string[]>();
	const record = (id: string, action: string): void => {
		const taken = actions.get(id);
		if (taken) taken.push(action);
		else actions.set(id, [action]);
	};
	let refreshAt = lastRefreshAt;
	let unreachable = controllerUnreachable;
	let refreshError: { code: string; message: string } | null = null;

	// (1) Delete stale workspace_connections rows.
	const ttlCutoff = new Date(now.getTime() - config.PRESENCE_TTL_SECONDS * 1000);
	await db
		.deleteFrom("workspace_connections")
		.where("last_seen_at", "<", ttlCutoff)
		.execute();

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
				case when ${grace} = 0 then null
					else ws.disconnected_at + ${grace} * interval '1 second' end as new_deadline
			from workspaces ws
			join users u on u.id = ws.owner_user_id
			left join settings s on s.id = 1
			where ws.state = 'running' and ws.disconnected_at is not null
		) d
		where w.id = d.id and w.shutdown_deadline is distinct from d.new_deadline
	`.execute(db);

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

	// 3a: provisioning -> create -> stopped/error
	const provisioning = await db
		.selectFrom("workspaces")
		.select(["id", "incus_instance_name"])
		.where("state", "=", "provisioning")
		.execute();

	for (const ws of provisioning) {
		if (!ws.incus_instance_name) continue;
		try {
			const result = await controller.create({
				name: ws.incus_instance_name,
				homeGiB: config.WORKSPACE_HOME_SIZE_GIB,
				dockerGiB: config.WORKSPACE_DOCKER_SIZE_GIB,
			});
			const updated = await casUpdate(
				db,
				ws.id,
				"provisioning",
				{
					state: "stopped",
					image_version: result.imageFingerprint,
					quota_config: JSON.stringify(result.quota),
					error_code: null,
					error_message: null,
				},
				now,
			);
			if (updated) {
				transitions++;
				record(ws.id, "created");
				await audit(db, ws.id, "workspace.provisioned", "ok", {
					imageFingerprint: result.imageFingerprint,
				});
			}
		} catch (e) {
			const err = toControllerError(e);
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
			if (updated) {
				transitions++;
				record(ws.id, "create failed");
				await audit(db, ws.id, "workspace.provision_failed", "failed", {
					errorCode: err.code,
					message: err.message,
				});
			}
		}
	}

	// 3b: stopped with desired running (or restarting) -> start.
	const toStart = await db
		.selectFrom("workspaces")
		.select(["id", "incus_instance_name", "label"])
		.where("state", "=", "stopped")
		.where("desired_state", "in", ["running", "restarting"])
		.execute();

	for (const ws of toStart) {
		record(ws.id, "start");
		transitions += await startWorkspace(db, controller, config, ws, "stopped", now);
	}

	// 3c: running -> stopping (desired stopped/restarting, or deadline passed)
	// First: explicit desired stopped or restarting.
	const toStopExplicit = await db
		.selectFrom("workspaces")
		.select(["id", "incus_instance_name"])
		.where("state", "=", "running")
		.where("desired_state", "in", ["stopped", "restarting"])
		.execute();

	for (const ws of toStopExplicit) {
		if (!ws.incus_instance_name) continue;
		const moved = await casUpdate(db, ws.id, "running", { state: "stopping" }, now);
		if (!moved) continue;
		transitions++;
		record(ws.id, "stop requested");
		await endOpenTerminals(db, ws.id, now);
		await doStop(db, controller, config, ws, now);
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
		transitions++;
		record(ws.id, "stop after grace period");
		await endOpenTerminals(db, ws.id, now);
		if (!ws.incus_instance_name) continue;
		await doStop(db, controller, config, ws, now);
	}

	// 3d: error with desired running (or restarting) -> retry a start, but
	// only after a short rest so a broken controller is not hammered.
	const retryCutoff = new Date(now.getTime() - ERROR_RETRY_SECONDS * 1000);
	const errorRetryStart = await db
		.selectFrom("workspaces")
		.select(["id", "incus_instance_name", "label"])
		.where("state", "=", "error")
		.where("desired_state", "in", ["running", "restarting"])
		.where("updated_at", "<", retryCutoff)
		.execute();

	for (const ws of errorRetryStart) {
		record(ws.id, "retry start");
		transitions += await startWorkspace(db, controller, config, ws, "error", now);
	}

	// Note: error with desired=stopped is at rest (nothing to retry).

	// (4) Periodic drift reconciliation from list().
	const shouldRefresh =
		refreshAt === null ||
		now.getTime() - refreshAt.getTime() >= config.STATUS_REFRESH_SECONDS * 1000;

	if (shouldRefresh) {
		let instances: Awaited<ReturnType<ControllerClient["list"]>> | null = null;
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
				await audit(db, "controller", "controller.unreachable", "failed", {
					errorCode: err.code,
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
				.where("state", "in", ["running", "stopped", "starting", "stopping"])
				.execute();

			for (const ws of tracked) {
				if (!ws.incus_instance_name) continue;
				const inst = instanceMap.get(ws.incus_instance_name);

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
						transitions++;
						await endOpenTerminals(db, ws.id, now);
						record(ws.id, "instance missing");
						await audit(db, ws.id, "workspace.instance_missing", "failed", {
							instanceName: ws.incus_instance_name,
						});
					}
					continue;
				}

				// Keep the recorded agent address in step with the instance.
				if (inst.ipv4 && inst.ipv4 !== ws.agent_address) {
					await db
						.updateTable("workspaces")
						.set({ agent_address: inst.ipv4 })
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
						transitions++;
						await endOpenTerminals(db, ws.id, now);
						record(ws.id, "observed stopped");
						await audit(db, ws.id, "workspace.observed_stopped", "ok");
					}
				}

				// Drift: row says stopped but instance is Running.
				if (ws.state === "stopped" && inst.status === "Running") {
					const updated = await casUpdate(
						db,
						ws.id,
						"stopped",
						{ state: "running" },
						now,
					);
					if (updated) {
						transitions++;
						record(ws.id, "observed running");
						await audit(db, ws.id, "workspace.observed_running", "ok");
					}
				}

				// (5) Resolve stale starting/stopping rows.
				if (ws.state === "starting") {
					if (inst.status === "Running") {
						const updated = await casUpdate(
							db,
							ws.id,
							"starting",
							{ state: "running" },
							now,
						);
						if (updated) {
							transitions++;
							record(ws.id, "start resolved as running");
							await audit(db, ws.id, "workspace.start", "ok", {
								resolvedFromList: true,
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
							transitions++;
							await endOpenTerminals(db, ws.id, now);
							record(ws.id, "start resolved as failed");
							await audit(db, ws.id, "workspace.start_failed", "failed", {
								resolvedFromList: true,
							});
						}
					}
				}

				if (ws.state === "stopping") {
					if (inst.status === "Stopped") {
						const updated = await casUpdate(
							db,
							ws.id,
							"stopping",
							{ state: "stopped", shutdown_deadline: null, disconnected_at: null },
							now,
						);
						if (updated) {
							transitions++;
							await endOpenTerminals(db, ws.id, now);
							record(ws.id, "stop resolved as stopped");
							await audit(db, ws.id, "workspace.stop", "ok", {
								resolvedFromList: true,
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
							transitions++;
							record(ws.id, "stop resolved as running");
							await audit(db, ws.id, "workspace.observed_running", "ok", {
								resolvedFromList: true,
							});
						}
					}
				}
			}
		}
	}

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

	return {
		transitions,
		lastRefreshAt: refreshAt,
		controllerUnreachable: unreachable,
		refreshError,
	};
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
	return isSystemTimezone(stored) ? (stored as string) : DEFAULT_TIMEZONE;
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
	ws: { id: string; incus_instance_name: string | null; label: string },
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
		});
		const updated = await casUpdate(
			db,
			ws.id,
			"starting",
			{ state: "running", agent_address: result.ipv4 },
			now,
		);
		if (updated) {
			transitions++;
			await audit(db, ws.id, "workspace.start", "ok", { ipv4: result.ipv4 });
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
		await audit(db, ws.id, "workspace.start_failed", "failed", {
			errorCode: err.code,
			message: err.message,
		});
	}

	return transitions;
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
	now: Date,
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
			now,
		);
		// The stop happened, so record it even if another pass already
		// moved the row out of 'stopping' (SPEC.md §6.5).
		await audit(db, ws.id, "workspace.stop", "ok", { forced: result.forced });
		if (result.forced) {
			await audit(db, ws.id, "workspace.force_stop", "ok");
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
			now,
		);
		await audit(db, ws.id, "workspace.stop_failed", "failed", {
			errorCode: err.code,
			message: err.message,
		});
	}
}
