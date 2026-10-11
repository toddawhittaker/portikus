/**
 * Monitor's tree actions (SPEC.md §18.3, §24): every process in the tree gets
 * the single stop's checks, so a PID reused between the list and the act, or
 * a protected process inside the tree, is never touched, and "Lower
 * priority" never makes anything more favoured. Checked against a fake
 * `/proc`; signals and priority changes are recorded, not sent.
 */
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { getPriority, setPriority, tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, beforeEach, expect, test } from "vitest";
import { AgentFailure } from "./errors.js";
import {
	lowerCheckedTreePriority,
	loweredNice,
	stopCheckedTree,
} from "./process-tree-checked.js";
import { readProcess } from "./processes.js";
import { processesRoutes } from "./processes-route.js";

const STUDENT = 1000;
const SELF = 4242;
const TMUX = 305;

let fakeProc: string;
let signals: [number, string][];
let priorities: [number, number][];
/** Processes that ignore SIGTERM, like a trap '' TERM. */
let ignoresTerm: Set<number>;

interface Fake {
	pid: number;
	ppid: number;
	startTicks: number;
	uid?: number;
	nice?: number;
	/** Thread ids beyond the main one, each with its own nice value. */
	threads?: [number, number][];
}

/** A stat line: pid (name) state ppid pgrp session ... nice (19) ... starttime (22). */
function statLine(pid: number, ppid: number, startTicks: number, nice: number): string {
	const after = Array.from({ length: 20 }, () => "0");
	after[0] = "S";
	after[1] = String(ppid);
	after[16] = String(nice);
	after[19] = String(startTicks);
	return `${pid} (prog) ${after.join(" ")} 0 0\n`;
}

function writeProcess(fake: Fake): void {
	const dir = join(fakeProc, String(fake.pid));
	const uid = fake.uid ?? STUDENT;
	const nice = fake.nice ?? 0;
	mkdirSync(join(dir, "task"), { recursive: true });
	writeFileSync(
		join(dir, "stat"),
		statLine(fake.pid, fake.ppid, fake.startTicks, nice),
	);
	writeFileSync(
		join(dir, "status"),
		`Name:\tprog\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`,
	);
	for (const [tid, threadNice] of [
		[fake.pid, nice],
		...(fake.threads ?? []),
	] as const) {
		mkdirSync(join(dir, "task", String(tid)), { recursive: true });
		writeFileSync(
			join(dir, "task", String(tid), "stat"),
			statLine(tid, fake.ppid, fake.startTicks, threadNice),
		);
	}
}

function options() {
	return {
		procRoot: fakeProc,
		selfPid: SELF,
		studentUid: STUDENT,
		protectedPids: async () => new Set([TMUX]),
		kill: (pid: number, signal: NodeJS.Signals) => {
			signals.push([pid, signal]);
			if (signal === "SIGKILL" || !ignoresTerm.has(pid)) {
				rmSync(join(fakeProc, String(pid)), { recursive: true, force: true });
			}
		},
		setPriority: (tid: number, nice: number) => {
			priorities.push([tid, nice]);
		},
		graceMs: 50,
		pollMs: 10,
	};
}

beforeEach(async () => {
	fakeProc = await mkdtemp(join(tmpdir(), "portikus-tree-checked-"));
	signals = [];
	priorities = [];
	ignoresTerm = new Set();
	// npm (400) runs node (401), which runs a worker (402).
	writeProcess({ pid: 400, ppid: 1, startTicks: 4000 });
	writeProcess({ pid: 401, ppid: 400, startTicks: 4010 });
	writeProcess({ pid: 402, ppid: 401, startTicks: 4020 });
	// Someone else's process, not in the tree.
	writeProcess({ pid: 500, ppid: 1, startTicks: 5000 });
});

afterEach(async () => {
	await rm(fakeProc, { recursive: true, force: true });
});

async function failure(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof AgentFailure) return error.code;
		throw error;
	}
	return "no failure";
}

test("stop with children signals the root and every descendant, and nothing else", async () => {
	const answer = await stopCheckedTree(
		400,
		{ startTicks: 4000, force: false },
		options(),
	);
	expect(answer).toEqual({
		pid: 400,
		exited: true,
		signalled: 3,
		refused: 0,
		remaining: [],
	});
	expect(signals.map(([pid]) => pid).sort()).toEqual([400, 401, 402]);
	expect(signals.every(([, signal]) => signal === "SIGTERM")).toBe(true);
});

test("a root whose PID was reused since the list is refused, and nothing is signalled", async () => {
	expect(
		await failure(stopCheckedTree(400, { startTicks: 3999, force: false }, options())),
	).toBe("PROCESS_CHANGED");
	expect(
		await failure(lowerCheckedTreePriority(400, { startTicks: 3999 }, options())),
	).toBe("PROCESS_CHANGED");
	expect(signals).toEqual([]);
	expect(priorities).toEqual([]);
});

test("a child whose PID is reused between the tree read and its signal is not signalled", async () => {
	const base = options();
	const racing = {
		...base,
		kill: (pid: number, signal: NodeJS.Signals) => {
			base.kill(pid, signal);
			// As the root goes, 402 exits and a stranger's program takes its PID.
			if (pid === 400) writeProcess({ pid: 402, ppid: 1, startTicks: 9999 });
		},
	};
	const answer = await stopCheckedTree(400, { startTicks: 4000, force: false }, racing);
	expect(signals.map(([pid]) => pid)).not.toContain(402);
	expect(answer.signalled).toBe(2);
});

test("a protected process inside the tree is left alone and counted as refused", async () => {
	// The tmux server and a root-owned helper (sudo) both sit below the root.
	writeProcess({ pid: TMUX, ppid: 401, startTicks: 4030 });
	writeProcess({ pid: 403, ppid: 402, startTicks: 4040, uid: 0 });
	const answer = await stopCheckedTree(
		400,
		{ startTicks: 4000, force: false },
		options(),
	);
	expect(signals.map(([pid]) => pid)).not.toContain(TMUX);
	expect(signals.map(([pid]) => pid)).not.toContain(403);
	expect(answer).toMatchObject({ signalled: 3, refused: 2 });
});

test("lower priority skips a protected process inside the tree", async () => {
	writeProcess({ pid: TMUX, ppid: 401, startTicks: 4030 });
	writeProcess({ pid: 403, ppid: 402, startTicks: 4040, uid: 0 });
	const answer = await lowerCheckedTreePriority(400, { startTicks: 4000 }, options());
	expect(priorities.map(([tid]) => tid).sort()).toEqual([400, 401, 402]);
	expect(answer).toEqual({ pid: 400, lowered: 3, refused: 2 });
});

test("a protected root is refused outright", async () => {
	writeProcess({ pid: TMUX, ppid: 1, startTicks: 3050 });
	expect(
		await failure(stopCheckedTree(TMUX, { startTicks: 3050, force: false }, options())),
	).toBe("PROCESS_PROTECTED");
	expect(signals).toEqual([]);
});

test("a member that ignores SIGTERM leaves exited false, and Force stop sends SIGKILL", async () => {
	ignoresTerm.add(402);
	const plain = await stopCheckedTree(
		400,
		{ startTicks: 4000, force: false },
		options(),
	);
	expect(plain).toMatchObject({
		exited: false,
		remaining: [{ pid: 402, startTicks: 4020 }],
	});
	// Never escalated on its own.
	expect(signals.filter(([, signal]) => signal === "SIGKILL")).toEqual([]);

	// The root has gone, so Force stop names the survivors from the first answer.
	signals = [];
	const forced = await stopCheckedTree(
		400,
		{ startTicks: 4000, force: true, remaining: plain.remaining },
		options(),
	);
	expect(forced).toMatchObject({ exited: true, signalled: 1, remaining: [] });
	expect(signals).toEqual([[402, "SIGKILL"]]);
});

test("a named survivor whose PID was reused, or that is protected, is not signalled", async () => {
	writeProcess({ pid: TMUX, ppid: 1, startTicks: 3050 });
	const answer = await stopCheckedTree(
		400,
		{
			startTicks: 4000,
			force: true,
			remaining: [
				{ pid: 402, startTicks: 1 },
				{ pid: TMUX, startTicks: 3050 },
				{ pid: 401, startTicks: 4010 },
			],
		},
		options(),
	);
	expect(signals).toEqual([[401, "SIGKILL"]]);
	expect(answer).toMatchObject({ exited: true, signalled: 1, refused: 1 });
});

test("lower priority adds 10 to every thread's nice value, capped at 19", async () => {
	writeProcess({
		pid: 401,
		ppid: 400,
		startTicks: 4010,
		nice: 5,
		threads: [[411, 12]],
	});
	writeProcess({ pid: 402, ppid: 401, startTicks: 4020, nice: -5 });
	const answer = await lowerCheckedTreePriority(400, { startTicks: 4000 }, options());
	expect(new Map(priorities)).toEqual(
		new Map([
			[400, 10],
			[401, 15],
			[411, 19],
			[402, 5],
		]),
	);
	expect(answer).toEqual({ pid: 400, lowered: 3, refused: 0 });
});

test("lower priority never raises a priority: a thread at 19 is left as it is", async () => {
	writeProcess({ pid: 400, ppid: 1, startTicks: 4000, nice: 19 });
	writeProcess({ pid: 401, ppid: 400, startTicks: 4010, nice: 19 });
	writeProcess({ pid: 402, ppid: 401, startTicks: 4020, nice: 19 });
	const answer = await lowerCheckedTreePriority(400, { startTicks: 4000 }, options());
	expect(priorities).toEqual([]);
	expect(answer.lowered).toBe(0);
	for (const current of [-20, -1, 0, 9, 10, 18, 19]) {
		expect(loweredNice(current)).toBeGreaterThanOrEqual(current);
		expect(loweredNice(current)).toBeLessThanOrEqual(19);
	}
});

test("a priority change the kernel refuses counts as refused", async () => {
	const refusing = {
		...options(),
		setPriority: (tid: number) => {
			if (tid === 402) {
				throw Object.assign(new Error("denied"), {
					code: "ERR_SYSTEM_ERROR",
					info: { code: "EACCES" },
				});
			}
		},
	};
	const answer = await lowerCheckedTreePriority(400, { startTicks: 4000 }, refusing);
	expect(answer).toEqual({ pid: 400, lowered: 2, refused: 1 });
});

test("the routes answer the tree actions and refuse a bad body", async () => {
	const app = Fastify();
	await app.register(processesRoutes, options());
	try {
		const bad = await app.inject({
			method: "POST",
			url: "/processes/400/lower-priority",
			payload: { startTicks: 4000, nice: -20 },
		});
		expect(bad.statusCode).toBe(400);
		const lowered = await app.inject({
			method: "POST",
			url: "/processes/400/lower-priority",
			payload: { startTicks: 4000 },
		});
		expect(lowered.json()).toEqual({ pid: 400, lowered: 3, refused: 0 });
		const stopped = await app.inject({
			method: "POST",
			url: "/processes/400/stop-tree",
			payload: { startTicks: 4000 },
		});
		expect(stopped.json()).toEqual({
			pid: 400,
			exited: true,
			signalled: 3,
			refused: 0,
			remaining: [],
		});
	} finally {
		await app.close();
	}
});

test("on a real process tree, Lower priority sets nice +10 with os.setPriority, then Stop with children ends it", async () => {
	// bash runs a sleep in the background and waits, so the tree is two deep.
	const root = spawn("bash", ["-c", "sleep 30 & wait"]);
	try {
		const pid = root.pid as number;
		await new Promise((resolve) => setTimeout(resolve, 200));
		const facts = await readProcess("/proc", pid);
		const real = {
			procRoot: "/proc",
			selfPid: process.pid,
			studentUid: process.getuid?.() ?? 0,
			protectedPids: async () => new Set<number>(),
			kill: (target: number, signal: NodeJS.Signals) => process.kill(target, signal),
			setPriority,
			graceMs: 2000,
			pollMs: 20,
		};
		const before = getPriority(pid);
		const lowered = await lowerCheckedTreePriority(
			pid,
			{ startTicks: facts?.startTicks as number },
			real,
		);
		expect(lowered.lowered).toBe(2);
		expect(getPriority(pid)).toBe(Math.min(19, before + 10));
		const exited = new Promise((resolve) => root.on("exit", resolve));
		const stopped = await stopCheckedTree(
			pid,
			{ startTicks: facts?.startTicks as number, force: false },
			real,
		);
		expect(stopped).toMatchObject({ exited: true, signalled: 2, remaining: [] });
		await expect(exited).resolves.toBeDefined();
	} finally {
		root.kill("SIGKILL");
	}
});
