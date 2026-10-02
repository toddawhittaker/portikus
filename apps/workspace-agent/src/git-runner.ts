/**
 * Running git as a child process, with capped output and a timeout. Kept
 * apart from the status and baseline code so project creation can use it
 * without importing the file routes back through git.ts.
 */
import { spawn } from "node:child_process";
import { GIT_TIMEOUT_MS } from "@portikus/contracts";
import { AgentFailure } from "./errors.js";

/** How much git stderr is kept: a project create sends its tail to the student. */
export const STDERR_LIMIT = 2048;

export interface GitResult {
	ok: boolean;
	stdout: Buffer;
	stderr: string;
	/** The output passed the byte cap and the child was killed. */
	overflow: boolean;
	/** The timer fired and the child was killed. */
	timedOut: boolean;
	/** The exit status, or null when a signal ended the child. */
	exitCode: number | null;
}

/** Kill the whole process group, so any helper git spawned dies with it. */
function killGroup(pid: number | undefined): void {
	if (pid === undefined) return;
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		// The child is already gone, which is the outcome we wanted.
	}
}

/**
 * Run git with argv only, never a shell. Output is capped, so a huge blob
 * cannot be buffered without limit; the child is killed once past the cap.
 */
export async function runGit(
	args: string[],
	cwd: string,
	maxBytes: number,
	timeoutMs: number = GIT_TIMEOUT_MS,
	options: {
		config?: readonly string[];
		env?: Readonly<Record<string, string>>;
		/** Exact stdin bytes. Used to hash a symlink target without following it. */
		input?: Buffer;
	} = {},
): Promise<GitResult> {
	// A repository config could name a filesystem monitor. Turn it off (SPEC.md §24.6).
	const configArgs: string[] = ["-c", "core.fsmonitor="];
	for (const item of options.config ?? []) {
		configArgs.push("-c", item);
	}
	return new Promise<GitResult>((resolve, reject) => {
		const child = spawn("git", [...configArgs, ...args], {
			cwd,
			stdio: [options.input ? "pipe" : "ignore", "pipe", "pipe"],
			// Its own process group, so a kill reaches helpers too.
			detached: true,
			env: {
				...process.env,
				// Reading status must never write the index or ask for a password.
				GIT_OPTIONAL_LOCKS: "0",
				GIT_TERMINAL_PROMPT: "0",
				LC_ALL: "C",
				...options.env,
			},
		});
		const chunks: Buffer[] = [];
		let size = 0;
		let overflow = false;
		let timedOut = false;
		let stderr = "";
		let settled = false;

		const timer = setTimeout(() => {
			timedOut = true;
			killGroup(child.pid);
		}, timeoutMs);

		const stdout = child.stdout;
		const stderrStream = child.stderr;
		if (!stdout || !stderrStream) {
			settled = true;
			clearTimeout(timer);
			killGroup(child.pid);
			reject(new AgentFailure("GIT_FAILED", "could not run git"));
			return;
		}
		if (options.input) {
			const stdin = child.stdin;
			if (!stdin) {
				settled = true;
				clearTimeout(timer);
				killGroup(child.pid);
				reject(new AgentFailure("GIT_FAILED", "could not run git"));
				return;
			}
			stdin.on("error", () => {});
			stdin.end(options.input);
		}

		stdout.on("data", (chunk: Buffer) => {
			if (overflow) return;
			size += chunk.length;
			if (size > maxBytes) {
				overflow = true;
				killGroup(child.pid);
				return;
			}
			chunks.push(chunk);
		});
		stderrStream.on("data", (chunk: Buffer) => {
			stderr = (stderr + chunk.toString()).slice(-STDERR_LIMIT);
		});
		child.on("error", (error: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(new AgentFailure("GIT_FAILED", `could not run git: ${error.message}`));
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({
				ok: code === 0 && !overflow && !timedOut,
				stdout: Buffer.concat(chunks),
				stderr: stderr.trim(),
				overflow,
				timedOut,
				exitCode: code,
			});
		});
	});
}
