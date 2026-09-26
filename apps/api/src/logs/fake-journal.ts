import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { JournalChild } from "./journal.js";

// Test helpers: a scripted journalctl child process and its output lines.

const Z = "0".repeat(32);
/** A valid journald cursor for entry `i`. */
export const cursorAt = (i: number) => `s=${Z};i=${i.toString(16)};b=${Z};m=0;t=0;x=0`;

/** One journalctl `--output=json` line. */
export function journalLine(
	i: number,
	message: unknown,
	unit = "portikus-api.service",
	at = Date.UTC(2026, 8, 26, 12, 0, i),
): string {
	return JSON.stringify({
		__CURSOR: cursorAt(i),
		__REALTIME_TIMESTAMP: String(at * 1000),
		_SYSTEMD_UNIT: unit,
		MESSAGE: message,
	});
}

/** A child process whose output the test writes; it closes when killed. */
export class FakeChild extends EventEmitter implements JournalChild {
	stdout = new PassThrough();
	stderr = new PassThrough();
	killed: string | null = null;
	kill(signal?: NodeJS.Signals): boolean {
		this.killed = signal ?? "SIGTERM";
		setImmediate(() => this.emit("close", null));
		return true;
	}
	/** Write the lines and exit with `code`. */
	finish(lines: string[], code = 0, stderr = ""): void {
		if (stderr) this.stderr.write(stderr);
		this.stdout.write(lines.map((line) => `${line}\n`).join(""));
		setImmediate(() => {
			this.stdout.end();
			this.stderr.end();
			if (!this.killed) this.emit("close", code);
		});
	}
}

export function fakeSpawn() {
	const calls: { path: string; args: readonly string[]; child: FakeChild }[] = [];
	const spawn = (path: string, args: readonly string[]) => {
		const child = new FakeChild();
		calls.push({ path, args, child });
		return child;
	};
	return { spawn, calls };
}
