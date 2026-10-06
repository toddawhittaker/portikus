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
	last().onmessage?.({ data: new ArrayBuffer(1) });
	last().drop(1006);
	vi.runAllTimers();
	expect(FakeSocket.all).toHaveLength(1);
	expect(handlers.onLost).toHaveBeenCalledWith("closed");
});

/** Answer the session check an early close makes. */
function meAnswers(status: number, role = "administrator") {
	const fetch = vi.fn(async () => Response.json({ ...ME, role }, { status }));
	vi.stubGlobal("fetch", fetch);
	return fetch;
}

const ME = {
	id: "33333333-3333-4333-8333-333333333333",
	displayName: "Carol Admin",
	email: "carol@example.invalid",
};

test("a plain close before any output, with the session still an administrator's, is a refusal", async () => {
	const fetch = meAnswers(200);
	const handlers = events();
	openRootShellSocket({ cols: 80, rows: 24 }, handlers);
	last().open();
	last().drop(1000);
	expect(handlers.onLost).not.toHaveBeenCalled();
	await vi.waitFor(() => expect(handlers.onLost).toHaveBeenCalledWith("refused"));
	expect(fetch).toHaveBeenCalledWith("/auth/me", { credentials: "same-origin" });
	expect(handlers.onExit).not.toHaveBeenCalled();
});

test("an upgrade refused for a signed-out session goes to the session-ended page", async () => {
	meAnswers(401);
	const handlers = events();
	openRootShellSocket({ cols: 80, rows: 24 }, handlers);
	last().drop(1006);
	await vi.waitFor(() => expect(sessionEnded).toHaveBeenCalledTimes(1));
	expect(handlers.onLost).not.toHaveBeenCalled();
});

test("an upgrade refused for a demoted account says the account is not allowed", async () => {
	meAnswers(200, "student");
	const handlers = events();
	openRootShellSocket({ cols: 80, rows: 24 }, handlers);
	last().drop(1006);
	await vi.waitFor(() => expect(handlers.onLost).toHaveBeenCalledWith("forbidden"));
});

test("a failed session check still reports a refusal", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => {
			throw new TypeError("offline");
		}),
	);
	const handlers = events();
	openRootShellSocket({ cols: 80, rows: 24 }, handlers);
	last().drop(1006);
	await vi.waitFor(() => expect(handlers.onLost).toHaveBeenCalledWith("refused"));
});

test("a revoked session hands over to the session-ended page", async () => {
	meAnswers(401);
	const handlers = events();
	openRootShellSocket({ cols: 80, rows: 24 }, handlers);
	last().open();
	last().onmessage?.({ data: new ArrayBuffer(1) });
	last().drop(CloseCode.SESSION_ENDED);
	await vi.waitFor(() => expect(sessionEnded).toHaveBeenCalledTimes(1));
	expect(handlers.onLost).not.toHaveBeenCalled();
});

test("a demotion ends the shell as forbidden, not as a lost session", async () => {
	meAnswers(200, "student");
	const handlers = events();
	openRootShellSocket({ cols: 80, rows: 24 }, handlers);
	last().open();
	last().onmessage?.({ data: new ArrayBuffer(1) });
	last().drop(CloseCode.SESSION_ENDED);
	await vi.waitFor(() => expect(handlers.onLost).toHaveBeenCalledWith("forbidden"));
	expect(sessionEnded).not.toHaveBeenCalled();
});

test("a session-ended close the session check cannot confirm says the check failed", async () => {
	meAnswers(503);
	const handlers = events();
	openRootShellSocket({ cols: 80, rows: 24 }, handlers);
	last().open();
	last().onmessage?.({ data: new ArrayBuffer(1) });
	last().drop(CloseCode.SESSION_ENDED);
	await vi.waitFor(() => expect(handlers.onLost).toHaveBeenCalledWith("unchecked"));
	expect(sessionEnded).not.toHaveBeenCalled();
});

test("a server error after the shell started is a lost database: the shell was hung up", () => {
	const handlers = events();
	openRootShellSocket({ cols: 80, rows: 24 }, handlers);
	last().open();
	last().onmessage?.({ data: new ArrayBuffer(1) });
	last().drop(CloseCode.SERVER_ERROR);
	expect(handlers.onLost).toHaveBeenCalledWith("database_lost");
	expect(sessionEnded).not.toHaveBeenCalled();
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
