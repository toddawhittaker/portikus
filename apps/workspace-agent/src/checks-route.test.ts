/**
 * Project checks in the workspace agent (SPEC.md §18.1): the definitions come
 * from the project's own `.portikus/checks.json`, a run is a real command,
 * only one run of a check goes at a time, and the output kept for replay is
 * capped.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_CHECK_OUTPUT_BYTES } from "@portikus/contracts";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import { CheckRunner, readChecksFile } from "./checks-route.js";
import { buildServer } from "./server.js";

const TOKEN = "d".repeat(64);
const SLUG = "essay";

let app: FastifyInstance;
let homeDir: string;
let port: number;

const CHECKS = {
	checks: [
		{ id: "tests", name: "Tests", command: "echo hello" },
		{ id: "lint", name: "Lint", command: "exit 3" },
	],
};

/** A logger that writes nothing, which is all the runner needs. */
const quietLog = {
	error: () => {},
	debug: () => {},
	info: () => {},
} as unknown as FastifyBaseLogger;

async function writeChecks(contents: string): Promise<void> {
	await mkdir(join(homeDir, "projects", SLUG, ".portikus"), { recursive: true });
	await writeFile(
		join(homeDir, "projects", SLUG, ".portikus", "checks.json"),
		contents,
	);
}

function call(method: string, url: string) {
	return app.inject({
		method: method as "GET",
		url,
		headers: { authorization: `Bearer ${TOKEN}` },
	});
}

beforeAll(async () => {
	homeDir = await mkdtemp(join(tmpdir(), "pk-checks-"));
	const tokenPath = join(homeDir, "token");
	await writeFile(tokenPath, TOKEN);
	app = buildServer({ tokenPath, homeDir });
	await app.listen({ port: 0, host: "127.0.0.1" });
	port = (app.server.address() as { port: number }).port;
	expect(port).toBeGreaterThan(0);
});

afterAll(async () => {
	await app.close();
	await rm(homeDir, { recursive: true, force: true });
});

beforeEach(async () => {
	await rm(join(homeDir, "projects"), { recursive: true, force: true });
	await mkdir(join(homeDir, "projects", SLUG), { recursive: true });
});

test("a project with no checks file has no checks and no error", async () => {
	const response = await call("GET", `/projects/${SLUG}/checks`);
	expect(response.statusCode).toBe(200);
	expect(response.json()).toEqual({ checks: [], error: null, runs: [] });
});

test("a broken checks file is reported rather than thrown", async () => {
	await writeChecks("{ not json");
	const response = await call("GET", `/projects/${SLUG}/checks`);
	expect(response.statusCode).toBe(200);
	expect(response.json().checks).toEqual([]);
	expect(response.json().error).toContain("not valid JSON");
});

test("a checks file of the wrong shape is reported rather than thrown", async () => {
	await writeChecks(JSON.stringify({ checks: [{ id: "A B", name: "", command: "" }] }));
	const body = (await call("GET", `/projects/${SLUG}/checks`)).json();
	expect(body.checks).toEqual([]);
	expect(body.error).toContain("does not look like a list of checks");
});

test("a repeated id is reported rather than thrown", async () => {
	await writeChecks(
		JSON.stringify({
			checks: [
				{ id: "tests", name: "One", command: "true" },
				{ id: "tests", name: "Two", command: "true" },
			],
		}),
	);
	expect((await call("GET", `/projects/${SLUG}/checks`)).json().error).toContain(
		"more than once",
	);
});

test("a checks file that is valid is read back", async () => {
	await writeChecks(JSON.stringify(CHECKS));
	const file = await readChecksFile(homeDir, SLUG);
	expect(file).toEqual({ checks: CHECKS.checks, error: null });
});

test("reading the checks of a project that does not exist is a 404", async () => {
	const response = await call("GET", "/projects/missing/checks");
	expect(response.statusCode).toBe(404);
	expect(response.json().error.code).toBe("PROJECT_NOT_FOUND");
});

test("a command that succeeds passes and one that fails carries its exit code", async () => {
	await writeChecks(JSON.stringify(CHECKS));
	const started = await call("POST", `/projects/${SLUG}/checks/tests/runs`);
	expect(started.statusCode).toBe(201);
	expect(started.json().state).toBe("running");

	await vi.waitFor(
		async () => {
			const runs = (await call("GET", `/projects/${SLUG}/checks`)).json().runs;
			expect(runs[0].state).toBe("passed");
			expect(runs[0].exitCode).toBe(0);
		},
		{ timeout: 10_000 },
	);

	await call("POST", `/projects/${SLUG}/checks/lint/runs`);
	await vi.waitFor(
		async () => {
			const runs = (await call("GET", `/projects/${SLUG}/checks`)).json().runs;
			const lint = runs.find((run: { checkId: string }) => run.checkId === "lint");
			expect(lint.state).toBe("failed");
			expect(lint.exitCode).toBe(3);
		},
		{ timeout: 10_000 },
	);
});

test("running a check that is not configured is a 404", async () => {
	await writeChecks(JSON.stringify(CHECKS));
	const response = await call("POST", `/projects/${SLUG}/checks/nope/runs`);
	expect(response.statusCode).toBe(404);
	expect(response.json().error.code).toBe("CHECK_NOT_FOUND");
});

test("a second run of the same check while one is going is a 409", async () => {
	await writeChecks(
		JSON.stringify({ checks: [{ id: "slow", name: "Slow", command: "sleep 30" }] }),
	);
	expect((await call("POST", `/projects/${SLUG}/checks/slow/runs`)).statusCode).toBe(
		201,
	);
	const second = await call("POST", `/projects/${SLUG}/checks/slow/runs`);
	expect(second.statusCode).toBe(409);
	expect(second.json().error.code).toBe("CHECK_RUNNING");

	// Stopping it lets the next run start.
	expect(
		(await call("DELETE", `/projects/${SLUG}/checks/slow/runs/current`)).statusCode,
	).toBe(204);
	await vi.waitFor(
		async () => {
			const runs = (await call("GET", `/projects/${SLUG}/checks`)).json().runs;
			expect(runs[0].state).not.toBe("running");
		},
		{ timeout: 10_000 },
	);
});

test("stopping a check that is not running is a 404", async () => {
	await writeChecks(JSON.stringify(CHECKS));
	const response = await call("DELETE", `/projects/${SLUG}/checks/tests/runs/current`);
	expect(response.statusCode).toBe(404);
	expect(response.json().error.code).toBe("CHECK_NOT_RUNNING");
});

test("the buffer keeps the newest megabyte and drops the oldest bytes", async () => {
	// A fake PTY, so the buffer can be filled without really running anything.
	const handlers: { data?: (text: string) => void } = {};
	const fakePty = {
		onData: (fn: (text: string) => void) => {
			handlers.data = fn;
		},
		onExit: () => {},
		kill: () => {},
	};
	const runner = new CheckRunner(
		quietLog,
		(() => fakePty) as unknown as Parameters<typeof CheckRunner.prototype.start>[0] &
			never,
	);
	runner.start({
		slug: SLUG,
		check: { id: "noisy", name: "Noisy", command: "yes" },
		cwd: homeDir,
	});

	// The first chunk is the oldest, so it is the one that has to go.
	handlers.data?.("a".repeat(600_000));
	handlers.data?.("b".repeat(600_000));

	const frames: string[] = [];
	const socket = {
		readyState: 1,
		OPEN: 1,
		send: (text: string) => frames.push(text),
		close: () => {},
		on: () => {},
	};
	runner.attach(SLUG, "noisy", socket as never);

	const kept = frames
		.map((frame) => Buffer.from(JSON.parse(frame).data, "base64").toString("utf8"))
		.join("");
	expect(kept.length).toBe(MAX_CHECK_OUTPUT_BYTES);
	// Every "b" survived; the overflow came out of the leading "a"s.
	expect(kept.endsWith("b".repeat(600_000))).toBe(true);
	expect(kept.startsWith("a")).toBe(true);
});

test("the output socket replays what a finished run printed", async () => {
	await writeChecks(
		JSON.stringify({
			checks: [{ id: "greet", name: "Greet", command: "echo hello-from-check" }],
		}),
	);
	await call("POST", `/projects/${SLUG}/checks/greet/runs`);
	await vi.waitFor(
		async () => {
			const runs = (await call("GET", `/projects/${SLUG}/checks`)).json().runs;
			expect(runs[0].state).toBe("passed");
		},
		{ timeout: 10_000 },
	);

	const ws = new WebSocket(
		`ws://127.0.0.1:${port}/projects/${SLUG}/checks/greet/runs/current`,
		{ headers: { authorization: `Bearer ${TOKEN}` } } as unknown as string[],
	);
	const frames: Record<string, unknown>[] = [];
	ws.addEventListener("message", (event) => {
		frames.push(JSON.parse(event.data as string));
	});
	await new Promise<void>((resolve) => {
		ws.addEventListener("close", () => resolve(), { once: true });
	});

	const text = frames
		.filter((frame) => frame.type === "output")
		.map((frame) => Buffer.from(frame.data as string, "base64").toString("utf8"))
		.join("");
	expect(text).toContain("hello-from-check");
	expect(frames.at(-1)).toEqual({ type: "exit", exitCode: 0 });
});

test("the output socket of a check that never ran closes with 4404", async () => {
	await writeChecks(JSON.stringify(CHECKS));
	const ws = new WebSocket(
		`ws://127.0.0.1:${port}/projects/${SLUG}/checks/never-run/runs/current`,
		{ headers: { authorization: `Bearer ${TOKEN}` } } as unknown as string[],
	);
	const code = await new Promise<number>((resolve) => {
		ws.addEventListener("close", (event) => resolve(event.code), { once: true });
	});
	expect(code).toBe(4404);
});
