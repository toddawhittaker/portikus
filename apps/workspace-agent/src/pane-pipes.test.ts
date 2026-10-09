/**
 * `clear && npm test` must empty the browser's scrollback even when new
 * output refills tmux's history before the pane poll looks (SPEC.md §9.7).
 * The agent reads a copy of each pane's output for the erase-scrollback
 * sequence, and never logs or keeps those bytes (STACK.md §15, ADR 0012).
 */
import { execFile } from "node:child_process";
import { mkdtemp, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { collectingLogger } from "@portikus/observability/testing";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, test } from "vitest";
import { ClearScanner, PanePipes } from "./pane-pipes.js";
import { buildServer } from "./server.js";
import { createSession, sessionName } from "./tmux.js";

const run = promisify(execFile);

const TOKEN = "c".repeat(64);
const SOCKET_NAME = `portikus-pipes-${process.pid}`;
const SERVER = { socketName: SOCKET_NAME, external: false };

const haveTmux = await run("tmux", ["-V"]).then(
	() => true,
	() => false,
);

let homeDir: string;
let nextId = 0;
function makeId(): string {
	nextId += 1;
	return `00000000-0000-4000-8000-${String(9600 + nextId).padStart(12, "0")}`;
}

beforeAll(async () => {
	homeDir = await mkdtemp(join(tmpdir(), "portikus-pipes-"));
});

afterAll(async () => {
	await run("tmux", ["-L", SOCKET_NAME, "kill-server"]).catch(() => undefined);
});

const ERASE = Buffer.from("\x1b[3J");

test("the scanner finds the erase-scrollback sequence in one chunk", () => {
	const scanner = new ClearScanner();
	expect(scanner.feed(Buffer.from("old output\r\n\x1b[H\x1b[2J\x1b[3Jnew"))).toBe(true);
	expect(scanner.feed(Buffer.from("more output"))).toBe(false);
});

test("the scanner finds the sequence split at every point across chunks", () => {
	for (let cut = 1; cut < ERASE.length; cut += 1) {
		const scanner = new ClearScanner();
		expect(
			scanner.feed(Buffer.concat([Buffer.from("abc"), ERASE.subarray(0, cut)])),
		).toBe(false);
		expect(scanner.feed(Buffer.concat([ERASE.subarray(cut), Buffer.from("x")]))).toBe(
			true,
		);
	}
	// One byte at a time.
	const scanner = new ClearScanner();
	const results = [...ERASE].map((byte) => scanner.feed(Uint8Array.of(byte)));
	expect(results).toEqual([false, false, false, true]);
});

test("the scanner ignores near misses and restarts on a fresh ESC", () => {
	const scanner = new ClearScanner();
	expect(scanner.feed(Buffer.from("\x1b[3K\x1b[2J\x1b[33m3J[3J"))).toBe(false);
	expect(scanner.feed(Buffer.from("\x1b\x1b[3J"))).toBe(true);
	expect(scanner.feed(Buffer.from("\x1b[3"))).toBe(false);
	expect(scanner.feed(Buffer.from("x\x1b[3J"))).toBe(true);
});

/** Wait until `check` passes or five seconds go by. */
async function eventually(check: () => boolean | Promise<boolean>): Promise<void> {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("condition never held");
}

async function panePiped(id: string): Promise<boolean> {
	const { stdout } = await run("tmux", [
		"-L",
		SOCKET_NAME,
		"display-message",
		"-p",
		"-t",
		sessionName(id),
		"#{pane_pipe}",
	]);
	return stdout.trim() === "1";
}

async function type(id: string, line: string): Promise<void> {
	await run("tmux", [
		"-L",
		SOCKET_NAME,
		"send-keys",
		"-t",
		sessionName(id),
		line,
		"Enter",
	]);
}

test.skipIf(!haveTmux)(
	"a pane's clear is reported at once and none of its output reaches the log",
	async () => {
		const id = makeId();
		await createSession(id, homeDir, homeDir, "dark", "UTC", SERVER);
		const { logger, lines } = collectingLogger("debug");
		const cleared: string[] = [];
		const pipes = new PanePipes({
			dir: join(homeDir, "panes"),
			server: SERVER,
			onClear: (terminalId) => cleared.push(terminalId),
			log: logger as unknown as FastifyBaseLogger,
		});
		await pipes.start(id);
		expect(await panePiped(id)).toBe(true);
		const fifo = await stat(join(homeDir, "panes", id));
		expect(fifo.isFIFO()).toBe(true);

		await type(id, "echo SECRET-PANE-MARKER; printf '\\033[3J'");
		await eventually(() => cleared.length > 0);
		expect(cleared).toEqual([id]);
		expect(JSON.stringify(lines)).not.toContain("SECRET-PANE-MARKER");

		pipes.stopAll();
		await eventually(() => fifoGone(join(homeDir, "panes", id)));
	},
);

/** Exit the shell; the wrapper treats an exit in the first second as a broken ~/.bashrc. */
async function exitShell(id: string): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 1200));
	await type(id, "exit");
}

async function fifoGone(path: string): Promise<boolean> {
	return stat(path).then(
		() => false,
		() => true,
	);
}

test.skipIf(!haveTmux)(
	"a terminal whose shell exits on its own leaves no reader or FIFO behind",
	async () => {
		const id = makeId();
		await createSession(id, homeDir, homeDir, "dark", "UTC", SERVER);
		const cleared: string[] = [];
		const pipes = new PanePipes({
			dir: join(homeDir, "exit-panes"),
			server: SERVER,
			onClear: (terminalId) => cleared.push(terminalId),
			log: collectingLogger("debug").logger as unknown as FastifyBaseLogger,
			sweepMs: 50,
		});
		try {
			await pipes.start(id);
			const fifo = join(homeDir, "exit-panes", id);
			expect((await stat(fifo)).isFIFO()).toBe(true);
			await exitShell(id);
			await eventually(() => fifoGone(fifo));
		} finally {
			pipes.stopAll();
		}
	},
	15_000,
);

test.skipIf(!haveTmux)("a pipe that cannot start is logged, not thrown", async () => {
	const { logger, lines } = collectingLogger("debug");
	const pipes = new PanePipes({
		dir: join(homeDir, "missing-panes"),
		server: SERVER,
		onClear: () => undefined,
		log: logger as unknown as FastifyBaseLogger,
	});
	try {
		await pipes.adopt([makeId(), makeId()]);
		const warnings = lines.filter(
			(line) => line.msg === "could not watch a terminal for clear",
		);
		expect(warnings).toHaveLength(2);
	} finally {
		pipes.stopAll();
	}
});

/** Just enough of an attach socket to collect the agent's text frames. */
async function attach(
	port: number,
	id: string,
): Promise<{ frames: unknown[]; close: () => void }> {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/terminals/${id}/attach`, {
		headers: { authorization: `Bearer ${TOKEN}` },
	} as unknown as string[]);
	const frames: unknown[] = [];
	ws.addEventListener("message", (event) => {
		if (typeof event.data === "string") frames.push(JSON.parse(event.data));
	});
	await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
	return { frames, close: () => ws.close() };
}

async function startServer(): Promise<{
	app: FastifyInstance;
	port: number;
	lines: Record<string, unknown>[];
}> {
	const tokenPath = join(homeDir, "agent.token");
	await writeFile(tokenPath, `${TOKEN}\n`, { mode: 0o600 });
	const { logger, lines } = collectingLogger("debug");
	const app = buildServer({
		tokenPath,
		homeDir,
		tmuxSocketName: SOCKET_NAME,
		panePipeDir: join(homeDir, "server-panes"),
		logger,
	});
	await app.listen({ port: 0, host: "127.0.0.1" });
	return { app, port: (app.server.address() as { port: number }).port, lines };
}

test.skipIf(!haveTmux)(
	"a terminal created through the agent is piped, and `clear && seq` clears the browser",
	async () => {
		const { app, port, lines } = await startServer();
		try {
			const id = makeId();
			const created = await app.inject({
				method: "POST",
				url: "/terminals",
				headers: { authorization: `Bearer ${TOKEN}` },
				payload: { id, cwd: homeDir, theme: "dark", timezone: "America/New_York" },
			});
			expect(created.statusCode).toBe(201);
			expect(await panePiped(id)).toBe(true);

			const socket = await attach(port, id);
			await type(id, "seq 1 300");
			// Long enough for the pane poll to know there is history to lose.
			await new Promise((resolve) => setTimeout(resolve, 1200));
			// History refills at once, so the poll alone never sees it empty.
			await type(id, "clear && seq 1 5000");
			await eventually(() =>
				socket.frames.some((frame) => (frame as { type: string }).type === "clear"),
			);
			socket.close();
			// Request lines are fine; pane output never is.
			expect(JSON.stringify(lines)).not.toMatch(/\b4999\b/);
		} finally {
			await app.close();
		}
	},
);

test.skipIf(!haveTmux)(
	"a restarted agent pipes the terminals that outlived it, and logs none of their bytes",
	async () => {
		const id = makeId();
		await createSession(id, homeDir, homeDir, "dark", "UTC", SERVER);
		expect(await panePiped(id)).toBe(false);

		const { app, port, lines: logLines } = await startServer();
		try {
			expect(await panePiped(id)).toBe(true);
			const socket = await attach(port, id);
			await type(id, "echo SECRET-ADOPT-MARKER; clear");
			await eventually(() =>
				socket.frames.some((frame) => (frame as { type: string }).type === "clear"),
			);
			socket.close();
			expect(JSON.stringify(logLines)).not.toContain("SECRET-ADOPT-MARKER");
		} finally {
			await app.close();
		}
	},
);

test.skipIf(!haveTmux)(
	"deleting a terminal that already ended still removes its FIFO",
	async () => {
		const { app } = await startServer();
		try {
			const id = makeId();
			const created = await app.inject({
				method: "POST",
				url: "/terminals",
				headers: { authorization: `Bearer ${TOKEN}` },
				payload: { id, cwd: homeDir, theme: "dark", timezone: "America/New_York" },
			});
			expect(created.statusCode).toBe(201);
			const fifo = join(homeDir, "server-panes", id);
			expect((await stat(fifo)).isFIFO()).toBe(true);
			await exitShell(id);
			await eventually(async () => !(await panePipedSafe(id)));
			const deleted = await app.inject({
				method: "DELETE",
				url: `/terminals/${id}`,
				headers: { authorization: `Bearer ${TOKEN}` },
			});
			expect(deleted.statusCode).toBe(404);
			await eventually(() => fifoGone(fifo));
		} finally {
			await app.close();
		}
	},
	15_000,
);

async function panePipedSafe(id: string): Promise<boolean> {
	return panePiped(id).catch(() => false);
}
