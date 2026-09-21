/**
 * Project checks (SPEC.md §18.1). The definitions live in the project, in
 * `.portikus/checks.json`. A run is a real command in the project directory,
 * started in a PTY so that its output looks the way it would in a terminal,
 * and its output goes to a read-only panel in the browser rather than to a
 * terminal tab the student could type into.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { WebSocket } from "@fastify/websocket";
import {
	CHECKS_FILE_PATH,
	type CheckDefinition,
	type CheckOutputFrame,
	type CheckRun,
	ChecksFile,
	type ChecksResponse,
	MAX_CHECK_OUTPUT_BYTES,
} from "@portikus/contracts";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { type IPty, spawn } from "node-pty";
import { sendError } from "./errors.js";
import { resolveProject } from "./projects.js";
import { AgentFailure } from "./tmux.js";

/** Close code for a socket asking about a run that does not exist. */
const NOT_FOUND_CLOSE = 4404;

/**
 * How many runs one agent remembers. A run's output buffer is kept for
 * replay, so a workspace with many projects and many checks must not grow
 * without end; the oldest finished run goes first.
 */
const MAX_REMEMBERED_RUNS = 50;

/** The size a check's PTY reports. Wide enough that test output is not wrapped. */
const CHECK_COLS = 120;
const CHECK_ROWS = 30;

/** How a finished or failed run is remembered, and who is watching it. */
interface LiveRun {
	meta: CheckRun;
	/** Output so far, oldest first, capped at MAX_CHECK_OUTPUT_BYTES. */
	chunks: Buffer[];
	bytes: number;
	/** Null once the command has ended or never started. */
	pty: IPty | null;
	watchers: Set<WebSocket>;
	/** The frame that ended this run, replayed to a late watcher. */
	final: CheckOutputFrame | null;
}

function key(slug: string, checkId: string): string {
	return `${slug}\u0000${checkId}`;
}

function send(socket: WebSocket, frame: CheckOutputFrame): void {
	if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
}

/**
 * Every check run this agent knows about: at most one live run per check,
 * plus the last run's output kept for replay. Exported so a test can drive it
 * without an HTTP server.
 */
export class CheckRunner {
	private readonly runs = new Map<string, LiveRun>();
	private counter = 0;

	constructor(
		private readonly log: FastifyBaseLogger,
		/** Overridden by tests so they can drive a fake PTY. */
		private readonly spawnPty: typeof spawn = spawn,
	) {}

	/** The last run of each check of one project, live or finished. */
	runsFor(slug: string): CheckRun[] {
		const prefix = `${slug}\u0000`;
		const found: CheckRun[] = [];
		for (const [id, run] of this.runs) {
			if (id.startsWith(prefix)) found.push(run.meta);
		}
		return found;
	}

	/** The live or last run of one check, if this agent still has it. */
	current(slug: string, checkId: string): CheckRun | undefined {
		return this.runs.get(key(slug, checkId))?.meta;
	}

	/**
	 * Start one check. Only one run of a check may be live at a time, so a
	 * second request while the first is going is refused rather than queued
	 * (SPEC.md §18.1).
	 */
	start(options: { slug: string; check: CheckDefinition; cwd: string }): CheckRun {
		const id = key(options.slug, options.check.id);
		const existing = this.runs.get(id);
		if (existing && existing.meta.state === "running") {
			throw new AgentFailure("CHECK_RUNNING", "that check is already running");
		}
		// A new run replaces the previous one's buffer: only the last run's
		// output is kept.
		this.counter += 1;
		const run: LiveRun = {
			meta: {
				id: `${Date.now()}-${this.counter}`,
				checkId: options.check.id,
				state: "running",
				startedAt: new Date().toISOString(),
			},
			chunks: [],
			bytes: 0,
			pty: null,
			watchers: new Set(),
			final: null,
		};
		// Re-inserting puts this check at the newest end of the map, which is
		// the order eviction walks.
		this.runs.delete(id);
		this.runs.set(id, run);
		this.evictOldFinishedRuns();

		let pty: IPty;
		try {
			// A login shell is what the student would type the command in, so
			// their own PATH and version managers apply (SPEC.md §18.1).
			pty = this.spawnPty("bash", ["-lc", options.check.command], {
				name: "xterm-256color",
				cols: CHECK_COLS,
				rows: CHECK_ROWS,
				cwd: options.cwd,
				env: { ...process.env } as Record<string, string>,
			});
		} catch (error) {
			this.log.error(
				{ error: error instanceof Error ? error.message : String(error) },
				"check failed to start",
			);
			this.finish(run, { type: "error", code: "SPAWN_FAILED" }, "error");
			return run.meta;
		}
		run.pty = pty;

		pty.onData((data: string) => {
			const chunk = Buffer.from(data, "utf8");
			this.append(run, chunk);
			const frame: CheckOutputFrame = {
				type: "output",
				data: chunk.toString("base64"),
			};
			for (const socket of run.watchers) send(socket, frame);
		});

		pty.onExit(({ exitCode }: { exitCode: number }) => {
			run.pty = null;
			run.meta.exitCode = exitCode;
			this.finish(
				run,
				{ type: "exit", exitCode },
				exitCode === 0 ? "passed" : "failed",
			);
		});

		return run.meta;
	}

	/** Stop a live run. Throws when there is nothing running. */
	kill(slug: string, checkId: string): void {
		const run = this.runs.get(key(slug, checkId));
		if (run?.meta.state !== "running" || !run.pty) {
			throw new AgentFailure("CHECK_NOT_RUNNING", "that check is not running");
		}
		try {
			run.pty.kill();
		} catch {
			// The process may already be gone; onExit still settles the run.
		}
	}

	/**
	 * Attach a browser socket: everything buffered so far, then whatever
	 * comes next. A run that has already ended replays its output and its
	 * ending frame, and the socket is closed.
	 */
	attach(slug: string, checkId: string, socket: WebSocket): void {
		const run = this.runs.get(key(slug, checkId));
		if (!run) {
			send(socket, { type: "error", code: "CHECK_NOT_RUNNING" });
			socket.close(NOT_FOUND_CLOSE, "CHECK_NOT_RUNNING");
			return;
		}
		for (const chunk of run.chunks) {
			send(socket, { type: "output", data: chunk.toString("base64") });
		}
		if (run.final) {
			send(socket, run.final);
			socket.close(1000, "run finished");
			return;
		}
		run.watchers.add(socket);
		socket.on("close", () => run.watchers.delete(socket));
	}

	/** Kill every live run, for shutdown. */
	closeEverything(): void {
		for (const run of this.runs.values()) {
			try {
				run.pty?.kill();
			} catch {
				// Shutting down anyway.
			}
		}
	}

	/** Forget finished runs, oldest first, until the map is back in bounds. */
	private evictOldFinishedRuns(): void {
		while (this.runs.size > MAX_REMEMBERED_RUNS) {
			const oldest = [...this.runs].find(
				([, candidate]) => candidate.meta.state !== "running",
			);
			// Everything left is live, and a live run is never thrown away.
			if (!oldest) return;
			this.runs.delete(oldest[0]);
		}
	}

	/** Keep the newest MAX_CHECK_OUTPUT_BYTES, dropping the oldest first. */
	private append(run: LiveRun, chunk: Buffer): void {
		run.chunks.push(chunk);
		run.bytes += chunk.length;
		while (run.bytes > MAX_CHECK_OUTPUT_BYTES && run.chunks.length > 0) {
			const oldest = run.chunks[0];
			if (oldest === undefined) break;
			const over = run.bytes - MAX_CHECK_OUTPUT_BYTES;
			if (oldest.length <= over) {
				run.chunks.shift();
				run.bytes -= oldest.length;
				continue;
			}
			run.chunks[0] = oldest.subarray(over);
			run.bytes -= over;
		}
	}

	private finish(
		run: LiveRun,
		frame: CheckOutputFrame,
		state: "passed" | "failed" | "error",
	): void {
		run.meta.state = state;
		run.meta.endedAt = new Date().toISOString();
		run.final = frame;
		for (const socket of run.watchers) {
			send(socket, frame);
			if (socket.readyState === socket.OPEN) socket.close(1000, "run finished");
		}
		run.watchers.clear();
	}
}

/**
 * Read and validate `.portikus/checks.json`. A missing file is an empty list,
 * and a file we cannot use is reported rather than thrown: a broken checks
 * file must not stop the student using the project (SPEC.md §18.1).
 */
export async function readChecksFile(
	homeDir: string,
	slug: string,
): Promise<{ checks: CheckDefinition[]; error: string | null }> {
	const project = await resolveProject(slug, homeDir);
	if (!project.exists) {
		throw new AgentFailure("PROJECT_NOT_FOUND", "no such project");
	}
	let text: string;
	try {
		text = await readFile(join(project.path, CHECKS_FILE_PATH), "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return { checks: [], error: null };
		if (code === "EISDIR") {
			return { checks: [], error: `${CHECKS_FILE_PATH} is a folder, not a file.` };
		}
		return { checks: [], error: `${CHECKS_FILE_PATH} could not be read.` };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
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
	const ids = new Set<string>();
	for (const check of validated.data.checks) {
		if (ids.has(check.id)) {
			return {
				checks: [],
				error: `${CHECKS_FILE_PATH} uses the id "${check.id}" more than once.`,
			};
		}
		ids.add(check.id);
	}
	return { checks: validated.data.checks, error: null };
}

export interface ChecksRouteOptions {
	homeDir: string;
	/** Overridden by tests so they can drive a fake PTY. */
	runner?: CheckRunner;
}

/** The agent's check routes (SPEC.md §18.1, §26). */
export async function checksRoute(
	instance: FastifyInstance,
	options: ChecksRouteOptions,
): Promise<void> {
	const runner = options.runner ?? new CheckRunner(instance.log);

	instance.addHook("preClose", async () => {
		runner.closeEverything();
	});

	instance.get("/projects/:slug/checks", async (request, reply) => {
		const { slug } = request.params as { slug: string };
		try {
			const file = await readChecksFile(options.homeDir, slug);
			const body: ChecksResponse = {
				checks: file.checks,
				error: file.error,
				runs: runner.runsFor(slug),
			};
			return body;
		} catch (error) {
			return sendError(request, reply, error, "INTERNAL");
		}
	});

	instance.post("/projects/:slug/checks/:id/runs", async (request, reply) => {
		const { slug, id } = request.params as { slug: string; id: string };
		try {
			const project = await resolveProject(slug, options.homeDir);
			if (!project.exists) {
				throw new AgentFailure("PROJECT_NOT_FOUND", "no such project");
			}
			const file = await readChecksFile(options.homeDir, slug);
			const check = file.checks.find((candidate) => candidate.id === id);
			if (!check) throw new AgentFailure("CHECK_NOT_FOUND", "no such check");
			const run = runner.start({ slug, check, cwd: project.path });
			return reply.code(201).send(run);
		} catch (error) {
			return sendError(request, reply, error, "INTERNAL");
		}
	});

	instance.delete("/projects/:slug/checks/:id/runs/current", async (request, reply) => {
		const { slug, id } = request.params as { slug: string; id: string };
		try {
			runner.kill(slug, id);
			return reply.code(204).send();
		} catch (error) {
			return sendError(request, reply, error, "INTERNAL");
		}
	});

	instance.get(
		"/projects/:slug/checks/:id/runs/current",
		{ websocket: true },
		async (socket: WebSocket, request) => {
			const { slug, id } = request.params as { slug: string; id: string };
			// Nothing the browser sends on this socket is read: a check panel
			// is output only (SPEC.md §18.1).
			socket.on("message", () => {});
			runner.attach(slug, id, socket);
		},
	);
}
