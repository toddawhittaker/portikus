import { EventEmitter } from "node:events";
import { expect, test, vi } from "vitest";
import { closeOnSigterm, SHUTDOWN_GRACE_MS } from "./shutdown.js";

function fakeProcess() {
	const emitter = new EventEmitter();
	const exits: number[] = [];
	return {
		once: (signal: "SIGTERM", listener: () => void) => emitter.once(signal, listener),
		exit: (code: number) => void exits.push(code),
		emit: () => emitter.emit("SIGTERM"),
		exits,
	};
}

test("SIGTERM closes the app, so its onClose hooks run, then exits 0", async () => {
	const proc = fakeProcess();
	const order: string[] = [];
	const app = { close: vi.fn(async () => void order.push("closed")) };
	closeOnSigterm(app, proc);
	expect(app.close).not.toHaveBeenCalled();
	proc.emit();
	await vi.waitFor(() => expect(proc.exits).toEqual([0]));
	expect(order).toEqual(["closed"]);
});

test("a close that hangs still exits after the grace period", async () => {
	vi.useFakeTimers();
	try {
		const proc = fakeProcess();
		closeOnSigterm({ close: () => new Promise(() => {}) }, proc);
		proc.emit();
		vi.advanceTimersByTime(SHUTDOWN_GRACE_MS);
		expect(proc.exits).toEqual([0]);
	} finally {
		vi.useRealTimers();
	}
});
