import { execFile } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
	type AgentErrorCode,
	type CodingAgent,
	TerminalId,
	type TerminalTheme,
} from "@portikus/contracts";
import { collectProcessTree, stopProcesses } from "./process-tree.js";

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

/** Which tmux server the agent talks to (SPEC.md §9.7). */
export interface TmuxServer {
	/** The socket name, `portikus` in a workspace; tests pass their own. */
	socketName: string;
	/**
	 * True when the terminals unit runs the server. The agent then never
	 * starts one, so a missing server is an error rather than a new server
	 * in the agent's own cgroup.
	 */
	external: boolean;
}

/**
 * `-f /dev/null` so a student's `~/.tmux.conf` can never break a terminal:
 * every option the agent needs is set on each `new-session` instead.
 */
function serverArgs(server: TmuxServer): string[] {
	return [
		"-L",
		server.socketName,
		"-f",
		"/dev/null",
		...(server.external ? ["-N"] : []),
	];
}

/** How long any one tmux command may take before it is killed. */
const TMUX_TIMEOUT_MS = 5000;

/**
 * The wrapper every ordinary terminal starts in (SPEC.md §9.7). It ships in
 * this package, so it reaches every workspace through the agent's bind mount.
 */
export const SHELL_WRAPPER = fileURLToPath(
	new URL("../scripts/portikus-shell", import.meta.url),
);

/** The tmux session name for a terminal (SPEC.md §9.7). */
export function sessionName(id: string): string {
	if (!TerminalId.safeParse(id).success) {
		throw new AgentFailure("TERMINAL_NOT_FOUND", "invalid terminal id");
	}
	return `pk-${id}`;
}

/** The command line every attachment uses, so both sides agree on the socket. */
export function attachArgs(id: string, server: TmuxServer): string[] {
	return [...serverArgs(server), "attach-session", "-t", sessionName(id)];
}

/**
 * How much output one tmux command may produce. A history capture is the only
 * large one, and it is cut to a much smaller budget straight afterwards; this
 * is the ceiling that keeps a pathological pane from being read into memory in
 * the first place.
 */
const TMUX_MAX_OUTPUT_BYTES = 1024 * 1024;

/**
 * tmux's answers that mean "that session or server is not there". A server
 * started with -D that has no sessions says "no current target".
 */
const MISSING =
	/can't find session|no current target|no server running|error connecting/;

/** Thrown for a missing session or server, so callers can tell it from a real failure. */
class TmuxMissing extends AgentFailure {}

async function tmux(args: string[], server: TmuxServer): Promise<string> {
	try {
		const { stdout } = await run("tmux", [...serverArgs(server), ...args], {
			maxBuffer: TMUX_MAX_OUTPUT_BYTES,
			timeout: TMUX_TIMEOUT_MS,
			killSignal: "SIGKILL",
		});
		return stdout;
	} catch (error) {
		const failure = error as { stderr?: unknown; killed?: boolean; signal?: unknown };
		if (failure.killed && failure.signal === "SIGKILL") {
			throw new AgentFailure("TMUX_FAILED", "tmux did not answer in time");
		}
		const stderr = typeof failure.stderr === "string" ? failure.stderr.trim() : "";
		if (server.external && /no server running|error connecting/.test(stderr)) {
			throw new TmuxMissing(
				"TMUX_FAILED",
				"The terminal service is not running; it restarts on its own within seconds.",
			);
		}
		if (MISSING.test(stderr)) throw new TmuxMissing("TMUX_FAILED", stderr);
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
export async function captureHistory(id: string, server: TmuxServer): Promise<string> {
	const name = sessionName(id);
	const size = Number.parseInt(
		(
			await tmux(["display-message", "-p", "-t", name, "#{history_size}"], server)
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
		server,
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
export async function listSessions(server: TmuxServer): Promise<TmuxSession[]> {
	let stdout: string;
	try {
		stdout = await tmux(
			["list-sessions", "-F", "#{session_name}\t#{session_path}"],
			server,
		);
	} catch (error) {
		// No server running yet means no sessions; a timeout is a real failure.
		if (error instanceof TmuxMissing) return [];
		throw error;
	}
	const sessions: TmuxSession[] = [];
	for (const line of stdout.split("\n")) {
		const [name, cwd] = line.split("\t");
		if (!name?.startsWith("pk-")) continue;
		sessions.push({ id: name.slice(3), cwd: cwd ?? "" });
	}
	return sessions;
}

/**
 * True when the terminals unit's tmux server is gone (SPEC.md §9.7). Only in
 * external mode: otherwise tmux exits on its own after the last session.
 */
export async function tmuxServerGone(server: TmuxServer): Promise<boolean> {
	if (!server.external) return false;
	try {
		await tmux(["list-sessions", "-F", "#{session_name}"], server);
		return false;
	} catch (error) {
		return error instanceof TmuxMissing;
	}
}

export async function hasSession(id: string, server: TmuxServer): Promise<boolean> {
	try {
		await tmux(["has-session", "-t", sessionName(id)], server);
		return true;
	} catch (error) {
		if (error instanceof TmuxMissing) return false;
		throw error;
	}
}

/** Create the tmux session that backs one terminal (SPEC.md §9.7, §10.2). */
export async function createSession(
	id: string,
	cwd: string,
	homeDir: string,
	theme: TerminalTheme,
	timezone: string,
	server: TmuxServer,
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
	try {
		await createTmuxSession(name, real, theme, timezone, server, command, launch);
	} catch (error) {
		// A half-made session would linger as an orphan terminal.
		await tmux(["kill-session", "-t", name], server).catch(() => undefined);
		throw error;
	}
	return { id, cwd: real, ...baseline };
}

async function createTmuxSession(
	name: string,
	real: string,
	theme: TerminalTheme,
	timezone: string,
	server: TmuxServer,
	command: readonly string[] | undefined,
	launch: SessionLaunch | undefined,
): Promise<void> {
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
			// An ordinary terminal starts in the wrapper, which clears TMUX and
			// survives a ~/.bashrc that exits (SPEC.md §9.7).
			...(command ?? [SHELL_WRAPPER]),
		],
		server,
	);
	// `latest` sizes the session to the most recent client, so a second
	// attachment does not shrink the terminal to the smallest window.
	await tmux(["set-option", "-t", name, "window-size", "latest"], server);
	await tmux(["set-option", "-t", name, "status", "off"], server);
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
export async function listPanes(server: TmuxServer): Promise<Map<string, PaneState>> {
	const stdout = await tmux(
		[
			"list-panes",
			"-a",
			"-F",
			"#{session_name}\t#{pane_current_path}\t#{alternate_on}",
		],
		server,
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

export async function killSession(id: string, server: TmuxServer): Promise<void> {
	await tmux(["kill-session", "-t", sessionName(id)], server);
}

/**
 * Close a terminal and stop everything its shell started, `nohup` and
 * `setsid` children included (SPEC.md §9.7). The tree is collected before
 * the session goes, while the shell is still its root. Resolves once the
 * session is gone; the processes are stopped in the background.
 */
export async function closeSession(
	id: string,
	server: TmuxServer,
): Promise<{ stopped: Promise<void> }> {
	const name = sessionName(id);
	const pid = Number.parseInt(
		(await tmux(["display-message", "-p", "-t", name, "#{pane_pid}"], server)).trim(),
		10,
	);
	const tree = Number.isInteger(pid) ? await collectProcessTree(pid) : [];
	await killSession(id, server);
	return { stopped: stopProcesses(tree, undefined, pid) };
}
