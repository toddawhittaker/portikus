import type { Workspace } from "@portikus/contracts";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { json, renderApp, stubFetch, USER, WORKSPACE } from "./test-utils.js";

/** A socket the test opens and pushes workspace frames through. */
class PushSocket {
	static readonly OPEN = 1;
	static last: PushSocket | null = null;
	readyState = 0;
	sent: string[] = [];
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: string }) => void) | null = null;
	onclose: ((event: { code: number }) => void) | null = null;
	constructor(public url: string) {
		PushSocket.last = this;
	}
	send(data: string) {
		this.sent.push(data);
	}
	close() {
		this.readyState = 3;
	}
}

const THROTTLE = {
	at: "2026-09-25T12:00:00.000Z",
	thresholdPercent: 80,
	windowMinutes: 30,
	sharePercent: 25,
};

beforeEach(() => {
	PushSocket.last = null;
	vi.stubGlobal("WebSocket", PushSocket);
	stubFetch((url) => {
		if (url === "/auth/me") return json(200, USER);
		// Nothing else matters here; an empty answer keeps each pane quiet.
		return json(404, { code: "NOT_FOUND", message: "Not here." });
	});
});

afterEach(() => vi.unstubAllGlobals());

async function openShell() {
	renderApp(`/workspaces/${WORKSPACE.id}`);
	await waitFor(() => expect(PushSocket.last).not.toBeNull());
	const socket = PushSocket.last as PushSocket;
	act(() => {
		socket.readyState = 1;
		socket.onopen?.();
	});
	return {
		socket,
		push(workspace: Partial<Workspace>) {
			act(() =>
				socket.onmessage?.({
					data: JSON.stringify({
						type: "workspace",
						workspace: { ...WORKSPACE, ...workspace },
					}),
				}),
			);
		},
	};
}

test("a throttle shows the notice; dismissing it lasts until a new throttle", async () => {
	const { push } = await openShell();
	push({ cpuThrottle: THROTTLE });
	expect((await screen.findByTestId("throttle-notice")).textContent).toContain(
		"more than 80% busy for 30 minutes",
	);

	fireEvent.click(
		screen.getByRole("button", { name: "Dismiss the slowed-down notice" }),
	);
	expect(screen.queryByTestId("throttle-notice")).toBeNull();
	expect(document.activeElement).toBe(screen.getByRole("main", { name: "Work area" }));
	// The screen-reader status empties too, so the dismissed message does not linger.
	expect(screen.getByTestId("throttle-announce").textContent).toBe("");

	push({ cpuThrottle: THROTTLE });
	expect(screen.queryByTestId("throttle-notice")).toBeNull();
	expect(screen.getByTestId("throttle-announce").textContent).toBe("");
	push({ cpuThrottle: { ...THROTTLE, at: "2026-09-25T14:00:00.000Z" } });
	expect(screen.getByTestId("throttle-notice")).toBeDefined();
	expect(screen.getByTestId("throttle-announce").textContent).not.toBe("");
});

test("Still working? sends activity, and an unanswered stop says why", async () => {
	const { socket, push } = await openShell();
	// Nearly at the deadline, so the stop that follows is the idle stop.
	const stopAt = new Date(Date.now() + 30_000).toISOString();
	const lastActivityAt = new Date(Date.now() + 30_000 - 65 * 60_000).toISOString();
	push({ idleStopAt: stopAt, lastActivityAt });

	const button = await screen.findByRole("button", { name: "Keep working" });
	socket.sent = [];
	fireEvent.click(button);
	expect(socket.sent).toContain(JSON.stringify({ type: "activity" }));

	push({
		idleStopAt: stopAt,
		lastActivityAt,
		state: "stopping",
		desiredState: "stopped",
	});
	push({ idleStopAt: null, state: "stopped", desiredState: "stopped" });
	expect((await screen.findByTestId("idle-stopped")).textContent).toBe(
		"Stopped after 60 minutes without activity.",
	);
	expect(screen.queryByTestId("idle-notice")).toBeNull();
});
