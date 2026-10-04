import { CloseCode } from "@portikus/contracts";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { sessionEnded } from "../api/sessionEnded.js";
import {
	MAX_RECONNECT_ATTEMPTS,
	MAX_RECONNECT_MS,
	openTerminalSocket,
	RECONNECT_MS,
	type TerminalSocketEvents,
} from "./terminalSocket.js";

vi.mock("../api/sessionEnded.js", () => ({ sessionEnded: vi.fn() }));

class FakeSocket {
	static all: FakeSocket[] = [];
	static OPEN = 1;
	readyState = 0;
	binaryType = "blob";
	sent: string[] = [];
	closed = false;
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onclose: ((event: { code: number }) => void) | null = null;
	constructor(public url: string) {
		FakeSocket.all.push(this);
	}
	send(data: string) {
		this.sent.push(data);
	}
	close() {
		this.closed = true;
	}
	open() {
		this.readyState = 1;
		this.onopen?.();
	}
	drop(code: number) {
		this.readyState = 3;
		this.onclose?.({ code });
	}
	text(frame: unknown) {
		this.onmessage?.({ data: JSON.stringify(frame) });
	}
}

function last(): FakeSocket {
	const socket = FakeSocket.all.at(-1);
	if (!socket) throw new Error("no socket");
	return socket;
}

function events(): TerminalSocketEvents {
	return {
		size: () => ({ cols: 80, rows: 24 }),
		onOpen: vi.fn(),
		onClose: vi.fn(),
		onReconnecting: vi.fn(),
		onLost: vi.fn(),
		onTooMany: vi.fn(),
		onOutput: vi.fn(),
		onFirstOutput: vi.fn(),
		onExit: vi.fn(),
		onGone: vi.fn(),
		onError: vi.fn(),
		onCwd: vi.fn(),
		onScreen: vi.fn(),
		onClear: vi.fn(),
		onAgent: vi.fn(),
	};
}

beforeEach(() => {
	FakeSocket.all = [];
	vi.useFakeTimers();
	vi.stubGlobal("WebSocket", FakeSocket);
	vi.mocked(sessionEnded).mockClear();
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

test("connects to the terminal's socket with the pane's size (SPEC.md §9.7)", () => {
	openTerminalSocket("w1", "t1", events());
	expect(last().url).toMatch(/\/workspaces\/w1\/terminals\/t1\/ws\?cols=80&rows=24$/);
	expect(last().binaryType).toBe("arraybuffer");
});

test("a dropped socket retries with a doubling wait, capped at the maximum", () => {
	const handlers = events();
	openTerminalSocket("w1", "t1", handlers);
	last().open();
	let wait = RECONNECT_MS;
	for (let drop = 0; drop < MAX_RECONNECT_ATTEMPTS - 1; drop++) {
		const before = FakeSocket.all.length;
		last().drop(1006);
		expect(handlers.onReconnecting).toHaveBeenCalledTimes(drop + 1);
		vi.advanceTimersByTime(wait - 1);
		expect(FakeSocket.all.length).toBe(before);
		vi.advanceTimersByTime(1);
		expect(FakeSocket.all.length).toBe(before + 1);
		wait = Math.min(wait * 2, MAX_RECONNECT_MS);
	}
});

test("an open socket resets the backoff and the attempt count", () => {
	const handlers = events();
	openTerminalSocket("w1", "t1", handlers);
	last().drop(1006);
	vi.advanceTimersByTime(RECONNECT_MS);
	last().drop(1006);
	vi.advanceTimersByTime(RECONNECT_MS * 2);
	last().open();
	const before = FakeSocket.all.length;
	last().drop(1006);
	vi.advanceTimersByTime(RECONNECT_MS);
	expect(FakeSocket.all.length).toBe(before + 1);
	expect(handlers.onLost).not.toHaveBeenCalled();
});

test("five failed attempts in a row stop retrying and report the terminal lost", () => {
	const handlers = events();
	openTerminalSocket("w1", "t1", handlers);
	for (let attempt = 1; attempt < MAX_RECONNECT_ATTEMPTS; attempt++) {
		last().drop(1006);
		vi.runOnlyPendingTimers();
	}
	expect(FakeSocket.all.length).toBe(MAX_RECONNECT_ATTEMPTS);
	last().drop(1006);
	expect(handlers.onLost).toHaveBeenCalledTimes(1);
	vi.runAllTimers();
	expect(FakeSocket.all.length).toBe(MAX_RECONNECT_ATTEMPTS);
});

test.each([
	["policy", CloseCode.POLICY],
	["message too big", 1009],
	["server error", CloseCode.SERVER_ERROR],
])("a %s close is fatal: no retry", (_name, code) => {
	const handlers = events();
	openTerminalSocket("w1", "t1", handlers);
	last().open();
	last().drop(code);
	expect(handlers.onLost).toHaveBeenCalledTimes(1);
	expect(handlers.onReconnecting).not.toHaveBeenCalled();
	vi.runAllTimers();
	expect(FakeSocket.all.length).toBe(1);
});

test("a too-many-sockets close says so and does not retry (SPEC.md §24.13)", () => {
	const handlers = events();
	openTerminalSocket("w1", "t1", handlers);
	last().drop(CloseCode.TOO_MANY_SOCKETS);
	expect(handlers.onTooMany).toHaveBeenCalledTimes(1);
	expect(handlers.onLost).not.toHaveBeenCalled();
	expect(handlers.onReconnecting).not.toHaveBeenCalled();
	vi.runAllTimers();
	expect(FakeSocket.all.length).toBe(1);
});

test("a session-ended close hands over to sessionEnded and does not retry (SPEC.md §5.3)", () => {
	const handlers = events();
	openTerminalSocket("w1", "t1", handlers);
	last().open();
	last().drop(CloseCode.SESSION_ENDED);
	expect(sessionEnded).toHaveBeenCalledTimes(1);
	expect(handlers.onLost).not.toHaveBeenCalled();
	vi.runAllTimers();
	expect(FakeSocket.all.length).toBe(1);
});

test("an exit frame stops the socket for good", () => {
	const handlers = events();
	openTerminalSocket("w1", "t1", handlers);
	last().open();
	last().text({ type: "exit" });
	expect(handlers.onExit).toHaveBeenCalledTimes(1);
	expect(last().closed).toBe(true);
	last().drop(1006);
	vi.runAllTimers();
	expect(FakeSocket.all.length).toBe(1);
	expect(handlers.onReconnecting).not.toHaveBeenCalled();
});

test("an error with a reason is a gone terminal; one without is only reported", () => {
	const handlers = events();
	openTerminalSocket("w1", "t1", handlers);
	last().open();
	last().text({ type: "error", code: "TMUX_FAILED" });
	expect(handlers.onError).toHaveBeenCalledWith("TMUX_FAILED");
	expect(last().closed).toBe(false);
	last().text({
		type: "error",
		code: "TERMINAL_NOT_FOUND",
		reason: "restarted",
		at: "x",
	});
	expect(handlers.onGone).toHaveBeenCalledTimes(1);
	expect(last().closed).toBe(true);
});

test("output is written, and the first output on each socket asks for the size again", () => {
	const handlers = events();
	openTerminalSocket("w1", "t1", handlers);
	last().open();
	last().onmessage?.({ data: new Uint8Array([104, 105]).buffer });
	last().onmessage?.({ data: new Uint8Array([33]).buffer });
	expect(handlers.onOutput).toHaveBeenCalledTimes(2);
	expect(handlers.onFirstOutput).toHaveBeenCalledTimes(1);
	last().drop(1006);
	vi.runOnlyPendingTimers();
	last().open();
	last().onmessage?.({ data: new Uint8Array([33]).buffer });
	expect(handlers.onFirstOutput).toHaveBeenCalledTimes(2);
});

test("send only writes to an open socket, and stop cancels a pending retry", () => {
	const handlers = events();
	const channel = openTerminalSocket("w1", "t1", handlers);
	channel.send({ type: "input", data: "a" });
	expect(last().sent).toEqual([]);
	last().open();
	channel.send({ type: "input", data: "a" });
	expect(last().sent).toEqual([JSON.stringify({ type: "input", data: "a" })]);
	last().drop(1006);
	channel.stop();
	vi.runAllTimers();
	expect(FakeSocket.all.length).toBe(1);
});
