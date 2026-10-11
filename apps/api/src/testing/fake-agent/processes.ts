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

	/** The root's checks, then its descendants by parent PID, as process-tree-checked.ts. */
	function checkedTree(
		list: FakeProcess[],
		pid: number,
		startTicks: unknown,
	): { members: FakeProcess[]; refused: number } | { status: number; code: string } {
		const root = list.find((one) => one.pid === pid);
		if (!root) return { status: 404, code: "PROCESS_NOT_FOUND" };
		if (root.startTicks !== startTicks) return { status: 409, code: "PROCESS_CHANGED" };
		if (!root.stoppable) return { status: 403, code: "PROCESS_PROTECTED" };
		const members = [root];
		let refused = 0;
		for (let index = 0; index < members.length; index += 1) {
			const parent = members[index] as FakeProcess;
			for (const child of list.filter((one) => (one.ppid ?? 1) === parent.pid)) {
				if (child.stoppable) members.push(child);
				else refused += 1;
			}
		}
		return { members, refused };
	}

	app.post("/processes/:pid/stop-tree", async (request, reply) => {
		const pid = Number((request.params as { pid: string }).pid);
		const body = (request.body ?? {}) as {
			startTicks?: unknown;
			force?: unknown;
			remaining?: { pid: number; startTicks: number }[];
		};
		const key = keyOf(request);
		const list = processesFor(key);
		let members: FakeProcess[];
		let refused = 0;
		if (body.remaining) {
			members = list.filter((one) =>
				body.remaining?.some(
					(named) => named.pid === one.pid && named.startTicks === one.startTicks,
				),
			);
		} else {
			const tree = checkedTree(list, pid, body.startTicks);
			if ("code" in tree) {
				return reply
					.status(tree.status)
					.send({ error: { code: tree.code, message: "refused" } });
			}
			({ members, refused } = tree);
		}
		const left = members.filter((one) => one.ignoresTerm && body.force !== true);
		processes.set(
			key,
			list.filter((one) => !members.includes(one) || left.includes(one)),
		);
		return {
			pid,
			exited: left.length === 0,
			signalled: members.length,
			refused,
			remaining: left.map((one) => ({ pid: one.pid, startTicks: one.startTicks })),
		};
	});

	app.post("/processes/:pid/lower-priority", async (request, reply) => {
		const pid = Number((request.params as { pid: string }).pid);
		const body = (request.body ?? {}) as { startTicks?: unknown };
		const tree = checkedTree(processesFor(keyOf(request)), pid, body.startTicks);
		if ("code" in tree) {
			return reply
				.status(tree.status)
				.send({ error: { code: tree.code, message: "refused" } });
		}
		let lowered = 0;
		for (const member of tree.members) {
			const nice = member.nice ?? 0;
			const next = Math.min(19, nice + 10);
			if (next > nice) {
				member.nice = next;
				lowered += 1;
			}
		}
		return { pid, lowered, refused: tree.refused };
	});
}
