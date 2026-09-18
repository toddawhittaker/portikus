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
import { type AttachOptions, TerminalRegistry } from "./terminals.js";
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
	readonly writes: string[] = [];
	readonly resizes: { cols: number; rows: number }[] = [];
	killed = false;
	constructor(
		readonly cols = 80,
		readonly rows = 24,
	) {}

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
	resize(cols: number, rows: number) {
		this.resizes.push({ cols, rows });
	}
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
	resize(cols: number, rows: number) {
		this.fire("message", Buffer.from(JSON.stringify({ type: "resize", cols, rows })));
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

interface PendingHarness extends Omit<Harness, "pty"> {
	/** Null until the registry spawns the PTY. */
	ptyOf: () => FakePty | null;
	attached: Promise<void>;
}

/**
 * Start an attach without waiting for it, so a test can send frames during
 * the window before the PTY exists.
 */
async function startAttach(options: AttachOptions = {}): Promise<PendingHarness> {
	const id = makeId();
	await createSession(id, homeDir, homeDir, SOCKET_NAME);
	let pty: FakePty | null = null;
	const { logger, lines } = collectingLogger();
	const registry = new TerminalRegistry(
		homeDir,
		logger as unknown as FastifyBaseLogger,
		SOCKET_NAME,
		((_file: string, _args: string[], opts: { cols: number; rows: number }) => {
			pty = new FakePty(opts.cols, opts.rows);
			return pty as unknown as IPty;
		}) as unknown as typeof spawn,
	);
	const socket = new FakeSocket();
	const attached = registry.attach(id, socket as unknown as WebSocket, options);
	return { registry, socket, id, lines, attached, ptyOf: () => pty };
}

async function attachFake(): Promise<Harness> {
	const pending = await startAttach();
	await pending.attached;
	const pty = pending.ptyOf();
	if (!pty) throw new Error("no pty was spawned");
	return { ...pending, pty };
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
	// Real time rather than a frozen clock: the queue's timer is created
	// inside `attach`, which also awaits tmux, and a clock taken over part way
	// through that would only sometimes hold the timer it is meant to drive.
	const { pty, socket, registry, id } = await attachFake();

	socket.input("silent");
	expect(pty.writes).toEqual([]);

	await new Promise((resolve) => setTimeout(resolve, 200));
	expect(pty.writes).toEqual([]);

	await vi.waitFor(() => expect(pty.writes).toEqual(["silent"]), { timeout: 2000 });

	registry.closeAll(id, 1000, "done");
	await killSession(id, SOCKET_NAME);
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
	const { pty, socket, id } = await attachFake();

	socket.input("gone");
	socket.close();

	// Well past the queue timeout: nothing was ever written, and the attach
	// process was killed.
	await new Promise((resolve) => setTimeout(resolve, 700));
	expect(pty.writes).toEqual([]);
	expect(pty.killed).toBe(true);

	await killSession(id, SOCKET_NAME);
});

test.skipIf(!haveTmux)(
	"a resize sent before the pty exists sizes the pty",
	async () => {
		const pending = await startAttach({ cols: 80, rows: 24 });
		// The PTY does not exist yet: attach is still checking the tmux session.
		expect(pending.ptyOf()).toBeNull();
		pending.socket.resize(60, 13);
		await pending.attached;

		const pty = pending.ptyOf();
		expect(pty).not.toBeNull();
		expect({ cols: pty?.cols, rows: pty?.rows }).toEqual({ cols: 60, rows: 13 });

		pending.registry.closeAll(pending.id, 1000, "done");
		await killSession(pending.id, SOCKET_NAME);
	},
);

test.skipIf(!haveTmux)("only the last early resize is used", async () => {
	const pending = await startAttach({ cols: 80, rows: 24 });
	pending.socket.resize(100, 30);
	pending.socket.resize(60, 13);
	await pending.attached;

	const pty = pending.ptyOf();
	expect({ cols: pty?.cols, rows: pty?.rows }).toEqual({ cols: 60, rows: 13 });

	pending.registry.closeAll(pending.id, 1000, "done");
	await killSession(pending.id, SOCKET_NAME);
});

test.skipIf(!haveTmux)(
	"input sent before the pty exists is written in order after the first output",
	async () => {
		const pending = await startAttach();
		pending.socket.input("early");
		await pending.attached;

		const pty = pending.ptyOf();
		if (!pty) throw new Error("no pty was spawned");
		pending.socket.input("late");
		expect(pty.writes).toEqual([]);

		pty.emit("prompt$ ");
		expect(pty.writes).toEqual(["early", "late"]);

		pending.registry.closeAll(pending.id, 1000, "done");
		await killSession(pending.id, SOCKET_NAME);
	},
);

test.skipIf(!haveTmux)(
	"a socket that closes before the pty exists leaves no attachment and no pty",
	async () => {
		const pending = await startAttach();
		pending.socket.input("gone");
		pending.socket.close();
		await pending.attached;

		expect(pending.ptyOf()).toBeNull();
		expect(pending.registry.countAttachments(pending.id)).toBe(0);

		await killSession(pending.id, SOCKET_NAME);
	},
);

test.skipIf(!haveTmux)(
	"early frames before the pty respect the queue cap",
	async () => {
		const pending = await startAttach();
		const big = "x".repeat(48 * 1024);
		pending.socket.input("first");
		pending.socket.input(big);
		// Three more that do not fit: one log line between them, not three.
		pending.socket.input(big);
		pending.socket.input(big);
		pending.socket.input(big);
		await pending.attached;

		const warnings = pending.lines.filter(
			(line) => line.msg === "dropping early terminal input: queue full",
		);
		expect(warnings).toHaveLength(1);

		const pty = pending.ptyOf();
		if (!pty) throw new Error("no pty was spawned");
		pty.emit("prompt$ ");
		expect(pty.writes).toEqual(["first", big]);

		pending.registry.closeAll(pending.id, 1000, "done");
		await killSession(pending.id, SOCKET_NAME);
	},
);
