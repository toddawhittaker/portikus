/**
 * The tmux server options a terminal session is created with (SPEC.md §9.7),
 * checked against a real tmux server on its own socket so the test cannot
 * disturb, or be disturbed by, a tmux the developer already has running.
 */
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import {
	closeSession,
	createSession,
	hasSession,
	listSessions,
	SHELL_WRAPPER,
	sessionName,
} from "./tmux.js";

const run = promisify(execFile);
const SOCKET_NAME = `portikus-options-${process.pid}`;
const SERVER = { socketName: SOCKET_NAME, external: false };
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
	await createSession(ID, homeDir, homeDir, "dark", "Europe/Berlin", SERVER);
});

afterAll(async () => {
	if (!haveTmux) return;
	await run("tmux", ["-L", SOCKET_NAME, "kill-server"]).catch(() => undefined);
});

/** One variable in a session's environment, as tmux reports it. */
async function sessionEnvironment(session: string, name: string): Promise<string> {
	const { stdout } = await run("tmux", [
		"-L",
		SOCKET_NAME,
		"show-environment",
		"-t",
		session,
		name,
	]);
	return stdout.trim();
}

/**
 * Issue #267: a program that picks its own theme by auto-detection, Claude
 * Code among them, reads COLORFGBG. A dark terminal is light text on dark,
 * a light one the other way round.
 */
test.skipIf(!haveTmux)("a dark terminal says so through COLORFGBG", async () => {
	expect(await sessionEnvironment(`pk-${ID}`, "COLORFGBG")).toBe("COLORFGBG=15;0");
});

test.skipIf(!haveTmux)("a light terminal says so through COLORFGBG", async () => {
	const lightId = "00000000-0000-4000-8000-000000009002";
	await createSession(lightId, homeDir, homeDir, "light", "America/New_York", SERVER);
	expect(await sessionEnvironment(`pk-${lightId}`, "COLORFGBG")).toBe("COLORFGBG=0;15");
});

/**
 * Issue #287: a terminal opened after the student changed the setting runs in
 * the new zone at once, without waiting for a workspace restart.
 */
test.skipIf(!haveTmux)("the terminal carries the owner's zone as TZ", async () => {
	expect(await sessionEnvironment(`pk-${ID}`, "TZ")).toBe("TZ=Europe/Berlin");
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
		const overrides = await serverOption("terminal-overrides");
		expect(overrides).toContain("smcup@");
		// Erase-scrollback for the attached terminal (SPEC.md §9.1).
		expect(overrides).toContain("E3=\\E[3J");
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

/** A tmux server of its own for one test, killed afterwards. */
function scratchServer(tag: string) {
	return { socketName: `portikus-${tag}-${process.pid}`, external: false };
}

async function killServer(socketName: string): Promise<void> {
	await run("tmux", ["-L", socketName, "kill-server"]).catch(() => undefined);
}

test("a tmux that never answers fails with TMUX_FAILED after five seconds", async () => {
	const bin = await mkdtemp(join(tmpdir(), "portikus-hung-tmux-"));
	const pidFile = join(bin, "pid");
	await writeFile(
		join(bin, "tmux"),
		`#!/bin/sh\necho $$ > ${pidFile}\nexec sleep 60\n`,
	);
	await chmod(join(bin, "tmux"), 0o755);
	const path = process.env.PATH;
	process.env.PATH = `${bin}:${path}`;
	const started = Date.now();
	try {
		await expect(callThatReportsErrors()).rejects.toMatchObject({
			code: "TMUX_FAILED",
			message: "tmux did not answer in time",
		});
	} finally {
		process.env.PATH = path;
	}
	const took = Date.now() - started;
	expect(took).toBeGreaterThanOrEqual(4900);
	expect(took).toBeLessThan(8000);
	// The hung process was killed, not left behind.
	const pid = Number((await readFile(pidFile, "utf8")).trim());
	expect(() => process.kill(pid, 0)).toThrow();
}, 15_000);

/** hasSession and listSessions swallow errors; closeSession reports them. */
function callThatReportsErrors() {
	return closeSession("00000000-0000-4000-8000-000000009999", SERVER);
}

test.skipIf(!haveTmux)(
	"in external mode a missing server is an error and no server is started",
	async () => {
		const server = { socketName: `portikus-external-${process.pid}`, external: true };
		const home = await mkdtemp(join(tmpdir(), "portikus-external-"));
		await expect(
			createSession(
				"00000000-0000-4000-8000-000000009101",
				home,
				home,
				"dark",
				"UTC",
				server,
			),
		).rejects.toMatchObject({
			code: "TMUX_FAILED",
			message:
				"The terminal service is not running; it restarts on its own within seconds.",
		});
		expect(await listSessions(server)).toEqual([]);
		// Nothing is listening on that socket: the agent started no server.
		await expect(
			run("tmux", ["-L", server.socketName, "list-sessions"]),
		).rejects.toThrow();
	},
);

test.skipIf(!haveTmux)(
	"in external mode the agent uses a server someone else started",
	async () => {
		const server = { socketName: `portikus-ext-up-${process.pid}`, external: true };
		const home = await mkdtemp(join(tmpdir(), "portikus-ext-up-"));
		await run("tmux", [
			"-L",
			server.socketName,
			"-f",
			"/dev/null",
			"new-session",
			"-d",
			"-s",
			"keep",
		]);
		try {
			const id = "00000000-0000-4000-8000-000000009102";
			await createSession(id, home, home, "dark", "UTC", server);
			expect(await hasSession(id, server)).toBe(true);
		} finally {
			await killServer(server.socketName);
		}
	},
);

test.skipIf(!haveTmux)(
	"a student's ~/.tmux.conf is never read, so a broken one cannot stop a terminal",
	async () => {
		const server = scratchServer("conf");
		const home = await mkdtemp(join(tmpdir(), "portikus-conf-"));
		await writeFile(
			join(home, ".tmux.conf"),
			'set -g default-command exit\nset -g status-left "from-student-conf"\n',
		);
		const saved = { HOME: process.env.HOME, XDG: process.env.XDG_CONFIG_HOME };
		process.env.HOME = home;
		process.env.XDG_CONFIG_HOME = join(home, ".config");
		const id = "00000000-0000-4000-8000-000000009103";
		try {
			await createSession(id, home, home, "dark", "UTC", server);
			await new Promise((resolve) => setTimeout(resolve, 1500));
			expect(await hasSession(id, server)).toBe(true);
			const { stdout } = await run("tmux", [
				"-L",
				server.socketName,
				"show-options",
				"-g",
				"-v",
				"status-left",
			]);
			expect(stdout).not.toContain("from-student-conf");
		} finally {
			process.env.HOME = saved.HOME;
			if (saved.XDG === undefined) delete process.env.XDG_CONFIG_HOME;
			else process.env.XDG_CONFIG_HOME = saved.XDG;
			await killServer(server.socketName);
		}
	},
);

test.skipIf(!haveTmux)("an ordinary terminal starts in the shell wrapper", async () => {
	const { stdout } = await run("tmux", [
		"-L",
		SOCKET_NAME,
		"display-message",
		"-p",
		"-t",
		sessionName(ID),
		"#{pane_start_command}",
	]);
	expect(stdout.trim()).toBe(SHELL_WRAPPER);
});

/** Whether a pid is still running (and not a zombie waiting to be reaped). */
async function running(pid: number): Promise<boolean> {
	try {
		const stat = await readFile(`/proc/${pid}/stat`, "utf8");
		return stat.charAt(stat.lastIndexOf(")") + 2) !== "Z";
	} catch {
		return false;
	}
}

test.skipIf(!haveTmux)(
	"closing a terminal stops its setsid and nohup children, not just the shell (#624)",
	async () => {
		const server = scratchServer("tree");
		const home = await mkdtemp(join(tmpdir(), "portikus-tree-"));
		const pidFile = join(home, "children");
		const id = "00000000-0000-4000-8000-000000009104";
		try {
			await createSession(id, home, home, "dark", "UTC", server);
			await run("tmux", [
				"-L",
				server.socketName,
				"send-keys",
				"-t",
				sessionName(id),
				`setsid sleep 321 & a=$!; nohup sleep 322 >/dev/null 2>&1 & echo "$a $!" > ${pidFile}`,
				"Enter",
			]);
			const pids = await vi.waitFor(
				async () => {
					const text = (await readFile(pidFile, "utf8")).trim();
					expect(text).toMatch(/^\d+ \d+$/);
					return text.split(" ").map(Number);
				},
				{ timeout: 10_000 },
			);
			const { stopped } = await closeSession(id, server);
			expect(await hasSession(id, server)).toBe(false);
			await stopped;
			for (const pid of pids) expect(await running(pid)).toBe(false);
		} finally {
			await killServer(server.socketName);
		}
	},
	20_000,
);
