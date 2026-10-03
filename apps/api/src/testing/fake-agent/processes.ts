import type { FastifyInstance } from "fastify";
import { defaultProcesses, type FakeAgentState, type FakeProcess } from "./state.js";

/** Stopping a process, like the agent's processes-route.ts (SPEC.md §18.3). */
export function registerProcessRoutes(app: FastifyInstance, s: FakeAgentState): void {
	const { flags, processes, keyOf, processesFor } = s;
	/** Replace a workspace's process list. */
	app.post("/__test/processes", async (request, reply) => {
		const body = (request.body ?? {}) as { key?: string; processes?: FakeProcess[] };
		processes.set(body.key ?? "", body.processes ?? defaultProcesses());
		return reply.status(204).send();
	});

	/** Stop a process, with the real agent's checks and answers (SPEC.md §18.3). */
	app.post("/processes/:pid/stop", async (request, reply) => {
		const pid = Number((request.params as { pid: string }).pid);
		const body = (request.body ?? {}) as { startTicks?: unknown; force?: unknown };
		if (!Number.isSafeInteger(pid) || pid < 1 || typeof body.startTicks !== "number") {
			return reply
				.status(400)
				.send({ error: { code: "BAD_REQUEST", message: "invalid pid or body" } });
		}
		const hold = flags.stopHold;
		flags.stopHold = null;
		if (hold) {
			hold.arrived();
			await hold.released;
		}
		const key = keyOf(request);
		const list = processesFor(key);
		const found = list.find((one) => one.pid === pid);
		if (!found) {
			return reply
				.status(404)
				.send({ error: { code: "PROCESS_NOT_FOUND", message: "no such process" } });
		}
		if (found.startTicks !== body.startTicks) {
			return reply.status(409).send({
				error: { code: "PROCESS_CHANGED", message: "the process id was reused" },
			});
		}
		if (!found.stoppable) {
			return reply.status(403).send({
				error: { code: "PROCESS_PROTECTED", message: "this process is protected" },
			});
		}
		if (found.ignoresTerm && body.force !== true) return { pid, exited: false };
		processes.set(
			key,
			list.filter((one) => one !== found),
		);
		return { pid, exited: true };
	});
}
