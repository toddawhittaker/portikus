/**
 * The pane watcher tells the browser when `clear` erased a pane's history,
 * because tmux does not pass the erase-scrollback on (SPEC.md §9.7).
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

/** A second terminal whose history never changes. */
const OTHER = "00000000-0000-4000-8000-000000009302";

function pane(history: number): Map<string, PaneState> {
	return new Map([
		[ID, { path: "/home/student", alternate: false, history }],
		[OTHER, { path: "/home/student", alternate: false, history: 40 }],
	]);
}

afterEach(() => {
	vi.useRealTimers();
	listPanes.mockReset();
});

/**
 * The frames each terminal's socket gets while the first pane's history
 * takes these sizes.
 */
async function framesFor(
	histories: number[],
): Promise<{ sent: unknown[]; otherSent: unknown[] }> {
	vi.useFakeTimers();
	for (const history of histories) listPanes.mockResolvedValueOnce(pane(history));
	listPanes.mockResolvedValue(pane(histories.at(-1) ?? 0));
	const watcher = watchPanes(SERVER);
	const { socket, sent } = fakeSocket();
	const other = fakeSocket();
	watcher.add(ID, socket);
	watcher.add(OTHER, other.socket);
	for (let i = 0; i < histories.length; i += 1) await vi.advanceTimersByTimeAsync(600);
	watcher.stop();
	return { sent, otherSent: other.sent };
}

test("history emptied by clear sends one clear frame, to that terminal only", async () => {
	const { sent, otherSent } = await framesFor([40, 0, 0]);
	expect(
		sent.filter((frame) => (frame as { type: string }).type === "clear"),
	).toHaveLength(1);
	expect(otherSent).not.toContainEqual({ type: "clear" });
});

test("history that starts empty or only shrinks sends no clear frame", async () => {
	const { sent } = await framesFor([0, 40, 30]);
	expect(sent).not.toContainEqual({ type: "clear" });
});

function clears(sent: unknown[]): number {
	return sent.filter((frame) => (frame as { type: string }).type === "clear").length;
}

test("a clear from the pane pipe is sent at once and the poll does not repeat it", async () => {
	vi.useFakeTimers();
	listPanes.mockResolvedValueOnce(pane(40));
	listPanes.mockResolvedValue(pane(0));
	const watcher = watchPanes(SERVER);
	const { socket, sent } = fakeSocket();
	const other = fakeSocket();
	watcher.add(ID, socket);
	watcher.add(OTHER, other.socket);
	await vi.advanceTimersByTimeAsync(300);

	watcher.clear(ID);
	expect(clears(sent)).toBe(1);
	await vi.advanceTimersByTimeAsync(1200);
	watcher.stop();
	expect(clears(sent)).toBe(1);
	expect(clears(other.sent)).toBe(0);
});
