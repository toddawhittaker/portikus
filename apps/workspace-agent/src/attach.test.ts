/**
 * What `attach` does around its awaits (SPEC.md §9.1, §9.7), with tmux itself
 * replaced so the test can hold the history capture open and count how often
 * the pane is polled.
 */
import type { WebSocket } from "@fastify/websocket";
import { collectingLogger } from "@portikus/observability/testing";
import type { FastifyBaseLogger } from "fastify";
import type { IPty, spawn } from "node-pty";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const captureHistory = vi.fn<() => Promise<string>>();
const listPanes =
	vi.fn<() => Promise<Map<string, { path: string | null; alternate: boolean }>>>();

vi.mock("./tmux.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./tmux.js")>()),
	hasSession: async () => true,
	captureHistory: () => captureHistory(),
	listPanes: () => listPanes(),
}));

const { TerminalRegistry } = await import("./terminals.js");

const ID = "00000000-0000-4000-8000-000000000001";

/** Matches FIRST_POLL_MS in cwd.ts: how long before the first pane poll. */
const FIRST_POLL_MS = 250;

/** Just enough of a WebSocket for the registry to talk to. */
class FakeSocket {
	bufferedAmount = 0;
	readyState = 1;
	readonly OPEN = 1;
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
		this.readyState = 3;
		for (const handler of this.handlers.get("close") ?? []) handler(undefined);
	}
	/** The JSON frames this socket was sent, in order. */
	frames(): Record<string, unknown>[] {
		return this.sent
			.filter((item): item is string => typeof item === "string")
			.map((item) => JSON.parse(item) as Record<string, unknown>);
	}
}

let spawned: number;

function buildRegistry() {
	const { logger } = collectingLogger();
	spawned = 0;
	return new TerminalRegistry(
		"/home/student",
		logger as unknown as FastifyBaseLogger,
		{ socketName: "test-socket", external: false },
		(() => {
			spawned += 1;
			return {
				pid: 1,
				onData: () => ({ dispose: () => undefined }),
				onExit: () => ({ dispose: () => undefined }),
				write: () => undefined,
				resize: () => undefined,
				pause: () => undefined,
				resume: () => undefined,
				kill: () => undefined,
			} as unknown as IPty;
		}) as unknown as typeof spawn,
	);
}

beforeEach(() => {
	captureHistory.mockReset();
	listPanes.mockReset();
	listPanes.mockImplementation(
		async () => new Map([[ID, { path: "/home/student", alternate: false }]]),
	);
});

afterEach(() => {
	vi.useRealTimers();
});

test("no pty is spawned when the socket closes while the history is captured", async () => {
	let finishCapture: (text: string) => void = () => undefined;
	captureHistory.mockImplementation(
		() =>
			new Promise<string>((resolve) => {
				finishCapture = resolve;
			}),
	);

	const registry = buildRegistry();
	const socket = new FakeSocket();
	const attached = registry.attach(ID, socket as unknown as WebSocket, {
		cols: 80,
		rows: 24,
	});

	// Let attach reach the capture, then give up on it from the browser's end.
	await vi.waitFor(() => expect(captureHistory).toHaveBeenCalled());
	socket.close();
	finishCapture("old output\n");
	await attached;

	// A tmux attach started here would belong to nobody and never be killed.
	expect(spawned).toBe(0);
	expect(registry.countAttachments(ID)).toBe(0);
});

test("one pane poll serves every attachment of every terminal", async () => {
	// tmux is mocked here, so nothing awaits a real process and the poll can be
	// driven by fake timers instead of by sleeping.
	vi.useFakeTimers();
	captureHistory.mockResolvedValue("");
	const registry = buildRegistry();

	const sockets = [new FakeSocket(), new FakeSocket(), new FakeSocket()];
	for (const socket of sockets) {
		await registry.attach(ID, socket as unknown as WebSocket, { cols: 80, rows: 24 });
	}
	expect(registry.countAttachments(ID)).toBe(3);

	// Three browsers looking at one pane ask tmux once, not three times.
	await vi.advanceTimersByTimeAsync(FIRST_POLL_MS);
	expect(listPanes).toHaveBeenCalled();
	expect(listPanes.mock.calls.length).toBeLessThanOrEqual(2);

	// Every attachment hears the answer.
	for (const socket of sockets) {
		expect(socket.frames()).toContainEqual({ type: "cwd", path: "/home/student" });
		expect(socket.frames()).toContainEqual({ type: "screen", alternate: false });
	}

	// A browser arriving between polls is told where things stand at once.
	const latecomer = new FakeSocket();
	await registry.attach(ID, latecomer as unknown as WebSocket, { cols: 80, rows: 24 });
	expect(latecomer.frames()).toContainEqual({ type: "cwd", path: "/home/student" });
	expect(latecomer.frames()).toContainEqual({ type: "screen", alternate: false });

	// The last browser leaving stops the poll.
	for (const socket of [...sockets, latecomer]) socket.close();
	expect(registry.countAttachments(ID)).toBe(0);
	const afterClosing = listPanes.mock.calls.length;
	await vi.advanceTimersByTimeAsync(900);
	expect(listPanes.mock.calls.length).toBe(afterClosing);
});

test("the pane poll speeds up while a full-screen program holds a terminal", async () => {
	vi.useFakeTimers();
	captureHistory.mockResolvedValue("");
	const registry = buildRegistry();
	const socket = new FakeSocket();
	await registry.attach(ID, socket as unknown as WebSocket, { cols: 80, rows: 24 });

	// Idle: one poll every 500 ms.
	await vi.advanceTimersByTimeAsync(FIRST_POLL_MS);
	expect(listPanes).toHaveBeenCalled();
	const idleStart = listPanes.mock.calls.length;
	await vi.advanceTimersByTimeAsync(1000);
	const idlePolls = listPanes.mock.calls.length - idleStart;

	// Busy: twice as often, so the wheel goes back to scrolling promptly when
	// the program lets go of the screen.
	listPanes.mockImplementation(
		async () => new Map([[ID, { path: "/home/student", alternate: true }]]),
	);
	await vi.advanceTimersByTimeAsync(1000);
	const busyStart = listPanes.mock.calls.length;
	await vi.advanceTimersByTimeAsync(1000);
	const busyPolls = listPanes.mock.calls.length - busyStart;

	expect(busyPolls).toBeGreaterThan(idlePolls);
	expect(socket.frames()).toContainEqual({ type: "screen", alternate: true });

	socket.close();
});
