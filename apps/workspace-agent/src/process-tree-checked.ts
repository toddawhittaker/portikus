/**
 * Monitor's "Stop with children" and "Lower priority" (SPEC.md §18.3). Both
 * act on the tree {@link collectProcessTree} finds, with the single stop's
 * checks applied to every member: matching start ticks, so a PID reused
 * between the list and the act is never touched, and the protected set.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
	PROCESS_TREE_LIMIT,
	type ProcessIdentity,
	type ProcessTreeStopRequest,
	type ProcessTreeStopResponse,
} from "@portikus/contracts";
import { AgentFailure } from "./errors.js";
import { collectProcessTree } from "./process-tree.js";
import {
	gone,
	isProtected,
	parseStatLine,
	readProcess,
	readText,
	type SignalOptions,
	STOP_GRACE_MS,
	type StopOptions,
	signalProcess,
} from "./processes.js";

const POLL_MS = 100;

/** The members of a checked tree that may be touched, and how many may not. */
interface CheckedTree {
	members: ProcessIdentity[];
	refused: number;
	/** The caller's options with the protected set read once for the tree. */
	options: SignalOptions;
}

/**
 * The root gets the single stop's refusals. Every other member is re-read and
 * kept only when its start ticks still match; a protected member is counted
 * as refused and left alone.
 */
async function checkedTree(
	pid: number,
	startTicks: number,
	options: SignalOptions,
): Promise<CheckedTree> {
	const root = await readProcess(options.procRoot, pid);
	if (!root) throw new AgentFailure("PROCESS_NOT_FOUND", "no such process");
	if (root.startTicks !== startTicks) {
		throw new AgentFailure("PROCESS_CHANGED", "the process id was reused");
	}
	const protectedPids = await options.protectedPids();
	const owner = { ...options, protectedPids };
	if (isProtected(root, owner)) {
		throw new AgentFailure("PROCESS_PROTECTED", "this process is protected");
	}
	const members: ProcessIdentity[] = [root];
	let refused = 0;
	const tree = await collectProcessTree(pid, String(startTicks), options.procRoot);
	for (const entry of tree) {
		if (entry.pid === pid) continue;
		const facts = await readProcess(options.procRoot, entry.pid);
		// Gone since the tree was read, or its PID already reused: not ours to touch.
		if (!facts || String(facts.startTicks) !== entry.startTime) continue;
		if (isProtected(facts, owner)) refused += 1;
		else members.push(facts);
	}
	return {
		members,
		refused,
		options: { ...options, protectedPids: async () => protectedPids },
	};
}

/** The survivors of a first stop, named again by the Force stop that follows. */
async function namedMembers(
	remaining: readonly ProcessIdentity[],
	options: SignalOptions,
): Promise<CheckedTree> {
	const protectedPids = await options.protectedPids();
	return {
		members: [...remaining],
		refused: 0,
		options: { ...options, protectedPids: async () => protectedPids },
	};
}

/**
 * Stop a process and everything it started, or, for a Force stop, the named
 * survivors of the first stop. Each one is signalled through
 * {@link signalProcess}, which re-reads its start ticks just before the
 * signal; the protected set is read once per request. Like a single stop, it waits up to the grace and
 * never escalates to SIGKILL on its own.
 */
export async function stopCheckedTree(
	pid: number,
	request: ProcessTreeStopRequest,
	options: StopOptions,
): Promise<ProcessTreeStopResponse> {
	const tree = request.remaining
		? await namedMembers(request.remaining, options)
		: await checkedTree(pid, request.startTicks, options);
	const signal = request.force ? "SIGKILL" : "SIGTERM";
	let { refused } = tree;
	const sent: ProcessIdentity[] = [];
	for (const member of tree.members) {
		try {
			if (await signalProcess(member.pid, member.startTicks, signal, tree.options)) {
				sent.push(member);
			}
		} catch (error) {
			if (!(error instanceof AgentFailure)) throw error;
			if (error.code === "PROCESS_PROTECTED") refused += 1;
			// Not found or changed: it exited before the signal.
		}
	}
	const deadline = Date.now() + (options.graceMs ?? STOP_GRACE_MS);
	const pollMs = options.pollMs ?? POLL_MS;
	let left = sent;
	for (;;) {
		const still: ProcessIdentity[] = [];
		for (const member of left) {
			if (!(await gone(options.procRoot, member.pid, member.startTicks))) {
				still.push(member);
			}
		}
		left = still;
		if (left.length === 0 || Date.now() >= deadline) break;
		await new Promise((resolve) => setTimeout(resolve, pollMs));
	}
	return {
		pid,
		exited: left.length === 0,
		signalled: sent.length,
		refused,
		remaining: left
			.slice(0, PROCESS_TREE_LIMIT)
			.map((member) => ({ pid: member.pid, startTicks: member.startTicks })),
	};
}

/** How far "Lower priority" moves a nice value, and the least favoured value. */
const PRIORITY_STEP = 10;
const NICE_LOWEST = 19;

/** The nice value "Lower priority" sets: never below the current one. */
export function loweredNice(current: number): number {
	return Math.max(current, Math.min(NICE_LOWEST, current + PRIORITY_STEP));
}

export interface PriorityOptions extends SignalOptions {
	/** Sets one thread's nice value. Production is `os.setPriority`. */
	setPriority: (tid: number, nice: number) => void;
}

/** A process's threads with their nice values; the process alone when `task` is unreadable. */
async function threadsOf(
	procRoot: string,
	pid: number,
): Promise<{ tid: number; nice: number }[]> {
	const taskDir = join(procRoot, String(pid), "task");
	let names: string[];
	try {
		names = await readdir(taskDir);
	} catch {
		names = [];
	}
	const threads: { tid: number; nice: number }[] = [];
	for (const name of names) {
		if (!/^[1-9]\d*$/.test(name)) continue;
		const text = await readText(join(taskDir, name, "stat"));
		const stat = text === null ? null : parseStatLine(text);
		if (stat) threads.push({ tid: Number(name), nice: stat.nice });
	}
	if (threads.length > 0) return threads;
	const text = await readText(join(procRoot, String(pid), "stat"));
	const stat = text === null ? null : parseStatLine(text);
	return stat ? [{ tid: pid, nice: stat.nice }] : [];
}

/**
 * Lower the priority of a process and everything it started: nice +10 on
 * every thread, capped at 19. A nice value only ever goes up, so nothing is
 * made more favoured. Linux keeps nice per thread, so each thread is set.
 */
export async function lowerCheckedTreePriority(
	pid: number,
	request: { startTicks: number },
	options: PriorityOptions,
): Promise<{ pid: number; lowered: number; refused: number }> {
	const tree = await checkedTree(pid, request.startTicks, options);
	let { refused } = tree;
	let lowered = 0;
	for (const member of tree.members) {
		// Re-read just before acting, as a signal does.
		const now = await readProcess(options.procRoot, member.pid);
		if (!now || now.startTicks !== member.startTicks) continue;
		let changed = false;
		try {
			for (const thread of await threadsOf(options.procRoot, member.pid)) {
				const target = loweredNice(thread.nice);
				if (target <= thread.nice) continue;
				options.setPriority(thread.tid, target);
				changed = true;
			}
		} catch (error) {
			// os.setPriority throws ERR_SYSTEM_ERROR with the errno name in `info`.
			const failure = error as { code?: string; info?: { code?: string } };
			const code = failure.info?.code ?? failure.code;
			if (code === "EACCES" || code === "EPERM") refused += 1;
			else if (code !== "ESRCH") throw error;
			continue;
		}
		if (changed) lowered += 1;
	}
	return { pid, lowered, refused };
}
