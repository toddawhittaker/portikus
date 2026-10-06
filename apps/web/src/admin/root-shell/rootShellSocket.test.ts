import { CloseCode } from "@portikus/contracts";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { sessionEnded } from "../../api/sessionEnded.js";
import { openRootShellSocket, type RootShellSocketEvents } from "./rootShellSocket.js";

vi.mock("../../api/sessionEnded.js", () => ({ sessionEnded: vi.fn() }));

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
}

function last(): FakeSocket {
	const socket = FakeSocket.all.at(-1);
	if (!socket) throw new Error("no socket");
	return socket;
}

function events(): RootShellSocketEvents {
	return {
		onOpen: vi.fn(),
		onOutput: vi.fn(),
		onFirstOutput: vi.fn(),
		onExit: vi.fn(),
		onLost: vi.fn(),
		onError: vi.fn(),
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

test("connects to the root-shell socket with the pane's size (ADR 0051)", () => {
	openRootShellSocket({ cols: 120, rows: 40 }, events());
	expect(last().url).toMatch(/\/admin\/root-shell\/ws\?cols=120&rows=40$/);
	expect(last().binaryType).toBe("arraybuffer");
});

test("output is written, and the first output asks for the size once", () => {
	const handlers = events();
	openRootShellSocket({ cols: 80, rows: 24 }, handlers);
	last().open();
	// An ArrayBuffer of this realm; TextEncoder's comes from Node's.
	last().onmessage?.({ data: new ArrayBuffer(1) });
	last().onmessage?.({ data: new ArrayBuffer(1) });
	expect(handlers.onOutput).toHaveBeenCalledTimes(2);
	expect(handlers.onFirstOutput).toHaveBeenCalledTimes(1);
});

test("an exit frame ends the shell and closes the socket without a loss", () => {
	const handlers = events();
	openRootShellSocket({ cols: 80, rows: 24 }, handlers);
	last().open();
	last().onmessage?.({ data: JSON.stringify({ type: "exit" }) });
	expect(handlers.onExit).toHaveBeenCalledTimes(1);
	expect(last().closed).toBe(true);
	last().drop(1000);
	expect(handlers.onLost).not.toHaveBeenCalled();
});

test("a dropped socket is never reopened: a new socket would be a new shell", () => {
	const handlers = events();
	openRootShellSocket({ cols: 80, rows: 24 }, handlers);
	last().open();
	last().drop(1006);
	vi.runAllTimers();
	expect(FakeSocket.all).toHaveLength(1);
	expect(handlers.onLost).toHaveBeenCalledWith("closed");
});

test("a revoked session hands over to the session-ended page", () => {
	const handlers = events();
	openRootShellSocket({ cols: 80, rows: 24 }, handlers);
	last().open();
	last().drop(CloseCode.SESSION_ENDED);
	expect(sessionEnded).toHaveBeenCalledTimes(1);
	expect(handlers.onLost).not.toHaveBeenCalled();
});

test("the socket cap and a stopping server each say what happened", () => {
	const capped = events();
	openRootShellSocket({ cols: 80, rows: 24 }, capped);
	last().drop(CloseCode.TOO_MANY_SOCKETS);
	expect(capped.onLost).toHaveBeenCalledWith("too_many");

	const stopping = events();
	openRootShellSocket({ cols: 80, rows: 24 }, stopping);
	last().open();
	last().drop(1001);
	expect(stopping.onLost).toHaveBeenCalledWith("server_stopped");
});

test("an error frame without a reason is reported and the shell stays", () => {
	const handlers = events();
	openRootShellSocket({ cols: 80, rows: 24 }, handlers);
	last().open();
	last().onmessage?.({ data: JSON.stringify({ type: "error", code: "BAD_FRAME" }) });
	expect(handlers.onError).toHaveBeenCalledWith("BAD_FRAME");
	expect(last().closed).toBe(false);
});

test("input goes out only on an open socket, and stop reports no loss", () => {
	const handlers = events();
	const socket = openRootShellSocket({ cols: 80, rows: 24 }, handlers);
	socket.send({ type: "input", data: "early" });
	expect(last().sent).toEqual([]);
	last().open();
	socket.send({ type: "input", data: "ls\r" });
	expect(last().sent).toEqual([JSON.stringify({ type: "input", data: "ls\r" })]);
	socket.stop();
	expect(last().closed).toBe(true);
	last().drop(1000);
	expect(handlers.onLost).not.toHaveBeenCalled();
});
