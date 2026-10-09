import { callAgent } from "@portikus/agent-client";
import { AgentProtectedProcesses, type InstanceProcess } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { Logger } from "@portikus/observability";
import { type Kysely, sql } from "kysely";
import { type ControllerClient, ControllerClientError } from "./controller-client.js";
import { startLoop } from "./loop.js";

/** How often the worker looks for a pending Refresh (ADR 0037). */
const PROCESS_SNAPSHOT_TICK_MS = 1000;

/** How long one controller read may take before it is recorded as a timeout. */
const PROCESS_SNAPSHOT_TIMEOUT_MS = 10_000;

/** How long the agent may take to name its protected processes. */
const PROTECTED_TIMEOUT_MS = 3000;

/** A protected process as "pid:startTicks", so a reused PID never matches. */
type ProtectedSet = ReadonlySet<string>;
type ReadProtected = (address: string, token: string) => Promise<ProtectedSet | null>;

/**
 * `GET /processes/protected` on one agent: the set its stop refuses. Any
 * failure, including an old agent's 404, is null, and the list keeps the
 * controller's own flags.
 */
export async function fetchProtectedProcesses(
	address: string,
	port: number,
	token: string,
): Promise<ProtectedSet | null> {
	try {
		const payload = await callAgent(
			{ address, port, token },
			"GET",
			"/processes/protected",
			undefined,
			PROTECTED_TIMEOUT_MS,
		);
		const parsed = AgentProtectedProcesses.safeParse(payload);
		if (!parsed.success) return null;
		return new Set(parsed.data.processes.map((p) => `${p.pid}:${p.startTicks}`));
	} catch {
		return null;
	}
}

/** Snapshots older than this are deleted, with their process names. */
export const PROCESS_SNAPSHOT_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Serve every pending administrator Refresh once (ADR 0037): read the
 * processes from Incus through the controller, or record why not. Rows
 * older than an hour are deleted. Process names are never logged.
 */
export async function serveProcessSnapshots(
	db: Kysely<Database>,
	controller: ControllerClient,
	logger: Logger,
	options: { now?: () => Date; readProtected?: ReadProtected } = {},
): Promise<number> {
	const now = options.now ?? (() => new Date());
	const readProtected = options.readProtected ?? (async () => null);
	await db
		.deleteFrom("workspace_process_snapshots")
		.where("requested_at", "<", new Date(now().getTime() - PROCESS_SNAPSHOT_MAX_AGE_MS))
		.execute();

	const pending = await db
		.selectFrom("workspace_process_snapshots as s")
		.innerJoin("workspaces as w", "w.id", "s.workspace_id")
		.select([
			"s.workspace_id",
			"s.requested_at",
			"w.state",
			"w.incus_instance_name",
			"w.agent_address",
			"w.agent_token",
		])
		.where((eb) =>
			eb.or([
				eb("s.taken_at", "is", null),
				eb("s.taken_at", "<=", eb.ref("s.requested_at")),
			]),
		)
		.execute();

	for (const row of pending) {
		let processes: InstanceProcess[] | null = null;
		let error: string | null = null;
		if (row.state !== "running" || !row.incus_instance_name) {
			error = "WORKSPACE_NOT_RUNNING";
		} else {
			try {
				processes = await controller.processes(
					row.incus_instance_name,
					AbortSignal.timeout(PROCESS_SNAPSHOT_TIMEOUT_MS),
				);
				const agentSet =
					row.agent_address && row.agent_token
						? await readProtected(row.agent_address, row.agent_token)
						: null;
				if (agentSet) {
					processes = processes.map((p) => ({
						...p,
						protected: p.protected || agentSet.has(`${p.pid}:${p.startTicks}`),
					}));
				}
			} catch (e) {
				error = e instanceof ControllerClientError ? e.code : "OPERATION_FAILED";
				logger.warn(
					{ workspaceId: row.workspace_id, errorCode: error },
					"process snapshot failed",
				);
			}
		}
		// Only the request that was served is answered; a newer Refresh stays pending.
		await db
			.updateTable("workspace_process_snapshots")
			.set({
				taken_at: now().toISOString(),
				processes: processes === null ? null : JSON.stringify(processes),
				error,
			})
			.where("workspace_id", "=", row.workspace_id)
			// A JavaScript Date holds milliseconds; the column may hold microseconds.
			.where(
				sql`date_trunc('milliseconds', requested_at)`,
				"=",
				row.requested_at.toISOString(),
			)
			.execute();
	}
	return pending.length;
}

/** Run the snapshot loop about once a second; errors are logged, never thrown. */
export function startProcessSnapshots(options: {
	db: Kysely<Database>;
	controller: ControllerClient;
	logger: Logger;
	agentPort: number;
}): () => void {
	const { db, controller, logger, agentPort } = options;
	return startLoop(
		"process snapshot",
		logger,
		async () => {
			await serveProcessSnapshots(db, controller, logger, {
				readProtected: (address, token) =>
					fetchProtectedProcesses(address, agentPort, token),
			});
		},
		PROCESS_SNAPSHOT_TICK_MS,
	);
}
