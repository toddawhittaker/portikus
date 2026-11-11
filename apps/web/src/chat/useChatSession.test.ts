import type { ChatClientMessage } from "@portikus/contracts";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ChatSocketEvents } from "./chatSocket.js";
import { useChatSession } from "./useChatSession.js";

/**
 * A new chat starts at the settings last used in its project, and a change
 * the host confirms is kept for the next one (SPEC.md §10.8).
 */

let events: ChatSocketEvents;
let sent: ChatClientMessage[];

vi.mock("./chatSocket.js", () => ({
	chatSocketPath: (w: string, t: string) => `/workspaces/${w}/terminals/${t}/chat`,
	openChatSocket: (_path: string, handlers: ChatSocketEvents) => {
		events = handlers;
		return {
			send: (message: ChatClientMessage) => {
				sent.push(message);
				return true;
			},
			stop: () => {},
		};
	},
}));

const SESSION = "11111111-1111-4111-8111-111111111111";
const SETTINGS_URL = "/workspaces/w1/projects/p1/chat-settings";
let seq: number;
let stored: unknown;
let puts: unknown[];

function frame(type: string, body: Record<string, unknown> = {}) {
	act(() =>
		events.onFrame(JSON.stringify({ type, sessionId: SESSION, seq: seq++, ...body })),
	);
}

function settings(model: string, effort: string, mode: string) {
	frame("settings", { agent: "claude", model, effort, mode });
}

beforeEach(() => {
	seq = 0;
	sent = [];
	puts = [];
	stored = undefined;
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string, init?: RequestInit) => {
			expect(input).toBe(SETTINGS_URL);
			if (init?.method === "PUT") {
				puts.push(JSON.parse(String(init.body)));
				return new Response(null, { status: 204 });
			}
			return stored === undefined
				? new Response(null, { status: 204 })
				: Response.json(stored);
		}),
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

async function open() {
	const view = renderHook(() => useChatSession("w1", "p1", "t1"));
	act(() => events.onOpen());
	await waitFor(() => expect(fetch).toHaveBeenCalled());
	return view.result.current;
}

test("a new chat is brought to the stored values once, and that echo is not saved", async () => {
	stored = { model: "sonnet", effort: "low", mode: "plan" };
	const store = await open();
	frame("snapshot", { cards: [], turnRunning: false, truncated: false });
	settings("opus", "medium", "auto");
	await waitFor(() =>
		expect(sent).toEqual([
			{ type: "set", model: "sonnet", effort: "low", mode: "plan" },
		]),
	);
	settings("sonnet", "low", "plan");
	expect(store.getState().settings?.model).toBe("sonnet");
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(puts).toEqual([]);
});

test("a chat already in use is left alone", async () => {
	stored = { model: "opus", effort: "low", mode: "auto" };
	await open();
	frame("snapshot", { cards: [], turnRunning: false, truncated: false });
	settings("sonnet", "high", "bypassPermissions");
	await new Promise((resolve) => setTimeout(resolve, 0));
	expect(sent).toEqual([]);
});

test("a change the host confirms is saved as the project's last used", async () => {
	const store = await open();
	frame("snapshot", { cards: [], turnRunning: false, truncated: false });
	settings("opus", "medium", "auto");
	// A settings event nobody asked for is not saved.
	settings("opus", "medium", "acceptEdits");
	act(() => {
		store.getState().set({ mode: "bypassPermissions" });
	});
	expect(puts).toEqual([]);
	settings("claude-opus-4-8", "high", "bypassPermissions");
	await waitFor(() =>
		expect(puts).toEqual([
			{ model: "claude-opus-4-8", effort: "high", mode: "bypassPermissions" },
		]),
	);
});
