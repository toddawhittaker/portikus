/**
 * `POST /processes/:pid/stop` (SPEC.md §18.3; docs/EPIC-21.md ruling 8). One
 * route serves the student and the administrator, both through the API.
 * Token auth comes from the server's own preHandler hook.
 */
import { ProcessStopRequest } from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import { ProcessStopFailure, type StopOptions, stopProcess } from "./processes.js";

export type ProcessesRouteOptions = Partial<StopOptions>;

export async function processesRoutes(
	instance: FastifyInstance,
	options: ProcessesRouteOptions,
): Promise<void> {
	const stop: StopOptions = {
		procRoot: options.procRoot ?? "/proc",
		selfPid: options.selfPid ?? process.pid,
		studentUid: options.studentUid ?? process.getuid?.() ?? 1000,
		kill: options.kill ?? ((pid, signal) => process.kill(pid, signal)),
		...(options.graceMs === undefined ? {} : { graceMs: options.graceMs }),
		...(options.pollMs === undefined ? {} : { pollMs: options.pollMs }),
	};

	instance.post("/processes/:pid/stop", async (request, reply) => {
		const { pid: raw } = request.params as { pid: string };
		const pid = /^[1-9]\d{0,9}$/.test(raw) ? Number(raw) : Number.NaN;
		const body = ProcessStopRequest.safeParse(request.body ?? {});
		if (!Number.isSafeInteger(pid) || pid > 2 ** 31 - 1 || !body.success) {
			return reply
				.code(400)
				.send({ error: { code: "BAD_REQUEST", message: "invalid pid or body" } });
		}
		try {
			return await stopProcess(pid, body.data, stop);
		} catch (error) {
			if (error instanceof ProcessStopFailure) {
				return reply
					.code(error.status)
					.send({ error: { code: error.code, message: error.message } });
			}
			// The pid only; never the process's name or command line.
			request.log.error(
				{ error: error instanceof Error ? error.message : String(error) },
				"stop process failed",
			);
			return reply
				.code(500)
				.send({ error: { code: "INTERNAL", message: "internal error" } });
		}
	});
}
