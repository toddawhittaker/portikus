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
function socketArgs(): string[] {
	const name = process.env.TMUX_SOCKET_NAME;
	return name ? ["-L", name] : [];
}

/** The tmux session name for a terminal (SPEC.md §9.7). */
export function sessionName(id: string): string {
	if (!TerminalId.safeParse(id).success) {
		throw new AgentFailure("TERMINAL_NOT_FOUND", "invalid terminal id");
	}
	return `pk-${id}`;
}

/** The command line every attachment uses, so both sides agree on the socket. */
export function attachArgs(id: string): string[] {
	return [...socketArgs(), "attach-session", "-t", sessionName(id)];
}

async function tmux(args: string[]): Promise<string> {
	try {
		const { stdout } = await run("tmux", [...socketArgs(), ...args]);
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

export interface TmuxSession {
	id: string;
	cwd: string;
}

/** Every `pk-*` session on this tmux server (SPEC.md §9.7). */
export async function listSessions(): Promise<TmuxSession[]> {
	let stdout: string;
	try {
		stdout = await tmux(["list-sessions", "-F", "#{session_name}\t#{session_path}"]);
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

export async function hasSession(id: string): Promise<boolean> {
	try {
		await tmux(["has-session", "-t", sessionName(id)]);
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
): Promise<TmuxSession> {
	const name = sessionName(id);
	const real = await resolveCwd(cwd, homeDir);
	await tmux(["new-session", "-d", "-s", name, "-c", real]);
	// `latest` sizes the session to the most recent client, so a second
	// attachment does not shrink the terminal to the smallest window.
	await tmux(["set-option", "-t", name, "window-size", "latest"]);
	await tmux(["set-option", "-t", name, "status", "off"]);
	await tmux(["set-option", "-t", name, "history-limit", "5000"]);
	return { id, cwd: real };
}

export async function killSession(id: string): Promise<void> {
	await tmux(["kill-session", "-t", sessionName(id)]);
}
