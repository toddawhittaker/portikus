/**
 * Reading and stopping one of the student's processes (SPEC.md §18.3;
 * SPEC.md §18.3). The agent runs as the student, so the
 * kernel already refuses anyone else's process; the protected list keeps
 * the agent, the tmux server the agent runs the terminals in, and PID 1 from
 * being signalled by accident. Command lines are returned to the student only and never logged.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PROCESS_COMMAND_LINE_LIMIT } from "@portikus/contracts";
import { AgentFailure } from "./errors.js";

/** How long a stopped process has to exit before the answer is "still running". */
export const STOP_GRACE_MS = 3000;

const POLL_MS = 100;

/** What `/proc/<pid>/stat` and `status` say about one process. */
export interface ProcessFacts {
	pid: number;
	/** Short name, between the first `(` and the last `)` of the stat line. */
	name: string;
	/** Single-letter state; `Z` is a zombie. */
	state: string;
	startTicks: number;
	utime: number;
	stime: number;
	/** Real and effective uid from `status`. */
	uids: [number, number];
}

/** Who may not be signalled, and whose command lines may be read. */
export interface ProcessOwner {
	/** The agent's own PID. */
	selfPid: number;
	/** The student's uid, which the agent runs as. */
	studentUid: number;
	/**
	 * The terminals' tmux server, found by the agent's own socket, or null
	 * when none runs. By PID, not by name: any process can call itself
	 * "tmux: server".
	 */
	tmuxPid: number | null;
}

/** The fields of a stat line that a stop and a usage sample need. */
export interface StatLine {
	name: string;
	state: string;
	startTicks: number;
	utime: number;
	stime: number;
}

/** Parse a stat line. The name may hold spaces and parentheses. */
export function parseStatLine(text: string): StatLine | null {
	const open = text.indexOf("(");
	const close = text.lastIndexOf(")");
	if (open < 0 || close < open) return null;
	const fields = text
		.slice(close + 1)
		.trim()
		.split(/\s+/);
	// Field 3 (state) is index 0 after the name; utime (14) and stime (15)
	// are indexes 11 and 12; starttime (22) is index 19.
	const state = fields[0];
	const utime = Number(fields[11]);
	const stime = Number(fields[12]);
	const startTicks = Number(fields[19]);
	if (!state || !Number.isSafeInteger(startTicks) || startTicks < 0) return null;
	if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
	return { name: text.slice(open + 1, close), state, startTicks, utime, stime };
}

/** Real and effective uid from a `status` file. */
export function parseStatusUids(text: string): [number, number] | null {
	const line = text.split("\n").find((one) => one.startsWith("Uid:"));
	if (!line) return null;
	const [real, effective] = line.slice(4).trim().split(/\s+/).map(Number);
	if (!Number.isSafeInteger(real) || !Number.isSafeInteger(effective)) return null;
	return [real as number, effective as number];
}

/** Read one process, or null when it is gone or unreadable. */
export async function readProcess(
	procRoot: string,
	pid: number,
): Promise<ProcessFacts | null> {
	const [statText, statusText] = await Promise.all([
		readText(join(procRoot, String(pid), "stat")),
		readText(join(procRoot, String(pid), "status")),
	]);
	if (statText === null || statusText === null) return null;
	const stat = parseStatLine(statText);
	const uids = parseStatusUids(statusText);
	if (!stat || !uids) return null;
	return { pid, ...stat, uids };
}

/** Whether the student owns the process: both its real and effective uid are theirs. */
export function ownedByStudent(
	facts: Pick<ProcessFacts, "uids">,
	owner: Pick<ProcessOwner, "studentUid">,
): boolean {
	return facts.uids[0] === owner.studentUid && facts.uids[1] === owner.studentUid;
}

/** A process no stop path may signal (SPEC.md §18.3). */
export function isProtected(facts: ProcessFacts, owner: ProcessOwner): boolean {
	return (
		facts.pid === 1 ||
		facts.pid === owner.selfPid ||
		!ownedByStudent(facts, owner) ||
		facts.pid === owner.tmuxPid
	);
}

/** A `cmdline` file as one line: NULs become spaces, capped for the wire. */
export function formatCommandLine(raw: string): string | null {
	const line = raw.replace(/\0+$/, "").replaceAll("\0", " ");
	if (line === "") return null;
	return line.slice(0, PROCESS_COMMAND_LINE_LIMIT);
}

/** The command line of one of the student's own processes, or null. */
export async function readCommandLine(
	procRoot: string,
	pid: number,
): Promise<string | null> {
	const raw = await readText(join(procRoot, String(pid), "cmdline"));
	return raw === null ? null : formatCommandLine(raw);
}

/** How long a "no tmux server" answer is reused before tmux is asked again. */
const NO_SERVER_REUSE_MS = 10_000;

/**
 * Remembers the tmux server's PID while that process lives, so a usage
 * sample each second does not start a tmux client each second. `lookup`
 * asks tmux itself; a PID left over from a dead server is asked again.
 * A "no server" answer is reused for ten seconds unless `fresh` is set,
 * which a stop does so a just-started server is never missed.
 */
export function tmuxPidSource(
	procRoot: string,
	lookup: () => Promise<number | null>,
	now: () => number = Date.now,
): (fresh?: boolean) => Promise<number | null> {
	let known: { pid: number; startTicks: number } | null = null;
	let noServerAt: number | null = null;
	return async (fresh = false) => {
		if (known) {
			const facts = await readProcess(procRoot, known.pid);
			if (facts && facts.startTicks === known.startTicks) return known.pid;
			known = null;
		}
		if (!fresh && noServerAt !== null && now() - noServerAt < NO_SERVER_REUSE_MS) {
			return null;
		}
		noServerAt = null;
		const pid = await lookup();
		if (pid === null) {
			noServerAt = now();
			return null;
		}
		const facts = await readProcess(procRoot, pid);
		if (facts) known = { pid, startTicks: facts.startTicks };
		return pid;
	};
}

export interface StopOptions extends Omit<ProcessOwner, "tmuxPid"> {
	/** The terminals' tmux server PID, or null when none runs. */
	tmuxPid: () => Promise<number | null>;
	procRoot: string;
	/** Sends the signal. Tests may replace it; production is `process.kill`. */
	kill: (pid: number, signal: NodeJS.Signals) => void;
	graceMs?: number;
	pollMs?: number;
}

/**
 * Send SIGTERM (SIGKILL when `force`) to one of the student's processes and
 * wait up to the grace for it to go. Never escalates on its own.
 */
export async function stopProcess(
	pid: number,
	request: { startTicks: number; force: boolean },
	options: StopOptions,
): Promise<{ pid: number; exited: boolean }> {
	const facts = await readProcess(options.procRoot, pid);
	if (!facts) throw new AgentFailure("PROCESS_NOT_FOUND", "no such process");
	if (facts.startTicks !== request.startTicks) {
		throw new AgentFailure("PROCESS_CHANGED", "the process id was reused");
	}
	const owner = { ...options, tmuxPid: await options.tmuxPid() };
	if (isProtected(facts, owner)) {
		throw new AgentFailure("PROCESS_PROTECTED", "this process is protected");
	}
	try {
		options.kill(pid, request.force ? "SIGKILL" : "SIGTERM");
	} catch (error) {
		// It exited between the read and the signal.
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return { pid, exited: true };
		if ((error as NodeJS.ErrnoException).code === "EPERM") {
			throw new AgentFailure("PROCESS_PROTECTED", "this process is protected");
		}
		throw error;
	}
	const deadline = Date.now() + (options.graceMs ?? STOP_GRACE_MS);
	const pollMs = options.pollMs ?? POLL_MS;
	for (;;) {
		if (await gone(options.procRoot, pid, request.startTicks))
			return { pid, exited: true };
		if (Date.now() >= deadline) return { pid, exited: false };
		await new Promise((resolve) => setTimeout(resolve, pollMs));
	}
}

/** Gone, a zombie, or a different process under the same PID. */
async function gone(
	procRoot: string,
	pid: number,
	startTicks: number,
): Promise<boolean> {
	const facts = await readProcess(procRoot, pid);
	return !facts || facts.state === "Z" || facts.startTicks !== startTicks;
}

async function readText(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return null;
	}
}
