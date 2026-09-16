import type { ControllerErrorCode } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { Kysely } from "kysely";
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
}

export interface SweepResult {
	transitions: number;
	lastRefreshAt: Date | null;
}

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
): Promise<{ id: string } | null> {
	const rows = await db
		.updateTable("workspaces")
		.set({
			...updates,
			updated_at: new Date().toISOString(),
		})
		.where("id", "=", id)
		.where("state", "=", fromState)
		.returning("id")
		.execute();
	return rows[0] ?? null;
}

/**
 * Run one reconciliation sweep (ADR 0006; SPEC section 6.3-6.5, 25.3).
 *
 * Steps: (1) expire stale connections, (2) manage deadlines,
 * (3) drive state transitions, (4) periodic drift reconciliation,
 * (5) resolve timed-out starting/stopping rows.
 */
export async function reconcile(
	db: Kysely<Database>,
	controller: ControllerClient,
	config: ReconcileConfig,
	now: Date,
	lastRefreshAt: Date | null = null,
): Promise<SweepResult> {
	let transitions = 0;
	let refreshAt = lastRefreshAt;

	// (1) Delete stale workspace_connections rows.
	const ttlCutoff = new Date(now.getTime() - config.PRESENCE_TTL_SECONDS * 1000);
	await db
		.deleteFrom("workspace_connections")
		.where("last_seen_at", "<", ttlCutoff)
		.execute();

	// (2) Manage shutdown deadlines for running workspaces.
	const runningRows = await db
		.selectFrom("workspaces")
		.select(["id", "shutdown_deadline"])
		.where("state", "=", "running")
		.execute();

	for (const ws of runningRows) {
		const conns = await db
			.selectFrom("workspace_connections")
			.select(db.fn.countAll<string>().as("cnt"))
			.where("workspace_id", "=", ws.id)
			.executeTakeFirstOrThrow();
		const active = Number(conns.cnt);

		if (active === 0 && ws.shutdown_deadline === null) {
			// Set deadline.
			const deadline = new Date(now.getTime() + config.SHUTDOWN_GRACE_SECONDS * 1000);
			await db
				.updateTable("workspaces")
				.set({
					shutdown_deadline: deadline.toISOString(),
					updated_at: now.toISOString(),
				})
				.where("id", "=", ws.id)
				.where("state", "=", "running")
				.execute();
		} else if (active > 0 && ws.shutdown_deadline !== null) {
			// Clear deadline.
			await db
				.updateTable("workspaces")
				.set({
					shutdown_deadline: null,
					updated_at: now.toISOString(),
				})
				.where("id", "=", ws.id)
				.where("state", "=", "running")
				.execute();
		}
	}

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
			const updated = await casUpdate(db, ws.id, "provisioning", {
				state: "stopped",
				image_version: result.imageFingerprint,
				quota_config: JSON.stringify(result.quota),
				error_code: null,
				error_message: null,
			});
			if (updated) {
				transitions++;
				await audit(db, ws.id, "workspace.provisioned", "ok", {
					imageFingerprint: result.imageFingerprint,
				});
			}
		} catch (e) {
			const err =
				e instanceof ControllerClientError
					? e
					: new ControllerClientError("OPERATION_FAILED", String(e));
			const updated = await casUpdate(db, ws.id, "provisioning", {
				state: "error",
				error_code: err.code,
				error_message: userMessage(err.code),
			});
			if (updated) {
				transitions++;
				await audit(db, ws.id, "workspace.provision_failed", "failed", {
					errorCode: err.code,
				});
			}
		}
	}

	// 3b: stopped with desired running -> starting -> start -> running/error
	const toStart = await db
		.selectFrom("workspaces")
		.select(["id", "incus_instance_name"])
		.where("state", "=", "stopped")
		.where("desired_state", "=", "running")
		.execute();

	for (const ws of toStart) {
		if (!ws.incus_instance_name) continue;
		const moved = await casUpdate(db, ws.id, "stopped", {
			state: "starting",
			error_code: null,
			error_message: null,
		});
		if (!moved) continue;
		transitions++;

		try {
			const result = await controller.start(
				ws.incus_instance_name,
				config.START_TIMEOUT_SECONDS,
			);
			const updated = await casUpdate(db, ws.id, "starting", {
				state: "running",
			});
			if (updated) {
				transitions++;
				await audit(db, ws.id, "workspace.start", "ok", {
					ipv4: result.ipv4,
				});
			}
		} catch (e) {
			const err =
				e instanceof ControllerClientError
					? e
					: new ControllerClientError("OPERATION_FAILED", String(e));
			const updated = await casUpdate(db, ws.id, "starting", {
				state: "error",
				error_code: err.code,
				error_message: userMessage(err.code),
			});
			if (updated) {
				transitions++;
				await audit(db, ws.id, "workspace.start_failed", "failed", {
					errorCode: err.code,
				});
			}
		}
	}

	// 3c: running -> stopping (desired stopped/restarting, or deadline passed)
	// First: explicit desired stopped or restarting.
	const toStopExplicit = await db
		.selectFrom("workspaces")
		.select(["id", "incus_instance_name", "desired_state"])
		.where("state", "=", "running")
		.where("desired_state", "in", ["stopped", "restarting"])
		.execute();

	for (const ws of toStopExplicit) {
		if (!ws.incus_instance_name) continue;
		const moved = await casUpdate(db, ws.id, "running", {
			state: "stopping",
		});
		if (!moved) continue;
		transitions++;
		await doStop(db, controller, config, ws);
	}

	// Deadline passed with zero connections: single UPDATE with count subquery.
	const deadlinePassed = await db
		.updateTable("workspaces")
		.set({
			state: "stopping",
			desired_state: "stopped",
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
		.returning(["id", "incus_instance_name", "desired_state"])
		.execute();

	for (const ws of deadlinePassed) {
		transitions++;
		if (!ws.incus_instance_name) continue;
		await doStop(db, controller, config, ws);
	}

	// 3d: error with changed desired_state -> retry
	const errorRetryStart = await db
		.selectFrom("workspaces")
		.select(["id", "incus_instance_name"])
		.where("state", "=", "error")
		.where("desired_state", "=", "running")
		.execute();

	for (const ws of errorRetryStart) {
		if (!ws.incus_instance_name) continue;
		const moved = await casUpdate(db, ws.id, "error", {
			state: "starting",
			error_code: null,
			error_message: null,
		});
		if (!moved) continue;
		transitions++;

		try {
			const result = await controller.start(
				ws.incus_instance_name,
				config.START_TIMEOUT_SECONDS,
			);
			const updated = await casUpdate(db, ws.id, "starting", {
				state: "running",
			});
			if (updated) {
				transitions++;
				await audit(db, ws.id, "workspace.start", "ok", {
					ipv4: result.ipv4,
				});
			}
		} catch (e) {
			const err =
				e instanceof ControllerClientError
					? e
					: new ControllerClientError("OPERATION_FAILED", String(e));
			await casUpdate(db, ws.id, "starting", {
				state: "error",
				error_code: err.code,
				error_message: userMessage(err.code),
			});
		}
	}

	// Note: error with desired=stopped is at rest (nothing to retry).
	// The retry path only fires for desired=running, which indicates
	// the user has actively requested a new start attempt.

	// (4) Periodic drift reconciliation from list().
	const shouldRefresh =
		refreshAt === null ||
		now.getTime() - refreshAt.getTime() >= config.STATUS_REFRESH_SECONDS * 1000;

	if (shouldRefresh) {
		refreshAt = now;
		try {
			const instances = await controller.list();
			const instanceMap = new Map(instances.map((i) => [i.name, i]));

			// Find rows that might be drifted.
			const tracked = await db
				.selectFrom("workspaces")
				.select(["id", "incus_instance_name", "state"])
				.where("incus_instance_name", "is not", null)
				.where("state", "in", ["running", "stopped", "starting", "stopping"])
				.execute();

			for (const ws of tracked) {
				if (!ws.incus_instance_name) continue;
				const inst = instanceMap.get(ws.incus_instance_name);
				if (!inst) continue;

				// Drift: row says running but instance is Stopped.
				if (ws.state === "running" && inst.status === "Stopped") {
					const updated = await casUpdate(db, ws.id, "running", {
						state: "stopped",
						shutdown_deadline: null,
					});
					if (updated) {
						transitions++;
						await audit(db, ws.id, "workspace.observed_stopped", "ok");
					}
				}

				// Drift: row says stopped but instance is Running.
				if (ws.state === "stopped" && inst.status === "Running") {
					const updated = await casUpdate(db, ws.id, "stopped", { state: "running" });
					if (updated) {
						transitions++;
						await audit(db, ws.id, "workspace.observed_running", "ok");
					}
				}

				// (5) Resolve stale starting/stopping rows.
				if (ws.state === "starting") {
					if (inst.status === "Running") {
						const updated = await casUpdate(db, ws.id, "starting", {
							state: "running",
						});
						if (updated) {
							transitions++;
							await audit(db, ws.id, "workspace.start", "ok", {
								resolvedFromList: true,
							});
						}
					} else if (inst.status === "Stopped") {
						const updated = await casUpdate(db, ws.id, "starting", {
							state: "error",
							error_code: "OPERATION_FAILED",
							error_message: userMessage("OPERATION_FAILED"),
						});
						if (updated) {
							transitions++;
							await audit(db, ws.id, "workspace.start_failed", "failed", {
								resolvedFromList: true,
							});
						}
					}
				}

				if (ws.state === "stopping") {
					if (inst.status === "Stopped") {
						const updated = await casUpdate(db, ws.id, "stopping", {
							state: "stopped",
							shutdown_deadline: null,
						});
						if (updated) {
							transitions++;
							await audit(db, ws.id, "workspace.stop", "ok", {
								resolvedFromList: true,
							});
						}
					} else if (inst.status === "Running") {
						const updated = await casUpdate(db, ws.id, "stopping", {
							state: "running",
						});
						if (updated) {
							transitions++;
							await audit(db, ws.id, "workspace.observed_running", "ok", {
								resolvedFromList: true,
							});
						}
					}
				}
			}
		} catch {
			// Controller unavailable during refresh; skip and retry next cycle.
		}
	}

	return { transitions, lastRefreshAt: refreshAt };
}

/** Execute a stop on a workspace that is already in 'stopping' state. */
async function doStop(
	db: Kysely<Database>,
	controller: ControllerClient,
	config: ReconcileConfig,
	ws: { id: string; incus_instance_name: string | null; desired_state: string },
): Promise<void> {
	if (!ws.incus_instance_name) return;
	try {
		const result = await controller.stop(
			ws.incus_instance_name,
			config.STOP_TIMEOUT_SECONDS,
		);
		const wasRestarting = ws.desired_state === "restarting";
		const updated = await casUpdate(db, ws.id, "stopping", {
			state: "stopped",
			shutdown_deadline: null,
			desired_state: wasRestarting ? "running" : "stopped",
		});
		if (updated) {
			await audit(db, ws.id, "workspace.stop", "ok", {
				forced: result.forced,
			});
			if (result.forced) {
				await audit(db, ws.id, "workspace.force_stop", "ok");
			}
		}
	} catch (e) {
		const err =
			e instanceof ControllerClientError
				? e
				: new ControllerClientError("OPERATION_FAILED", String(e));
		await casUpdate(db, ws.id, "stopping", {
			state: "error",
			error_code: err.code,
			error_message: userMessage(err.code),
		});
		await audit(db, ws.id, "workspace.stop_failed", "failed", {
			errorCode: err.code,
		});
	}
}
