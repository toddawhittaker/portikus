import type { ChatClientMessage } from "@portikus/contracts";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ChatSocketEvents } from "../chat/chatSocket.js";
import { RENAME_QUIET_MS, renameChat } from "./renameChat.js";

/** A rename from the left pane goes on the chat's own socket, once (ADR 0074). */

let events: ChatSocketEvents;
let sent: ChatClientMessage[];
let stopped: number;
let opened: string[];

vi.mock("../chat/chatSocket.js", () => ({
	chatSocketPath: (w: string, t: string) => `/workspaces/${w}/terminals/${t}/chat`,
	openChatSocket: (path: string, handlers: ChatSocketEvents) => {
		opened.push(path);
		events = handlers;
		return {
			send: (message: ChatClientMessage) => {
				sent.push(message);
				return true;
			},
			stop: () => {
				stopped += 1;
			},
		};
	},
}));

beforeEach(() => {
	vi.useFakeTimers();
	sent = [];
	stopped = 0;
	opened = [];
});

afterEach(() => {
	vi.useRealTimers();
});

test("the title goes once the socket opens, and a reconnect does not send it again", async () => {
	const rename = renameChat("w1", "t1", "New name");
	expect(opened).toEqual(["/workspaces/w1/terminals/t1/chat"]);
	expect(sent).toEqual([]);
	events.onOpen();
	events.onOpen();
	expect(sent).toEqual([{ type: "rename", title: "New name" }]);
	rename.finish();
	await expect(rename.done).resolves.toBeUndefined();
	expect(stopped).toBeGreaterThan(0);
});

test("the host's refusal rejects the rename with its words", async () => {
	const rename = renameChat("w1", "t1", "New name");
	events.onFrame(JSON.stringify({ type: "snapshot" }));
	events.onOpen();
	events.onFrame("not json");
	events.onFrame(
		JSON.stringify({ type: "rename.result", ok: false, message: "Nope." }),
	);
	await expect(rename.done).rejects.toThrow("Nope.");
});

test("a broadcast error, such as a session ending, is not the rename's answer", async () => {
	const rename = renameChat("w1", "t1", "New name");
	events.onOpen();
	events.onFrame(
		JSON.stringify({ type: "error", seq: 3, message: "The session ended." }),
	);
	vi.advanceTimersByTime(RENAME_QUIET_MS);
	await expect(rename.done).resolves.toBeUndefined();
});

test("a rename the host confirms waits for the title, then the wait ends quietly", async () => {
	const rename = renameChat("w1", "t1", "New name");
	events.onOpen();
	events.onFrame(JSON.stringify({ type: "rename.result", ok: true }));
	let settled = false;
	void rename.done.then(() => {
		settled = true;
	});
	await Promise.resolve();
	expect(settled).toBe(false);
	vi.advanceTimersByTime(RENAME_QUIET_MS);
	await expect(rename.done).resolves.toBeUndefined();
});

test("an answer before the rename went is not its answer", async () => {
	const rename = renameChat("w1", "t1", "New name");
	events.onFrame(JSON.stringify({ type: "rename.result", ok: false, message: "Old." }));
	events.onOpen();
	vi.advanceTimersByTime(RENAME_QUIET_MS);
	await expect(rename.done).resolves.toBeUndefined();
});

test.each([
	["onLost", /could not be reached/],
	["onNotFound", /has ended/],
	["onTooMany", /Too many/],
] as const)("%s rejects the rename", async (handler, message) => {
	const rename = renameChat("w1", "t1", "New name");
	events[handler]();
	await expect(rename.done).rejects.toThrow(message);
});
