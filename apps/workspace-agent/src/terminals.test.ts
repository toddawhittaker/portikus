import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { WebSocket } from "@fastify/websocket";
import { collectingLogger } from "@portikus/observability/testing";
import type { FastifyBaseLogger } from "fastify";
import type { IPty, spawn } from "node-pty";
import { afterAll, afterEach, beforeAll, describe, expect, it, test, vi } from "vitest";
import { type AttachOptions, attachExitReason, TerminalRegistry } from "./terminals.js";
import { claimWindowSize, createSession, killSession } from "./tmux.js";

// Calls through to the real function, so tests can count claims.
vi.mock("./tmux.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("./tmux.js")>();
	return { ...actual, claimWindowSize: vi.fn(actual.claimWindowSize) };
});

const run = promisify(execFile);
const SOCKET_NAME = `portikus-queue-${process.pid}`;
const SERVER = { socketName: SOCKET_NAME, external: false };

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
	/** The tmux command line the PTY was spawned with. */
	spawnArgs: string[];
}

/**
 * Start an attach without waiting for it, so a test can send frames during
 * the window before the PTY exists.
 */
async function startAttach(options: AttachOptions = {}): Promise<PendingHarness> {
	const id = makeId();
	await createSession(id, homeDir, homeDir, "dark", "America/New_York", SERVER);
	let pty: FakePty | null = null;
	const { logger, lines } = collectingLogger();
	const registry = new TerminalRegistry(
		homeDir,
		logger as unknown as FastifyBaseLogger,
		SERVER,
		((_file: string, args: string[], opts: { cols: number; rows: number }) => {
			pty = new FakePty(opts.cols, opts.rows);
			spawnArgs.push(...args);
			return pty as unknown as IPty;
		}) as unknown as typeof spawn,
	);
	const socket = new FakeSocket();
	const spawnArgs: string[] = [];
	const attached = registry.attach(id, socket as unknown as WebSocket, options);
	return { registry, socket, id, lines, attached, ptyOf: () => pty, spawnArgs };
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
		await killSession(id, SERVER);
	},
);

// A stop that hits an attach client closes the student's terminal (SPEC.md §18.3).
test.skipIf(!haveTmux)(
	"the attach clients' PIDs are known while they run",
	async () => {
		const { pty, registry, id } = await attachFake();
		expect([...registry.attachPids()]).toEqual([pty.pid]);

		pty.exit();
		expect([...registry.attachPids()]).toEqual([]);

		registry.closeAll(id, 1000, "done");
		await killSession(id, SERVER);
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
	await killSession(id, SERVER);
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
		await killSession(id, SERVER);
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

	await killSession(id, SERVER);
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
		await killSession(pending.id, SERVER);
	},
);

test.skipIf(!haveTmux)(
	"an attachment does not size the window until the browser sends a size",
	async () => {
		const pending = await startAttach({ cols: 12, rows: 6 });
		await pending.attached;
		expect(pending.spawnArgs.slice(-2)).toEqual(["-f", "ignore-size"]);
		pending.registry.closeAll(pending.id, 1000, "done");
		await killSession(pending.id, SERVER);
	},
);

test.skipIf(!haveTmux)(
	"an attachment whose size arrived before the pty sizes the window at once",
	async () => {
		const pending = await startAttach({ cols: 12, rows: 6 });
		pending.socket.resize(100, 30);
		await pending.attached;
		expect(pending.spawnArgs).not.toContain("ignore-size");
		pending.registry.closeAll(pending.id, 1000, "done");
		await killSession(pending.id, SERVER);
	},
);

/** The window's size as tmux reports it. */
async function windowSize(id: string): Promise<string> {
	const { stdout } = await run("tmux", [
		...["-L", SOCKET_NAME, "display-message", "-p", "-t", `pk-${id}`],
		"#{window_width}x#{window_height}",
	]);
	return stdout.trim();
}

test.skipIf(!haveTmux)(
	"only a browser's measured size sizes the window, and sending it again wins it back",
	async () => {
		const id = makeId();
		await createSession(id, homeDir, homeDir, "dark", "UTC", SERVER);
		const { logger } = collectingLogger();
		const registry = new TerminalRegistry(
			homeDir,
			logger as unknown as FastifyBaseLogger,
			SERVER,
		);
		const a = new FakeSocket();
		const b = new FakeSocket();
		try {
			await registry.attach(id, a as unknown as WebSocket, { cols: 120, rows: 40 });
			a.resize(120, 40);
			await vi.waitFor(async () => expect(await windowSize(id)).toBe("120x40"));

			// The window is 120x40 from A's attach alone. Wait for A's claim to
			// finish, or B's attach can win the window while it is still running.
			// A browser sends its size again until it is accepted; so does this.
			await vi.waitFor(async () => {
				a.resize(120, 40);
				const { stdout } = await run("tmux", [
					...["-L", SOCKET_NAME, "list-clients", "-t", `pk-${id}`],
					...["-F", "#{client_flags}"],
				]);
				expect(stdout).not.toContain("ignore-size");
			});

			// B connects with a size measured while its pane was settling.
			await registry.attach(id, b as unknown as WebSocket, { cols: 12, rows: 6 });
			await vi.waitFor(async () => {
				const { stdout } = await run("tmux", [
					...["-L", SOCKET_NAME, "list-clients", "-t", `pk-${id}`],
				]);
				expect(stdout.trim().split("\n")).toHaveLength(2);
			});
			expect(await windowSize(id)).toBe("120x40");

			b.resize(80, 20);
			await vi.waitFor(async () => expect(await windowSize(id)).toBe("80x20"));

			// A's size is unchanged, but sending it again takes the window back.
			a.resize(120, 40);
			await vi.waitFor(async () => expect(await windowSize(id)).toBe("120x40"));
		} finally {
			registry.closeAll(id, 1000, "done");
			await killSession(id, SERVER);
		}
	},
);

test.skipIf(!haveTmux)(
	"a resize to the size the pty has does not resize it",
	async () => {
		const { registry, pty, socket, id } = await attachFake();
		socket.resize(pty.cols, pty.rows);
		expect(pty.resizes).toEqual([]);
		registry.closeAll(id, 1000, "done");
		await killSession(id, SERVER);
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
	await killSession(pending.id, SERVER);
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
		await killSession(pending.id, SERVER);
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

		await killSession(pending.id, SERVER);
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
		await killSession(pending.id, SERVER);
	},
);

test.skipIf(!haveTmux)(
	"an exit says whether the terminals unit's tmux server is gone",
	async () => {
		const socketName = `portikus-gone-${process.pid}`;
		const external = { socketName, external: true };
		const ids = [makeId(), makeId()];
		for (const id of ids) {
			await createSession(id, homeDir, homeDir, "dark", "UTC", {
				socketName,
				external: false,
			});
		}
		const ptys: FakePty[] = [];
		const { logger } = collectingLogger();
		const registry = new TerminalRegistry(
			homeDir,
			logger as unknown as FastifyBaseLogger,
			external,
			((_file: string, _args: string[], opts: { cols: number; rows: number }) => {
				const pty = new FakePty(opts.cols, opts.rows);
				ptys.push(pty);
				return pty as unknown as IPty;
			}) as unknown as typeof spawn,
		);
		const sockets = ids.map(() => new FakeSocket());
		for (const [index, id] of ids.entries()) {
			await registry.attach(id, sockets[index] as unknown as WebSocket, {});
		}
		const exitFrame = (socket: FakeSocket) =>
			socket.sent
				.filter((frame): frame is string => typeof frame === "string")
				.map((frame) => JSON.parse(frame) as { type: string; serverGone?: boolean })
				.find((frame) => frame.type === "exit");

		// A shell that ends leaves the server running: an ordinary exit.
		ptys[0]?.emit("[exited]\r\n");
		ptys[0]?.exit();
		await vi.waitFor(() => expect(exitFrame(sockets[0] as FakeSocket)).toBeDefined());
		expect(exitFrame(sockets[0] as FakeSocket)?.serverGone).toBe(false);

		// The unit dies and takes the server with it.
		await run("tmux", ["-L", socketName, "kill-server"]);
		ptys[1]?.emit("\x1b[?1049l[server exited]\r\n");
		ptys[1]?.exit();
		await vi.waitFor(() => expect(exitFrame(sockets[1] as FakeSocket)).toBeDefined());
		expect(exitFrame(sockets[1] as FakeSocket)?.serverGone).toBe(true);
	},
);

test.skipIf(!haveTmux)(
	"a pty that exits after its socket closed sends nothing",
	async () => {
		const socketName = `portikus-closed-${process.pid}`;
		const server = { socketName, external: true };
		const id = makeId();
		await createSession(id, homeDir, homeDir, "dark", "UTC", {
			socketName,
			external: false,
		});
		const ptys: FakePty[] = [];
		const { logger } = collectingLogger();
		const registry = new TerminalRegistry(
			homeDir,
			logger as unknown as FastifyBaseLogger,
			server,
			((_file: string, _args: string[], opts: { cols: number; rows: number }) => {
				const pty = new FakePty(opts.cols, opts.rows);
				ptys.push(pty);
				return pty as unknown as IPty;
			}) as unknown as typeof spawn,
		);
		const socket = new FakeSocket();
		await registry.attach(id, socket as unknown as WebSocket, {});
		socket.close();
		const sentBefore = socket.sent.length;
		ptys[0]?.exit();
		await new Promise((resolve) => setTimeout(resolve, 200));
		expect(socket.sent.length).toBe(sentBefore);
		await run("tmux", ["-L", socketName, "kill-server"]);
	},
);

describe("attachExitReason", () => {
	it("reads the attach client's final line", () => {
		expect(attachExitReason("\x1b[23;0;0t[exited]\r\n")).toBe(false);
		expect(attachExitReason("\x1b[23;0;0t[server exited]\r\n")).toBe(true);
		expect(attachExitReason("[server exited unexpectedly]\n")).toBe(true);
		expect(attachExitReason("prompt$ ")).toBeUndefined();
	});

	it("ignores a student's own line that tmux's exit line follows", () => {
		expect(attachExitReason("[server exited]\r\n$ exit\r\n[exited]\r\n")).toBe(false);
		expect(attachExitReason("[server exited]\r\nmore output\r\n")).toBeUndefined();
	});
});

test.skipIf(!haveTmux)(
	"the last terminal's ordinary exit sends its exit frame at once",
	async () => {
		const socketName = `portikus-last-${process.pid}`;
		const id = makeId();
		await createSession(id, homeDir, homeDir, "dark", "UTC", {
			socketName,
			external: false,
		});
		const ptys: FakePty[] = [];
		const { logger } = collectingLogger();
		const registry = new TerminalRegistry(
			homeDir,
			logger as unknown as FastifyBaseLogger,
			{ socketName, external: true },
			((_file: string, _args: string[], opts: { cols: number; rows: number }) => {
				const pty = new FakePty(opts.cols, opts.rows);
				ptys.push(pty);
				return pty as unknown as IPty;
			}) as unknown as typeof spawn,
		);
		const socket = new FakeSocket();
		await registry.attach(id, socket as unknown as WebSocket, {});
		ptys[0]?.emit("[exited]\r\n");
		ptys[0]?.exit();
		await Promise.resolve();
		await Promise.resolve();
		const exit = socket.sent
			.filter((frame): frame is string => typeof frame === "string")
			.map((frame) => JSON.parse(frame) as { type: string; serverGone?: boolean })
			.find((frame) => frame.type === "exit");
		expect(exit).toEqual({ type: "exit", serverGone: false });
		await run("tmux", ["-L", socketName, "kill-server"]);
	},
);

// Every claim makes tmux repaint the screen, which a screen reader announces
// as new output, so a claim that changes nothing must not run (SPEC.md §9.7,
// WCAG 4.1.3).
describe("claiming the window size", () => {
	const claimSpy = vi.mocked(claimWindowSize);
	const SIZE = { cols: 80, rows: 24 };

	afterEach(async () => {
		const actual = await vi.importActual<typeof import("./tmux.js")>("./tmux.js");
		claimSpy.mockReset().mockImplementation(actual.claimWindowSize);
	});

	/** One registry on one tmux session, handing out a fake PTY per attach. */
	async function startTerminal() {
		const id = makeId();
		await createSession(id, homeDir, homeDir, "dark", "UTC", SERVER);
		const { logger } = collectingLogger();
		const ptys: FakePty[] = [];
		const registry = new TerminalRegistry(
			homeDir,
			logger as unknown as FastifyBaseLogger,
			SERVER,
			((_file: string, _args: string[], opts: { cols: number; rows: number }) => {
				const pty = new FakePty(opts.cols, opts.rows);
				ptys.push(pty);
				return pty as unknown as IPty;
			}) as unknown as typeof spawn,
		);
		const join = async (options: AttachOptions = SIZE) => {
			const socket = new FakeSocket();
			await registry.attach(id, socket as unknown as WebSocket, options);
			// Output releases the early-input queue, so typing reaches the pty.
			ptys.at(-1)?.emit("prompt$ ");
			return socket;
		};
		// The claim runs in a promise, so let it settle before counting.
		const settle = () => new Promise((resolve) => setImmediate(resolve));
		const holder = () =>
			(registry as unknown as { claimers: Map<string, unknown> }).claimers.get(id);
		const done = async () => {
			registry.closeAll(id, 1000, "done");
			await killSession(id, SERVER);
		};
		return { id, registry, ptys, join, settle, holder, done };
	}

	test.skipIf(!haveTmux)(
		"a claim that finds no client leaves the attachment unsized, so the next size claims again",
		async () => {
			const { join, settle, done } = await startTerminal();
			try {
				claimSpy.mockResolvedValue(false);
				const socket = await join();

				socket.resize(SIZE.cols, SIZE.rows);
				await settle();
				expect(claimSpy).toHaveBeenCalledTimes(1);

				socket.resize(SIZE.cols, SIZE.rows);
				await settle();
				expect(claimSpy).toHaveBeenCalledTimes(2);

				// Once a claim succeeds the attachment is sized and stops claiming.
				claimSpy.mockResolvedValue(true);
				socket.resize(SIZE.cols, SIZE.rows);
				await settle();
				expect(claimSpy).toHaveBeenCalledTimes(3);
				socket.resize(SIZE.cols, SIZE.rows);
				await settle();
				expect(claimSpy).toHaveBeenCalledTimes(3);
			} finally {
				await done();
			}
		},
	);

	test.skipIf(!haveTmux)(
		"a lone attachment sending its unchanged size again runs no claim",
		async () => {
			const { join, settle, done } = await startTerminal();
			try {
				claimSpy.mockResolvedValue(true);
				const socket = await join();

				socket.resize(SIZE.cols, SIZE.rows);
				await settle();
				expect(claimSpy).toHaveBeenCalledTimes(1);

				socket.resize(SIZE.cols, SIZE.rows);
				socket.resize(SIZE.cols, SIZE.rows);
				await settle();
				expect(claimSpy).toHaveBeenCalledTimes(1);
			} finally {
				await done();
			}
		},
	);

	test.skipIf(!haveTmux)(
		"a lone attachment sized before its pty existed runs no claim for an unchanged size",
		async () => {
			const { id, registry, settle, done } = await startTerminal();
			try {
				claimSpy.mockResolvedValue(true);
				const socket = new FakeSocket();
				const attached = registry.attach(id, socket as unknown as WebSocket, SIZE);
				socket.resize(SIZE.cols, SIZE.rows);
				await attached;

				socket.resize(SIZE.cols, SIZE.rows);
				await settle();
				expect(claimSpy).not.toHaveBeenCalled();
			} finally {
				await done();
			}
		},
	);

	test.skipIf(!haveTmux)(
		"the holder re-sending its size runs no claim, but another attachment re-sending does and then holds it",
		async () => {
			const { join, settle, done } = await startTerminal();
			try {
				claimSpy.mockResolvedValue(true);
				const a = await join();
				const b = await join();

				a.resize(SIZE.cols, SIZE.rows);
				await settle();
				expect(claimSpy).toHaveBeenCalledTimes(1);

				// B's first measured size claims, so B now holds the window.
				b.resize(SIZE.cols, SIZE.rows);
				await settle();
				expect(claimSpy).toHaveBeenCalledTimes(2);

				b.resize(SIZE.cols, SIZE.rows);
				await settle();
				expect(claimSpy).toHaveBeenCalledTimes(2);

				// A is sized but no longer the holder, so it claims and takes over.
				a.resize(SIZE.cols, SIZE.rows);
				await settle();
				expect(claimSpy).toHaveBeenCalledTimes(3);

				a.resize(SIZE.cols, SIZE.rows);
				await settle();
				expect(claimSpy).toHaveBeenCalledTimes(3);

				b.resize(SIZE.cols, SIZE.rows);
				await settle();
				expect(claimSpy).toHaveBeenCalledTimes(4);
			} finally {
				await done();
			}
		},
	);

	// The remembered claimer is private and cannot be seen from behaviour: a
	// stale entry for a closed socket would act like none, but it would keep
	// the attachment alive.
	test.skipIf(!haveTmux)(
		"closing the holder clears the remembered claimer, and closing another attachment does not",
		async () => {
			const { join, settle, holder, done } = await startTerminal();
			try {
				claimSpy.mockResolvedValue(true);
				const a = await join();
				const b = await join();
				a.resize(SIZE.cols, SIZE.rows);
				await settle();
				b.resize(SIZE.cols, SIZE.rows);
				await settle();
				expect(holder()).toBeDefined();

				a.close();
				expect(holder()).toBeDefined();

				b.close();
				expect(holder()).toBeUndefined();
			} finally {
				await done();
			}
		},
	);

	test.skipIf(!haveTmux)(
		"closing the terminal clears the remembered claimer",
		async () => {
			const { id, registry, join, settle, holder, done } = await startTerminal();
			try {
				claimSpy.mockResolvedValue(true);
				const a = await join();
				a.resize(SIZE.cols, SIZE.rows);
				await settle();
				expect(holder()).toBeDefined();

				registry.closeAll(id, 1000, "done");
				expect(holder()).toBeUndefined();
			} finally {
				await done();
			}
		},
	);

	// tmux sizes the window to the client that typed last, so typing takes the
	// window from the holder without a claim (SPEC.md §9.7).
	test.skipIf(!haveTmux)(
		"after another attachment types, the earlier holder re-sending its size claims again",
		async () => {
			const { join, settle, done } = await startTerminal();
			try {
				claimSpy.mockResolvedValue(true);
				const a = await join();
				const b = await join();
				a.resize(SIZE.cols, SIZE.rows);
				await settle();
				b.resize(SIZE.cols, SIZE.rows);
				await settle();
				expect(claimSpy).toHaveBeenCalledTimes(2);

				a.input("x");
				b.resize(SIZE.cols, SIZE.rows);
				await settle();
				expect(claimSpy).toHaveBeenCalledTimes(3);

				// B holds it again, so a further resend changes nothing.
				b.resize(SIZE.cols, SIZE.rows);
				await settle();
				expect(claimSpy).toHaveBeenCalledTimes(3);
			} finally {
				await done();
			}
		},
	);

	test.skipIf(!haveTmux)(
		"a helper typing does not take the window, because its client ignores size",
		async () => {
			const { join, settle, holder, done } = await startTerminal();
			try {
				claimSpy.mockResolvedValue(true);
				const a = await join();
				const helper = await join({ ...SIZE, mode: "type" });
				a.resize(SIZE.cols, SIZE.rows);
				await settle();
				const before = holder();
				expect(before).toBeDefined();

				helper.input("x");
				expect(holder()).toBe(before);
				a.resize(SIZE.cols, SIZE.rows);
				await settle();
				expect(claimSpy).toHaveBeenCalledTimes(1);
			} finally {
				await done();
			}
		},
	);
});
