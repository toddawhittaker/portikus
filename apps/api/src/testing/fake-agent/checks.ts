import type { WebSocket } from "@fastify/websocket";
import {
	CHECKS_FILE_PATH,
	type CheckDefinition,
	type CheckRun,
	ChecksFile,
} from "@portikus/contracts";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { FakeAgentState } from "./state.js";

export function registerCheckRoutes(app: FastifyInstance, s: FakeAgentState): void {
	const { projectNotFound, keyOf, dirs, nodeAt } = s;
	// Project checks (SPEC.md §18.1). The definitions come from the fake
	// filesystem, so a browser test seeds `.portikus/checks.json` the way a
	// student would. A "run" prints its command and ends with 0 or 1; a
	// command containing "sleep" stays running until it is stopped.
	interface FakeCheckRun {
		meta: CheckRun;
		lines: string[];
		sockets: Set<WebSocket>;
		final: { type: "exit"; exitCode: number; stopped?: boolean } | null;
	}
	const checkRuns = new Map<string, FakeCheckRun>();
	let checkRunCounter = 0;

	function checkRunKey(request: FastifyRequest, slug: string, id: string): string {
		return `${keyOf(request)}\u0000${slug}\u0000${id}`;
	}

	/** The definitions of one project, with the same reporting as the agent. */
	function readFakeChecks(
		request: FastifyRequest,
		slug: string,
	): { checks: CheckDefinition[]; error: string | null } {
		const node = nodeAt(request, slug, CHECKS_FILE_PATH);
		if (node?.type !== "file") return { checks: [], error: null };
		let parsed: unknown;
		try {
			parsed = JSON.parse(node.content.toString("utf8"));
		} catch {
			return { checks: [], error: `${CHECKS_FILE_PATH} is not valid JSON.` };
		}
		const validated = ChecksFile.safeParse(parsed);
		if (!validated.success) {
			return {
				checks: [],
				error: `${CHECKS_FILE_PATH} does not look like a list of checks.`,
			};
		}
		return { checks: validated.data.checks, error: null };
	}

	function finishFakeRun(run: FakeCheckRun, exitCode: number, stopped = false): void {
		run.meta.state = stopped ? "stopped" : exitCode === 0 ? "passed" : "failed";
		run.meta.exitCode = exitCode;
		run.meta.endedAt = new Date().toISOString();
		run.final = stopped
			? { type: "exit", exitCode, stopped }
			: { type: "exit", exitCode };
		for (const socket of run.sockets) {
			if (socket.readyState !== socket.OPEN) continue;
			socket.send(JSON.stringify(run.final));
			socket.close(1000, "run finished");
		}
		run.sockets.clear();
	}

	app.get("/projects/:slug/checks", async (request, reply) => {
		const slug = (request.params as { slug: string }).slug;
		if (!dirs(request).has(slug)) return projectNotFound(reply);
		const file = readFakeChecks(request, slug);
		const prefix = `${keyOf(request)}\u0000${slug}\u0000`;
		const runs: CheckRun[] = [];
		for (const [id, run] of checkRuns) {
			if (id.startsWith(prefix)) runs.push(run.meta);
		}
		return { checks: file.checks, error: file.error, runs };
	});

	app.post("/projects/:slug/checks/:id/runs", async (request, reply) => {
		const { slug, id } = request.params as { slug: string; id: string };
		if (!dirs(request).has(slug)) return projectNotFound(reply);
		const check = readFakeChecks(request, slug).checks.find(
			(candidate) => candidate.id === id,
		);
		if (!check) {
			return reply
				.status(404)
				.send({ error: { code: "CHECK_NOT_FOUND", message: "no such check" } });
		}
		const runKey = checkRunKey(request, slug, id);
		const existing = checkRuns.get(runKey);
		if (existing && existing.meta.state === "running") {
			return reply.status(409).send({
				error: { code: "CHECK_RUNNING", message: "that check is already running" },
			});
		}
		checkRunCounter += 1;
		const run: FakeCheckRun = {
			meta: {
				id: `fake-${checkRunCounter}`,
				checkId: id,
				state: "running",
				startedAt: new Date().toISOString(),
			},
			lines: [`$ ${check.command}`, `running ${check.name}`],
			sockets: new Set<WebSocket>(),
			final: null,
		};
		checkRuns.set(runKey, run);
		if (!check.command.includes("sleep")) {
			const failing = /(^|\s)(false|exit 1|fail)(\s|$)/.test(check.command);
			run.lines.push(failing ? "1 test failed" : "all tests passed");
			finishFakeRun(run, failing ? 1 : 0);
		}
		return reply.status(201).send(run.meta);
	});

	app.delete("/projects/:slug/checks/:id/runs/current", async (request, reply) => {
		const { slug, id } = request.params as { slug: string; id: string };
		const run = checkRuns.get(checkRunKey(request, slug, id));
		if (run?.meta.state !== "running") {
			return reply.status(404).send({
				error: { code: "CHECK_NOT_RUNNING", message: "that check is not running" },
			});
		}
		run.lines.push("stopped");
		finishFakeRun(run, 130, true);
		return reply.status(204).send();
	});

	app.get(
		"/projects/:slug/checks/:id/runs/current",
		{ websocket: true },
		(socket: WebSocket, request: FastifyRequest) => {
			const { slug, id } = request.params as { slug: string; id: string };
			const run = checkRuns.get(checkRunKey(request, slug, id));
			if (!run) {
				socket.send(JSON.stringify({ type: "error", code: "CHECK_NOT_RUNNING" }));
				socket.close(4404, "CHECK_NOT_RUNNING");
				return;
			}
			for (const line of run.lines) {
				socket.send(
					JSON.stringify({
						type: "output",
						data: Buffer.from(`${line}\r\n`, "utf8").toString("base64"),
					}),
				);
			}
			if (run.final) {
				socket.send(JSON.stringify(run.final));
				socket.close(1000, "run finished");
				return;
			}
			run.sockets.add(socket);
			socket.on("close", () => run.sockets.delete(socket));
		},
	);
}
