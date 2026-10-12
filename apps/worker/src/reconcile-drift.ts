// Steps 4 and 5 of a sweep: drift from the controller's list() and stale starting or stopping rows (ADR 0006).
import { STOP_FAILED_ERROR_CODE, type WorkspaceState } from "@portikus/contracts";
import { recordAudit } from "@portikus/db";
import type { ControllerClient } from "./controller-client.js";
import {
	casUpdate,
	clearGuardAtStop,
	endOpenTerminals,
	inFlightIds,
	startedNow,
	stopInBackground,
	toControllerError,
	userMessage,
} from "./lifecycle.js";
import type { SweepContext, SweepResult } from "./reconcile.js";

const INSTANCE_MISSING_MESSAGE =
	"Your workspace instance no longer exists. Please contact your administrator.";

type ListedInstance = Awaited<ReturnType<ControllerClient["list"]>>[number];

interface TrackedRow {
	id: string;
	incus_instance_name: string;
	state: WorkspaceState;
	desired_state: string;
	agent_address: string | null;
	error_code: string | null;
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
	// Stop on an errored workspace whose instance still runs (SPEC.md §6.5).
	// A failed stop is tried once per Stop; the student's next Stop clears it.
	if (
		ws.state === "error" &&
		ws.desired_state === "stopped" &&
		ws.error_code !== STOP_FAILED_ERROR_CODE &&
		inst.status === "Running"
	) {
		// Inline so a Start pressed since the read wins over this stop.
		const updated = await db
			.updateTable("workspaces")
			.set({
				state: "stopping",
				error_code: null,
				error_message: null,
				updated_at: now.toISOString(),
			})
			.where("id", "=", ws.id)
			.where("state", "=", "error")
			.where("desired_state", "=", "stopped")
			.returning("id")
			.executeTakeFirst();
		if (updated) {
			ctx.transitions++;
			record(ws.id, "stop errored instance");
			await endOpenTerminals(db, ws.id, now);
			stopInBackground(db, ctx.controller, ctx.config, ws, ctx.log);
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
export async function refreshFromList(
	ctx: SweepContext,
	lastRefreshAt: Date | null,
	controllerUnreachable: boolean,
): Promise<Omit<SweepResult, "transitions">> {
	const { db, config, now } = ctx;
	// (4) Periodic drift reconciliation from list(). A refresh in the future
	// means the clock was stepped back, so it is stale too.
	const sinceRefresh =
		lastRefreshAt === null ? null : now.getTime() - lastRefreshAt.getTime();
	const shouldRefresh =
		sinceRefresh === null ||
		sinceRefresh < 0 ||
		sinceRefresh >= config.STATUS_REFRESH_SECONDS * 1000;
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

	// The API marks workspace state unconfirmed when this is older than two
	// minutes (SPEC.md 18.3).
	await db
		.updateTable("settings")
		.set({ controller_checked_at: now.toISOString() })
		.where("id", "=", 1)
		.execute();

	const instanceMap = new Map(listed.instances.map((i) => [i.name, i]));
	// Find rows that might be drifted.
	const tracked = await db
		.selectFrom("workspaces")
		.select([
			"id",
			"incus_instance_name",
			"state",
			"desired_state",
			"agent_address",
			"error_code",
		])
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
