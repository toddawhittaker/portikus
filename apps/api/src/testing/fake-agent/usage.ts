import type { FastifyInstance } from "fastify";
import type { FakeAgentState, FakeStorage } from "./state.js";

/** The usage sample and its seeding hooks, like the agent's usage.ts (SPEC.md §19.2). */
export function registerUsageRoutes(app: FastifyInstance, s: FakeAgentState): void {
	const { storage, memory, keyOf, processesFor } = s;
	/** Set the storage figures `/usage` reports; an omitted class is null. */
	app.post("/__test/storage", async (request, reply) => {
		const body = (request.body ?? {}) as { key?: string } & Partial<FakeStorage>;
		storage.set(body.key ?? "", {
			home: body.home ?? null,
			docker: body.docker ?? null,
			recovery: body.recovery ?? null,
		});
		return reply.status(204).send();
	});

	// A fixed sample, so the control plane can proxy usage without a /proc.
	app.get("/usage", async (request) => ({
		observedAt: "2026-01-01T00:00:00.000Z",
		cpuPercent: 1.5,
		memory: memory.get(keyOf(request)) ?? { usedBytes: 100, totalBytes: 200 },
		disk: { usedBytes: 300, totalBytes: 400 },
		network: { receiveBytesPerSecond: 10, transmitBytesPerSecond: 20 },
		processes: processesFor(keyOf(request)).map((one) => ({
			pid: one.pid,
			cpuPercent: one.cpuPercent,
			residentBytes: one.residentBytes,
			command: one.command,
			startTicks: one.startTicks,
			stoppable: one.stoppable,
			commandLine: one.commandLine,
		})),
		storage: storage.get(keyOf(request)) ?? {
			home: null,
			docker: null,
			recovery: null,
		},
	}));

	/** Set the memory figure `/usage` reports, for the status bar's warning. */
	app.post("/__test/memory", async (request, reply) => {
		const body = (request.body ?? {}) as {
			key?: string;
			usedBytes: number;
			totalBytes: number;
		};
		memory.set(body.key ?? "", {
			usedBytes: body.usedBytes,
			totalBytes: body.totalBytes,
		});
		return reply.status(204).send();
	});
}
