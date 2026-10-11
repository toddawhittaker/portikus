/**
 * `POST /processes/:pid/stop` (SPEC.md §18.3), its tree form
 * `POST /processes/:pid/stop-tree`, `POST /processes/:pid/lower-priority`,
 * and `GET /processes/protected`: the set that stop refuses, for the
 * administrator's list (ADR 0037). The single stop serves the student and
 * the administrator, both through the API; the tree routes serve Monitor.
 * Token auth comes from the server's own preHandler hook.
 */
import { setPriority } from "node:os";
import {
	type AgentProtectedProcesses,
	ProcessPriorityRequest,
	ProcessStopRequest,
	ProcessTreeStopRequest,
} from "@portikus/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodType } from "zod";
import { sendError } from "./errors.js";
import { lowerCheckedTreePriority, stopCheckedTree } from "./process-tree-checked.js";
import { readProcess, type StopOptions, stopProcess } from "./processes.js";

export type ProcessesRouteOptions = Partial<StopOptions> & {
	setPriority?: (tid: number, nice: number) => void;
};

/** The pid from the path and the parsed body, or null once a 400 is sent. */
function parseTarget<T>(
	request: FastifyRequest,
	reply: FastifyReply,
	schema: ZodType<T>,
): { pid: number; body: T } | null {
	const { pid: raw } = request.params as { pid: string };
	const pid = /^[1-9]\d{0,9}$/.test(raw) ? Number(raw) : Number.NaN;
	const body = schema.safeParse(request.body ?? {});
	if (!Number.isSafeInteger(pid) || pid > 2 ** 31 - 1 || !body.success) {
		void reply
			.code(400)
			.send({ error: { code: "BAD_REQUEST", message: "invalid pid or body" } });
		return null;
	}
	return { pid, body: body.data };
}

export async function processesRoutes(
	instance: FastifyInstance,
	options: ProcessesRouteOptions,
): Promise<void> {
	const stop: StopOptions = {
		procRoot: options.procRoot ?? "/proc",
		selfPid: options.selfPid ?? process.pid,
		studentUid: options.studentUid ?? process.getuid?.() ?? 1000,
		protectedPids: options.protectedPids ?? (async () => new Set<number>()),
		kill: options.kill ?? ((pid, signal) => process.kill(pid, signal)),
		...(options.graceMs === undefined ? {} : { graceMs: options.graceMs }),
		...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
	};
	const priority = { ...stop, setPriority: options.setPriority ?? setPriority };

	instance.get("/processes/protected", async (request, reply) => {
		try {
			const pids = await stop.protectedPids();
			const facts = await Promise.all(
				[...pids].map((pid) => readProcess(stop.procRoot, pid)),
			);
			const body: AgentProtectedProcesses = {
				processes: facts.flatMap((f) =>
					f ? [{ pid: f.pid, startTicks: f.startTicks }] : [],
				),
			};
			return body;
		} catch (error) {
			return sendError(request, reply, error, "INTERNAL");
		}
	});

	instance.post("/processes/:pid/stop", async (request, reply) => {
		const target = parseTarget(request, reply, ProcessStopRequest);
		if (!target) return reply;
		try {
			return await stopProcess(target.pid, target.body, stop);
		} catch (error) {
			return sendError(request, reply, error, "INTERNAL");
		}
	});

	instance.post("/processes/:pid/stop-tree", async (request, reply) => {
		const target = parseTarget(request, reply, ProcessTreeStopRequest);
		if (!target) return reply;
		try {
			return await stopCheckedTree(target.pid, target.body, stop);
		} catch (error) {
			return sendError(request, reply, error, "INTERNAL");
		}
	});

	instance.post("/processes/:pid/lower-priority", async (request, reply) => {
		const target = parseTarget(request, reply, ProcessPriorityRequest);
		if (!target) return reply;
		try {
			return await lowerCheckedTreePriority(target.pid, target.body, priority);
		} catch (error) {
			return sendError(request, reply, error, "INTERNAL");
		}
	});
}
