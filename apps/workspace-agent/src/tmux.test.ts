/**
 * The tmux server options a terminal session is created with (SPEC.md §9.7),
 * checked against a real tmux server on its own socket so the test cannot
 * disturb, or be disturbed by, a tmux the developer already has running.
 */
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test } from "vitest";
import { createSession } from "./tmux.js";

const run = promisify(execFile);
const SOCKET_NAME = `portikus-options-${process.pid}`;
const ID = "00000000-0000-4000-8000-000000009001";

async function tmuxAvailable(): Promise<boolean> {
	try {
		await run("tmux", ["-V"]);
		return true;
	} catch {
		return false;
	}
}

const haveTmux = await tmuxAvailable();

/** One server option's value, as tmux reports it. */
async function serverOption(name: string): Promise<string> {
	const { stdout } = await run("tmux", [
		"-L",
		SOCKET_NAME,
		"show-options",
		"-s",
		"-v",
		name,
	]);
	return stdout.trim();
}

let homeDir: string;

beforeAll(async () => {
	if (!haveTmux) return;
	homeDir = await mkdtemp(join(tmpdir(), "portikus-options-"));
	await createSession(ID, homeDir, homeDir, SOCKET_NAME);
});

afterAll(async () => {
	if (!haveTmux) return;
	await run("tmux", ["-L", SOCKET_NAME, "kill-server"]).catch(() => undefined);
});

test.skipIf(!haveTmux)(
	"focus events are on, so programs are told about focus",
	async () => {
		expect(await serverOption("focus-events")).toBe("on");
	},
);

test.skipIf(!haveTmux)(
	"the clipboard is on, so an OSC 52 copy reaches the browser",
	async () => {
		expect(await serverOption("set-clipboard")).toBe("on");
	},
);

test.skipIf(!haveTmux)(
	"the scrollback and terminal overrides are still set",
	async () => {
		expect(await serverOption("terminal-overrides")).toContain("smcup@");
		const { stdout } = await run("tmux", [
			"-L",
			SOCKET_NAME,
			"show-options",
			"-g",
			"-v",
			"history-limit",
		]);
		expect(stdout.trim()).toBe("5000");
	},
);
