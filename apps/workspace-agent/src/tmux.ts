import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import { type AgentErrorCode, TerminalId } from "@portikus/contracts";

const run = promisify(execFile);

/** An agent failure carrying the wire error code of SPEC.md §27. */
export class AgentFailure extends Error {
	readonly code: AgentErrorCode;

	constructor(code: AgentErrorCode, message: string) {
		super(message);
		this.name = "AgentFailure";
		this.code = code;
	}
}

/**
 * Tests run against their own tmux server so they cannot disturb, or be
 * disturbed by, the one a real user already has running.
 */
function socketArgs(socketName?: string): string[] {
	return socketName ? ["-L", socketName] : [];
}

/** The tmux session name for a terminal (SPEC.md §9.7). */
export function sessionName(id: string): string {
	if (!TerminalId.safeParse(id).success) {
		throw new AgentFailure("TERMINAL_NOT_FOUND", "invalid terminal id");
	}
	return `pk-${id}`;
}

/** The command line every attachment uses, so both sides agree on the socket. */
export function attachArgs(id: string, socketName?: string): string[] {
	return [...socketArgs(socketName), "attach-session", "-t", sessionName(id)];
}

/** How much output one tmux command may produce; a capture can be large. */
const TMUX_MAX_OUTPUT_BYTES = 4 * 1024 * 1024;

async function tmux(args: string[], socketName?: string): Promise<string> {
	try {
		const { stdout } = await run("tmux", [...socketArgs(socketName), ...args], {
			maxBuffer: TMUX_MAX_OUTPUT_BYTES,
		});
		return stdout;
	} catch (error) {
		const stderr =
			typeof (error as { stderr?: unknown }).stderr === "string"
				? (error as { stderr: string }).stderr.trim()
				: "";
		throw new AgentFailure("TMUX_FAILED", stderr || String(error));
	}
}

/**
 * Resolve the working directory of a new terminal and refuse anything that
 * leaves the workspace home, symlinks included (SPEC.md §24.6).
 */
async function resolveCwd(cwd: string, homeDir: string): Promise<string> {
	if (!isAbsolute(cwd)) {
		throw new AgentFailure("INVALID_CWD", "cwd must be an absolute path");
	}
	let real: string;
	let home: string;
	try {
		real = await realpath(cwd);
		home = await realpath(homeDir);
	} catch {
		throw new AgentFailure("INVALID_CWD", "cwd does not exist");
	}
	if (real !== home && !real.startsWith(`${home}/`)) {
		throw new AgentFailure("INVALID_CWD", "cwd is outside the workspace home");
	}
	const info = await stat(real);
	if (!info.isDirectory()) {
		throw new AgentFailure("INVALID_CWD", "cwd is not a directory");
	}
	return real;
}

/**
 * Take three capabilities away from the terminal tmux thinks it is drawing on,
 * so that the browser's own scrollback fills up (SPEC.md §9.1).
 *
 * `smcup`/`rmcup` switch to the alternate screen, which in xterm.js has no
 * scrollback at all and turns the wheel into arrow keys. `indn`/`rin` scroll
 * by N lines in place, which xterm.js does not save. Without them tmux uses
 * plain line feeds at the bottom of the screen, and those do get saved.
 *
 * This is a tmux server option, so it covers every session on the server.
 */
export async function useBrowserScrollback(socketName?: string): Promise<void> {
	await tmux(
		["set-option", "-s", "terminal-overrides", "*:smcup@:rmcup@:indn@:rin@"],
		socketName,
	);
}

/** How many lines of a pane's history an attachment gets back. */
const HISTORY_LINES = 2000;

/**
 * The lines that have scrolled off the top of a terminal's visible screen, as
 * a terminal would print them: escape sequences kept, wrapped lines joined,
 * and CRLF endings. Empty when the terminal has no history yet.
 *
 * A re-attaching tmux repaints only the visible screen, so without this a
 * reload leaves the student with nothing above the prompt.
 */
export async function captureHistory(id: string, socketName?: string): Promise<string> {
	const name = sessionName(id);
	const size = Number.parseInt(
		(
			await tmux(["display-message", "-p", "-t", name, "#{history_size}"], socketName)
		).trim(),
		10,
	);
	if (!Number.isFinite(size) || size <= 0) return "";
	const text = await tmux(
		[
			"capture-pane",
			"-p",
			"-e",
			"-J",
			"-S",
			`-${Math.min(size, HISTORY_LINES)}`,
			"-E",
			"-1",
			"-t",
			name,
		],
		socketName,
	);
	if (text === "") return "";
	return `${text.replace(/\n$/, "").replace(/\n/g, "\r\n")}\r\n`;
}

export interface TmuxSession {
	id: string;
	cwd: string;
}

/** Every `pk-*` session on this tmux server (SPEC.md §9.7). */
export async function listSessions(socketName?: string): Promise<TmuxSession[]> {
	let stdout: string;
	try {
		stdout = await tmux(
			["list-sessions", "-F", "#{session_name}\t#{session_path}"],
			socketName,
		);
	} catch {
		// No server running yet means no sessions, which is not an error.
		return [];
	}
	const sessions: TmuxSession[] = [];
	for (const line of stdout.split("\n")) {
		const [name, cwd] = line.split("\t");
		if (!name?.startsWith("pk-")) continue;
		sessions.push({ id: name.slice(3), cwd: cwd ?? "" });
	}
	return sessions;
}

export async function hasSession(id: string, socketName?: string): Promise<boolean> {
	try {
		await tmux(["has-session", "-t", sessionName(id)], socketName);
		return true;
	} catch {
		return false;
	}
}

/** Create the tmux session that backs one terminal (SPEC.md §9.7). */
export async function createSession(
	id: string,
	cwd: string,
	homeDir: string,
	socketName?: string,
): Promise<TmuxSession> {
	const name = sessionName(id);
	const real = await resolveCwd(cwd, homeDir);
	await tmux(["new-session", "-d", "-s", name, "-c", real], socketName);
	await useBrowserScrollback(socketName);
	// `latest` sizes the session to the most recent client, so a second
	// attachment does not shrink the terminal to the smallest window.
	await tmux(["set-option", "-t", name, "window-size", "latest"], socketName);
	await tmux(["set-option", "-t", name, "status", "off"], socketName);
	await tmux(["set-option", "-t", name, "history-limit", "5000"], socketName);
	return { id, cwd: real };
}

/** The current directory of a terminal's tmux pane (SPEC.md §9.3). */
export async function panePath(
	id: string,
	socketName?: string,
): Promise<string | null> {
	const stdout = await tmux(
		["display-message", "-p", "-t", sessionName(id), "#{pane_current_path}"],
		socketName,
	);
	const path = stdout.trim();
	return path === "" ? null : path;
}

export async function killSession(id: string, socketName?: string): Promise<void> {
	await tmux(["kill-session", "-t", sessionName(id)], socketName);
}
