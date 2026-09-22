import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";
import {
	type AgentErrorCode,
	type CodingAgent,
	TerminalId,
	type TerminalTheme,
} from "@portikus/contracts";

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

/**
 * How much output one tmux command may produce. A history capture is the only
 * large one, and it is cut to a much smaller budget straight afterwards; this
 * is the ceiling that keeps a pathological pane from being read into memory in
 * the first place.
 */
const TMUX_MAX_OUTPUT_BYTES = 1024 * 1024;

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
 * How many lines of history a pane keeps, and so the most an attachment can
 * be sent back. The browser keeps the same number (`SCROLLBACK_LINES` in
 * `TerminalPane.tsx`); what a replay is really bounded by is `HISTORY_BYTES`.
 */
export const HISTORY_LINES = 5000;

/**
 * Settings that belong to the tmux server rather than one session. They are
 * passed on the same command line as `new-session`, in front of it: tmux
 * starts the server for the whole list, so the options are in place before
 * the session's window exists.
 *
 * The terminal overrides take three capabilities away from the terminal tmux
 * thinks it is drawing on, so that the browser's own scrollback fills up
 * (SPEC.md §9.7). `smcup`/`rmcup` switch to the alternate screen, which in
 * xterm.js has no scrollback at all and turns the wheel into arrow keys.
 * `indn`/`rin` scroll by N lines in place, which xterm.js does not save.
 * Without them tmux uses plain line feeds at the bottom of the screen, and
 * those do get saved. `E3=\E[3J` tells tmux the attached terminal can erase
 * its scrollback, which is what `clear` asks for. The browser drops the saved
 * lines when that sequence arrives (SPEC.md §9.1).
 *
 * `history-limit` has to be global and set first: tmux reads it when a window
 * is created, so setting it on a session afterwards leaves that session's
 * pane on tmux's default of 2000 lines.
 *
 * `set-clipboard on` makes tmux pass an OSC 52 copy request from a program in
 * the pane through to the browser; its default of `external` drops it, so a
 * coding agent's "press c to copy the login URL" does nothing.
 *
 * `focus-events on` makes tmux forward focus in and out to those programs, so
 * Claude Code stops warning about it on first launch.
 */
function serverOptionArgs(): string[] {
	return [
		"set-option",
		"-s",
		"terminal-overrides",
		"*:smcup@:rmcup@:indn@:rin@:E3=\\E[3J",
		";",
		"set-option",
		"-s",
		"set-clipboard",
		"on",
		";",
		"set-option",
		"-s",
		"focus-events",
		"on",
		";",
		"set-option",
		"-g",
		"history-limit",
		String(HISTORY_LINES),
		";",
	];
}

/**
 * And how many bytes, which is the limit that actually holds: a line can be
 * any length, and escape sequences make it longer again. The newest lines are
 * the ones worth keeping, so the cut is made from the front.
 */
const HISTORY_BYTES = 256 * 1024;

/**
 * The tail of `text` that fits in the budget, starting at a line boundary.
 * The newest lines are the ones worth keeping, so the cut is at the front.
 */
function newestLinesWithin(text: string, budget: number): string {
	if (Buffer.byteLength(text, "utf8") <= budget) return text;
	const kept = Buffer.from(text, "utf8").subarray(-budget).toString("utf8");
	const boundary = kept.indexOf("\n");
	// A single line longer than the whole budget leaves no boundary to cut at.
	return boundary === -1 ? "" : kept.slice(boundary + 1);
}

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
	// CRLF first, then the cut, so the budget is what actually goes on the
	// wire rather than what tmux printed.
	const lines = `${text.replace(/\n$/, "").replace(/\n/g, "\r\n")}\r\n`;
	return newestLinesWithin(lines, HISTORY_BYTES);
}

export interface TmuxSession {
	id: string;
	cwd: string;
}

/**
 * The only commands a launcher may start (SPEC.md §10.2). The request names
 * an agent, never a command string.
 */
export function commandForAgent(agent: CodingAgent): string[] {
	switch (agent) {
		case "claude":
			return ["claude"];
		case "codex":
			return ["codex"];
	}
}

export interface SessionBaseline {
	baselineObjectId: string | null;
	baselineHead: string | null;
}

/** What a launcher adds to one new session (SPEC.md §10.2, §10.6, §10.9). */
export interface SessionLaunch {
	/** Argv tmux runs instead of a login shell. Absent for an ordinary terminal. */
	command?: readonly string[];
	/**
	 * Institution keys for this session only. Passed to tmux with `-e` and
	 * never written down.
	 */
	institutionalEnv?: {
		ANTHROPIC_API_KEY?: string;
		OPENAI_API_KEY?: string;
	};
	/**
	 * Records the review baseline in the resolved project directory before
	 * tmux starts. Supplied by the server so this file does not import git.
	 */
	recordBaseline?: (dir: string) => Promise<SessionBaseline>;
}

const EMPTY_BASELINE: SessionBaseline = {
	baselineObjectId: null,
	baselineHead: null,
};

/** `-e` flags for the two institutional keys, and nothing else. */
function credentialArgs(env: SessionLaunch["institutionalEnv"]): string[] {
	if (!env) return [];
	const args: string[] = [];
	for (const name of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"] as const) {
		const value = env[name];
		if (value === undefined) continue;
		if (value.includes("\0") || value.includes("\n")) {
			throw new AgentFailure("BAD_REQUEST", "invalid credential");
		}
		args.push("-e", `${name}=${value}`);
	}
	return args;
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

/** Create the tmux session that backs one terminal (SPEC.md §9.7, §10.2). */
export async function createSession(
	id: string,
	cwd: string,
	homeDir: string,
	theme: TerminalTheme,
	timezone: string,
	socketName?: string,
	launch?: SessionLaunch,
): Promise<TmuxSession & SessionBaseline> {
	const name = sessionName(id);
	const real = await resolveCwd(cwd, homeDir);
	// The baseline is recorded before the agent can write (SPEC.md §10.9).
	// A failure here still starts the CLI.
	let baseline = EMPTY_BASELINE;
	if (launch?.command && launch.recordBaseline) {
		try {
			baseline = await launch.recordBaseline(real);
		} catch {
			baseline = EMPTY_BASELINE;
		}
	}
	const command = launch?.command;
	await tmux(
		[
			...serverOptionArgs(),
			"new-session",
			"-d",
			"-s",
			name,
			"-c",
			real,
			// Programs that pick a theme by auto-detection, Claude Code among
			// them, read COLORFGBG (issue #267). The value is the foreground
			// and background as ANSI colour numbers, so a light terminal is
			// dark text on light. A shell already running keeps what it
			// started with; only a new terminal gets the new value.
			"-e",
			`COLORFGBG=${theme === "light" ? "0;15" : "15;0"}`,
			// The shell runs in the owner's zone (issue #287). A terminal
			// opened after the setting changed gets it without a restart; one
			// already running keeps the zone it started with.
			"-e",
			`TZ=${timezone}`,
			// Keys ride on this session only, and only for an agent command
			// (SPEC.md §10.6).
			...(command ? credentialArgs(launch?.institutionalEnv) : []),
			...(command ?? []),
		],
		socketName,
	);
	// `latest` sizes the session to the most recent client, so a second
	// attachment does not shrink the terminal to the smallest window.
	await tmux(["set-option", "-t", name, "window-size", "latest"], socketName);
	await tmux(["set-option", "-t", name, "status", "off"], socketName);
	return { id, cwd: real, ...baseline };
}

export interface PaneState {
	/** The pane's working directory (SPEC.md §9.3). */
	path: string | null;
	/** True while a full-screen program holds the pane (SPEC.md §9.7). */
	alternate: boolean;
}

/**
 * What the browser needs to know about every terminal's pane, keyed by
 * terminal id. One tmux call for the whole workspace, because this is polled
 * several times a second and a workspace can have eight terminals.
 */
export async function listPanes(socketName?: string): Promise<Map<string, PaneState>> {
	const stdout = await tmux(
		[
			"list-panes",
			"-a",
			"-F",
			"#{session_name}\t#{pane_current_path}\t#{alternate_on}",
		],
		socketName,
	);
	const panes = new Map<string, PaneState>();
	for (const line of stdout.split("\n")) {
		const [name, path = "", alternate = ""] = line.split("\t");
		if (!name?.startsWith("pk-")) continue;
		panes.set(name.slice(3), {
			path: path === "" ? null : path,
			alternate: alternate === "1",
		});
	}
	return panes;
}

export async function killSession(id: string, socketName?: string): Promise<void> {
	await tmux(["kill-session", "-t", sessionName(id)], socketName);
}
