import { act, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createAgentStatusStore } from "./terminal/codingAgentStatus.js";
import { WORKSPACE } from "./test-utils.js";
import { ACTIVITY_MS, useWorkspaceSocket } from "./useWorkspaceSocket.js";

class RecordingSocket {
	static readonly OPEN = 1;
	static last: RecordingSocket | null = null;
	readyState = 0;
	sent: string[] = [];
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	onclose: ((event: { code: number }) => void) | null = null;
	constructor(public url: string) {
		RecordingSocket.last = this;
	}
	send(data: string) {
		this.sent.push(data);
	}
	close() {
		this.readyState = 3;
	}
	open() {
		this.readyState = 1;
		this.onopen?.();
	}
	activity() {
		return this.sent.filter((data) => data === JSON.stringify({ type: "activity" }))
			.length;
	}
}

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
	vi.stubGlobal("WebSocket", RecordingSocket);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

function openSocket() {
	const hook = renderHook(() => useWorkspaceSocket(WORKSPACE.id));
	const socket = RecordingSocket.last as RecordingSocket;
	act(() => socket.open());
	return { hook, socket };
}

test("a key press, click or paste reports activity at most once a minute", () => {
	const { socket } = openSocket();

	fireEvent.keyDown(document.body, { key: "a" });
	fireEvent.pointerDown(document.body);
	fireEvent.paste(document.body);
	expect(socket.activity()).toBe(1);

	vi.advanceTimersByTime(ACTIVITY_MS);
	fireEvent.pointerDown(document.body);
	expect(socket.activity()).toBe(2);
});

test("sendActivity reports at once, whatever the last report was", () => {
	const { hook, socket } = openSocket();
	fireEvent.keyDown(document.body, { key: "a" });
	act(() => hook.result.current.sendActivity());
	expect(socket.activity()).toBe(2);
});

test("nothing is sent before the socket opens, so the next press tries again", () => {
	renderHook(() => useWorkspaceSocket(WORKSPACE.id));
	const socket = RecordingSocket.last as RecordingSocket;
	fireEvent.keyDown(document.body, { key: "a" });
	expect(socket.sent).toEqual([]);
	act(() => socket.open());
	fireEvent.keyDown(document.body, { key: "b" });
	expect(socket.activity()).toBe(1);
});

test("the page stops listening when it leaves the workspace", () => {
	const { hook, socket } = openSocket();
	hook.unmount();
	socket.readyState = 1;
	fireEvent.keyDown(document.body, { key: "a" });
	expect(socket.activity()).toBe(0);
});

const P = "11111111-1111-4111-8111-111111111111";
const SINCE = "2026-11-01T12:00:00.000Z";
const T = "22222222-2222-4222-8222-222222222222";

function agents(state: "working" | "finished") {
	return JSON.stringify({
		type: "coding-agents",
		terminals: [{ terminalId: T, projectId: P, agent: "claude", state, since: SINCE }],
	});
}

test("every coding-agents list reaches the store once, even two in one tick", () => {
	// Not focused, so a finish counts as news.
	const store = createAgentStatusStore(() => false);
	const alerts: unknown[] = [];
	renderHook(() =>
		useWorkspaceSocket(WORKSPACE.id, (terminals, initial) => {
			alerts.push(...store.update(terminals, initial));
		}),
	);
	const socket = RecordingSocket.last as RecordingSocket;
	act(() => socket.open());
	// The first list is a baseline; the quick finish and restart after it are not.
	act(() => {
		socket.onmessage?.({ data: agents("working") });
		expect(alerts).toEqual([]);
		socket.onmessage?.({ data: agents("finished") });
		socket.onmessage?.({ data: agents("working") });
	});
	expect(alerts).toEqual([
		expect.objectContaining({ terminalId: T, state: "finished" }),
	]);
	// The agent is working again, so nothing is unread.
	expect(store.getSnapshot().unread.has(T)).toBe(false);
});
