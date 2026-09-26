/**
 * Stopping a whole process tree (SPEC.md §9.7, §18.1). Closing a terminal or
 * stopping a Check must also stop what its shell started in the background,
 * including `nohup` and `setsid` children that a hangup alone leaves running.
 */
import { readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { STOP_GRACE_MS } from "./listening.js";

/** One process, identified by pid and start time so a reused pid is never hit. */
export interface TreeProcess {
	pid: number;
	startTime: string;
}

interface ProcStat {
	pid: number;
	ppid: number;
	session: number;
	startTime: string;
}

/** Parse `/proc/<pid>/stat`. The command name may hold spaces and brackets. */
function parseStat(text: string): ProcStat | null {
	const close = text.lastIndexOf(")");
	if (close === -1) return null;
	const pid = Number.parseInt(text, 10);
	// After the name: state ppid pgrp session ... with starttime as field 22.
	const fields = text.slice(close + 2).split(" ");
	const ppid = Number(fields[1]);
	const session = Number(fields[3]);
	const startTime = fields[19];
	if (!Number.isInteger(pid) || !Number.isInteger(ppid) || startTime === undefined) {
		return null;
	}
	return { pid, ppid, session, startTime };
}

async function readStat(pid: number): Promise<ProcStat | null> {
	try {
		return parseStat(await readFile(`/proc/${pid}/stat`, "utf8"));
	} catch {
		return null;
	}
}

function allProcesses(): ProcStat[] {
	// Synchronous on purpose: a workspace has few processes, and a thousand
	// small async reads queue behind the thread pool and take ten times longer.
	const found: ProcStat[] = [];
	for (const name of readdirSync("/proc")) {
		if (!/^\d+$/.test(name)) continue;
		try {
			const stat = parseStat(readFileSync(`/proc/${name}/stat`, "utf8"));
			if (stat) found.push(stat);
		} catch {
			// The process ended while we looked.
		}
	}
	return found;
}

/**
 * The root, every descendant by parent pid, and, when the root leads its own
 * session, every process in that session. Never the agent itself.
 */
export async function collectProcessTree(rootPid: number): Promise<TreeProcess[]> {
	const processes = allProcesses();
	const root = processes.find((entry) => entry.pid === rootPid);
	if (!root) return [];
	const children = new Map<number, ProcStat[]>();
	for (const entry of processes) {
		const list = children.get(entry.ppid) ?? [];
		list.push(entry);
		children.set(entry.ppid, list);
	}
	const chosen = new Map<number, ProcStat>([[root.pid, root]]);
	const queue = [root.pid];
	while (queue.length > 0) {
		const pid = queue.pop() as number;
		for (const child of children.get(pid) ?? []) {
			if (chosen.has(child.pid)) continue;
			chosen.set(child.pid, child);
			queue.push(child.pid);
		}
	}
	// Only a session the root leads: otherwise the session could be the agent's.
	if (root.session === root.pid) {
		for (const entry of processes) {
			if (entry.session === root.pid) chosen.set(entry.pid, entry);
		}
	}
	chosen.delete(process.pid);
	return [...chosen.values()].map(({ pid, startTime }) => ({ pid, startTime }));
}

async function alive(target: TreeProcess): Promise<boolean> {
	const stat = await readStat(target.pid);
	return stat !== null && stat.startTime === target.startTime;
}

function signal(pid: number, name: NodeJS.Signals): void {
	try {
		process.kill(pid, name);
	} catch {
		// Already gone, or not ours to signal.
	}
}

const POLL_MS = 100;

/** SIGTERM every process, then SIGKILL whatever is left after the grace period. */
export async function stopProcesses(
	targets: readonly TreeProcess[],
	graceMs: number = STOP_GRACE_MS,
): Promise<void> {
	for (const target of targets) {
		if (await alive(target)) signal(target.pid, "SIGTERM");
	}
	const deadline = Date.now() + graceMs;
	let left = [...targets];
	while (left.length > 0 && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, POLL_MS));
		const still: TreeProcess[] = [];
		for (const target of left) if (await alive(target)) still.push(target);
		left = still;
	}
	for (const target of left) {
		if (await alive(target)) signal(target.pid, "SIGKILL");
	}
}

/** Stop a process and everything it started (SPEC.md §9.7, §18.1). */
export async function killProcessTree(
	rootPid: number,
	graceMs: number = STOP_GRACE_MS,
): Promise<void> {
	await stopProcesses(await collectProcessTree(rootPid), graceMs);
}
