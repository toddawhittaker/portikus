import { randomBytes } from "node:crypto";
import {
	type ControllerErrorCode,
	DEFAULT_TIMEZONE,
	isSystemTimezone,
	type PendingOperation,
} from "@portikus/contracts";
import { type Database, recordAudit } from "@portikus/db";
import { errorMessage, type Logger } from "@portikus/observability";
import { type Kysely, sql } from "kysely";
import type { ControllerClient } from "./controller-client.js";
import { ControllerClientError } from "./controller-client.js";
import { dockerStartConfig } from "./docker-start.js";
import type { ReconcileConfig } from "./reconcile.js";

/**
 * Leaves desired_state alone unless it is still 'restarting', so a
 * connect that arrives while a slow stop is in flight is not overwritten
 * by a value read before the stop began (SPEC.md §6.3).
 */
export const settleRestarting = sql`case when desired_state = 'restarting' then 'running' else desired_state end`;

/** Maps controller error codes to user-friendly messages (SPEC section 28). */
export function userMessage(code: ControllerErrorCode): string {
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
export function toControllerError(e: unknown): ControllerClientError {
	return e instanceof ControllerClientError
		? e
		: new ControllerClientError("OPERATION_FAILED", String(e));
}

/**
 * Compare-and-set update: transitions a workspace from one state to
 * another only if the current state matches. Returns the updated row
 * or null if someone else changed it first.
 */
export async function casUpdate(
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
export async function endOpenTerminals(
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
export async function clearGuardAtStop(
	db: Kysely<Database>,
	id: string,
): Promise<void> {
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
export function startedNow(now: Date): Record<string, unknown> {
	return { last_activity_at: now.toISOString(), idle_stop_at: null };
}

/**
 * The zone the workspace's owner chose. Anything missing or no
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
export function dockerGiBOf(
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
export async function createWorkspace(
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
export async function startWorkspace(
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
export const stopsInFlight = new Map<string, Promise<void>>();

/**
 * Start a stop without waiting for it, so a slow stop never delays the
 * next sweep's starts (SPEC.md §6.5). On worker exit it is abandoned and
 * step 5 resolves the row after the restart.
 */
export function stopInBackground(
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
export async function runOperation(
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
