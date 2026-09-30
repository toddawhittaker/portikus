/**
 * The pane watcher tells the browser when `clear` erased a pane's history,
 * because tmux does not pass the erase-scrollback on (issue #882, SPEC.md §9.7).
 */
import type { WebSocket } from "@fastify/websocket";
import { afterEach, expect, test, vi } from "vitest";
import { watchPanes } from "./cwd.js";
import type { PaneState } from "./tmux.js";

const listPanes = vi.hoisted(() => vi.fn());
vi.mock("./tmux.js", () => ({ listPanes }));

const ID = "00000000-0000-4000-8000-000000009301";
const SERVER = { socketName: "unused", external: false };

function fakeSocket(): { socket: WebSocket; sent: unknown[] } {
	const sent: unknown[] = [];
	const socket = {
		OPEN: 1,
		readyState: 1,
		send: (text: string) => sent.push(JSON.parse(text)),
	} as unknown as WebSocket;
	return { socket, sent };
}

function pane(history: number): Map<string, PaneState> {
	return new Map([[ID, { path: "/home/student", alternate: false, history }]]);
}

afterEach(() => {
	vi.useRealTimers();
	listPanes.mockReset();
});

/** The frames one socket gets while the pane's history takes these sizes. */
async function framesFor(histories: number[]): Promise<unknown[]> {
	vi.useFakeTimers();
	for (const history of histories) listPanes.mockResolvedValueOnce(pane(history));
	listPanes.mockResolvedValue(pane(histories.at(-1) ?? 0));
	const watcher = watchPanes(SERVER);
	const { socket, sent } = fakeSocket();
	watcher.add(ID, socket);
	for (let i = 0; i < histories.length; i += 1) await vi.advanceTimersByTimeAsync(600);
	watcher.stop();
	return sent;
}

test("history emptied by clear sends one clear frame", async () => {
	const sent = await framesFor([40, 0, 0]);
	expect(
		sent.filter((frame) => (frame as { type: string }).type === "clear"),
	).toHaveLength(1);
});

test("history that starts empty or only shrinks sends no clear frame", async () => {
	const sent = await framesFor([0, 40, 30]);
	expect(sent).not.toContainEqual({ type: "clear" });
});
