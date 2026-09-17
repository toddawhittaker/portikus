import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { pipeBackpressure } from "./terminals.js";

/**
 * Backpressure on the browser end of the terminal pipe (SPEC.md §9.7): a
 * browser that cannot keep up must stop the control plane from reading more
 * output from the agent.
 */

const limits = { high: 1000, low: 250, pollMs: 50 };

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

function harness() {
	const socket = { bufferedAmount: 0 };
	const calls: string[] = [];
	const upstream = {
		pause: () => calls.push("pause"),
		resume: () => calls.push("resume"),
	};
	return { socket, calls, ...pipeBackpressure(socket, upstream, limits) };
}

test("a backed-up browser socket pauses the agent socket until it drains", () => {
	const h = harness();

	h.socket.bufferedAmount = 500;
	h.apply();
	expect(h.calls).toEqual([]);

	h.socket.bufferedAmount = 1200;
	h.apply();
	expect(h.calls).toEqual(["pause"]);

	// Still above the low water mark: stay paused.
	h.socket.bufferedAmount = 400;
	vi.advanceTimersByTime(200);
	expect(h.calls).toEqual(["pause"]);

	h.socket.bufferedAmount = 100;
	vi.advanceTimersByTime(50);
	expect(h.calls).toEqual(["pause", "resume"]);

	// The poll stops once it has resumed.
	h.socket.bufferedAmount = 2000;
	vi.advanceTimersByTime(500);
	expect(h.calls).toEqual(["pause", "resume"]);
});

test("pausing happens once while the socket stays backed up", () => {
	const h = harness();
	h.socket.bufferedAmount = 2000;
	h.apply();
	h.apply();
	h.apply();
	expect(h.calls).toEqual(["pause"]);
});

test("cancel stops the drain poll when the socket closes", () => {
	const h = harness();
	h.socket.bufferedAmount = 2000;
	h.apply();
	h.cancel();

	h.socket.bufferedAmount = 0;
	vi.advanceTimersByTime(500);
	expect(h.calls).toEqual(["pause"]);
	expect(vi.getTimerCount()).toBe(0);
});
