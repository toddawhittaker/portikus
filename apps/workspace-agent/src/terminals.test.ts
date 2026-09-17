import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { WebSocket } from "@fastify/websocket";
import { collectingLogger } from "@portikus/observability/testing";
import type { FastifyBaseLogger } from "fastify";
import type { IPty, spawn } from "node-pty";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { TerminalRegistry } from "./terminals.js";
import { createSession, killSession } from "./tmux.js";

const run = promisify(execFile);
const SOCKET_NAME = `portikus-queue-${process.pid}`;

let homeDir: string;

async function tmuxAvailable(): Promise<boolean> {
	try {
		await run("tmux", ["-V"]);
		return true;
	} catch {
		return false;
	}
}

const haveTmux = await tmuxAvailable();

/** A PTY the test drives: it records writes and emits output on demand. */
class FakePty {
	readonly pid = 4242;
	readonly cols = 80;
	readonly rows = 24;
	readonly writes: string[] = [];
	killed = false;
	private dataHandler: ((data: string) => void) | null = null;
	private exitHandler: (() => void) | null = null;

	onData(handler: (data: string) => void) {
		this.dataHandler = handler;
		return { dispose: () => undefined };
	}
	onExit(handler: () => void) {
		this.exitHandler = handler;
		return { dispose: () => undefined };
	}
	write(data: string) {
		this.writes.push(data);
	}
	resize() {}
	pause() {}
	resume() {}
	kill() {
		this.killed = true;
	}
	emit(data: string) {
		this.dataHandler?.(data);
	}
	exit() {
		this.exitHandler?.();
	}
}

/** Just enough of a WebSocket for the registry to talk to. */
class FakeSocket {
	bufferedAmount = 0;
	readonly sent: (string | Buffer)[] = [];
	private readonly handlers = new Map<string, ((arg: unknown) => void)[]>();

	on(event: string, handler: (arg: unknown) => void) {
		const list = this.handlers.get(event) ?? [];
		list.push(handler);
		this.handlers.set(event, list);
		return this;
	}
	send(data: string | Buffer) {
		this.sent.push(data);
	}
	close() {
		this.fire("close", undefined);
	}
	fire(event: string, arg: unknown) {
		for (const handler of this.handlers.get(event) ?? []) handler(arg);
	}
	input(data: string) {
		this.fire("message", Buffer.from(JSON.stringify({ type: "input", data })));
	}
}

let nextId = 0;
function makeId(): string {
	nextId += 1;
	return `00000000-0000-4000-8000-${String(1000 + nextId)}00000000`;
}

interface Harness {
	registry: TerminalRegistry;
	pty: FakePty;
	socket: FakeSocket;
	id: string;
	lines: Record<string, unknown>[];
}

async function attachFake(): Promise<Harness> {
	const id = makeId();
	await createSession(id, homeDir, homeDir, SOCKET_NAME);
	const pty = new FakePty();
	const { logger, lines } = collectingLogger();
	const registry = new TerminalRegistry(
		homeDir,
		logger as unknown as FastifyBaseLogger,
		SOCKET_NAME,
		(() => pty as unknown as IPty) as unknown as typeof spawn,
	);
	const socket = new FakeSocket();
	await registry.attach(id, socket as unknown as WebSocket, {});
	return { registry, pty, socket, id, lines };
}

beforeAll(async () => {
	if (!haveTmux) return;
	homeDir = await mkdtemp(join(tmpdir(), "portikus-queue-"));
});

afterAll(async () => {
	if (!haveTmux) return;
	await run("tmux", ["-L", SOCKET_NAME, "kill-server"]).catch(() => undefined);
});

test.skipIf(!haveTmux)(
	"early input waits for the first output, then flows",
	async () => {
		const { pty, socket, registry, id } = await attachFake();

		socket.input("one");
		socket.input("two");
		expect(pty.writes).toEqual([]);

		pty.emit("prompt$ ");
		expect(pty.writes).toEqual(["one", "two"]);

		socket.input("three");
		expect(pty.writes).toEqual(["one", "two", "three"]);

		registry.closeAll(id, 1000, "done");
		await killSession(id, SOCKET_NAME);
	},
);

test.skipIf(!haveTmux)("early input is flushed after the queue timeout", async () => {
	vi.useFakeTimers();
	try {
		const { pty, socket, registry, id } = await attachFake();

		socket.input("silent");
		expect(pty.writes).toEqual([]);

		vi.advanceTimersByTime(499);
		expect(pty.writes).toEqual([]);

		vi.advanceTimersByTime(1);
		expect(pty.writes).toEqual(["silent"]);

		registry.closeAll(id, 1000, "done");
		await killSession(id, SOCKET_NAME);
	} finally {
		vi.useRealTimers();
	}
});

test.skipIf(!haveTmux)(
	"input past the queue cap is dropped with one warning",
	async () => {
		const { pty, socket, lines, registry, id } = await attachFake();

		socket.input("first");
		// Two 48 KiB frames: the second one would take the queue past 64 KiB.
		const big = "x".repeat(48 * 1024);
		socket.input(big);
		socket.input(big);

		const warnings = lines.filter(
			(line) => line.msg === "dropping early terminal input: queue full",
		);
		expect(warnings).toHaveLength(1);

		pty.emit("prompt$ ");
		expect(pty.writes).toEqual(["first", big]);

		registry.closeAll(id, 1000, "done");
		await killSession(id, SOCKET_NAME);
	},
);

test.skipIf(!haveTmux)("closing the socket drops the queue and its timer", async () => {
	vi.useFakeTimers();
	try {
		const { pty, socket, id } = await attachFake();

		socket.input("gone");
		socket.close();

		vi.advanceTimersByTime(5000);
		expect(pty.writes).toEqual([]);
		expect(pty.killed).toBe(true);

		await killSession(id, SOCKET_NAME);
	} finally {
		vi.useRealTimers();
	}
});
