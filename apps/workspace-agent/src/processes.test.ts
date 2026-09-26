/**
 * Stopping one of the student's processes (SPEC.md §18.3; docs/EPIC-21.md
 * rulings 8 to 11). Refusals are checked against a fake `/proc`; the signals
 * against real child processes of this test.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, expect, test } from "vitest";
import {
	formatCommandLine,
	isProtected,
	ProcessStopFailure,
	parseStatLine,
	parseStatusUids,
	readProcess,
	stopProcess,
} from "./processes.js";
import { processesRoutes } from "./processes-route.js";

const STUDENT = 1000;
const SELF = 4242;
let fakeProc: string;
const signals: [number, string][] = [];

function stat(pid: number, name: string, state: string, startTicks: number): string {
	// Fields 3 to 22: state, then 18 fillers, then starttime.
	const after = [state, ...Array.from({ length: 18 }, () => "0"), String(startTicks)];
	return `${pid} (${name}) ${after.join(" ")} 0 0\n`;
}

async function fakeProcess(
	pid: number,
	name: string,
	uid: number,
	startTicks: number,
	state = "S",
) {
	const dir = join(fakeProc, String(pid));
	await mkdir(dir, { recursive: true });
	await writeFile(join(dir, "stat"), stat(pid, name, state, startTicks));
	await writeFile(
		join(dir, "status"),
		`Name:\t${name}\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\n`,
	);
}

function fakeOptions() {
	return {
		procRoot: fakeProc,
		selfPid: SELF,
		studentUid: STUDENT,
		kill: (pid: number, signal: string) => {
			signals.push([pid, signal]);
		},
		graceMs: 50,
		pollMs: 10,
	};
}

beforeAll(async () => {
	fakeProc = await mkdtemp(join(tmpdir(), "portikus-proc-"));
	await fakeProcess(1, "systemd", 0, 1);
	await fakeProcess(SELF, "node", STUDENT, 50);
	await fakeProcess(300, "tmux: server", STUDENT, 60);
	await fakeProcess(301, "sshd", 0, 70);
	await fakeProcess(302, "evil (x) y", STUDENT, 80);
	await fakeProcess(303, "defunct", STUDENT, 90, "Z");
	// Real uid is the student's, effective uid is not (a setuid program).
	await mkdir(join(fakeProc, "304"), { recursive: true });
	await writeFile(join(fakeProc, "304", "stat"), stat(304, "su", "S", 95));
	await writeFile(join(fakeProc, "304", "status"), "Name:\tsu\nUid:\t1000\t0\t0\t0\n");
});

afterAll(async () => {
	await rm(fakeProc, { recursive: true, force: true });
});

afterEach(() => {
	signals.length = 0;
});

test("the stat line is read between the first ( and the last )", () => {
	expect(parseStatLine(stat(9, "a) b (c", "R", 1234))).toEqual({
		name: "a) b (c",
		state: "R",
		startTicks: 1234,
	});
	expect(parseStatLine("9 (short) S 1 2")).toBeNull();
	expect(parseStatLine("garbage")).toBeNull();
	expect(parseStatusUids("Name:\tx\nUid:\t1000\t1001\t0\t0\n")).toEqual([1000, 1001]);
	expect(parseStatusUids("Name:\tx\n")).toBeNull();
});

test("PID 1, the agent, tmux servers and anyone else's process are protected", async () => {
	const owner = { selfPid: SELF, studentUid: STUDENT };
	const protectedPids = [1, SELF, 300, 301, 304];
	for (const pid of protectedPids) {
		const facts = await readProcess(fakeProc, pid);
		expect(facts && isProtected(facts, owner), String(pid)).toBe(true);
	}
	const own = await readProcess(fakeProc, 302);
	expect(own && isProtected(own, owner)).toBe(false);
});

test("a refused stop sends no signal", async () => {
	const cases: [number, number, string][] = [
		[1, 1, "PROCESS_PROTECTED"],
		[SELF, 50, "PROCESS_PROTECTED"],
		[300, 60, "PROCESS_PROTECTED"],
		[301, 70, "PROCESS_PROTECTED"],
		[304, 95, "PROCESS_PROTECTED"],
		[302, 81, "PROCESS_CHANGED"],
		[999, 1, "PROCESS_NOT_FOUND"],
	];
	for (const [pid, startTicks, code] of cases) {
		const error = await stopProcess(
			pid,
			{ startTicks, force: true },
			fakeOptions(),
		).catch((caught: unknown) => caught);
		expect(error, String(pid)).toBeInstanceOf(ProcessStopFailure);
		expect((error as ProcessStopFailure).code, String(pid)).toBe(code);
	}
	expect(signals).toEqual([]);
});

test("the start ticks are checked before the signal, not after", async () => {
	// The same PID now belongs to a process that started later.
	await expect(
		stopProcess(302, { startTicks: 79, force: false }, fakeOptions()),
	).rejects.toMatchObject({ code: "PROCESS_CHANGED" });
	expect(signals).toEqual([]);
});

test("a zombie counts as exited", async () => {
	expect(
		await stopProcess(303, { startTicks: 90, force: false }, fakeOptions()),
	).toEqual({
		pid: 303,
		exited: true,
	});
	expect(signals).toEqual([[303, "SIGTERM"]]);
});

test("a process that stays past the grace is not killed on its own", async () => {
	expect(
		await stopProcess(302, { startTicks: 80, force: false }, fakeOptions()),
	).toEqual({
		pid: 302,
		exited: false,
	});
	expect(signals).toEqual([[302, "SIGTERM"]]);
	await stopProcess(302, { startTicks: 80, force: true }, fakeOptions());
	expect(signals).toEqual([
		[302, "SIGTERM"],
		[302, "SIGKILL"],
	]);
});

test("command lines turn NULs into spaces and are capped", () => {
	expect(formatCommandLine("node\0server.js\0--port\x003000\0")).toBe(
		"node server.js --port 3000",
	);
	expect(formatCommandLine("")).toBeNull();
	expect(formatCommandLine(`${"a".repeat(2000)}\0`)).toHaveLength(1024);
});

// --- Real processes ---------------------------------------------------------

const children: ChildProcess[] = [];

afterAll(() => {
	for (const child of children) child.kill("SIGKILL");
});

async function startTicksOf(pid: number): Promise<number> {
	const text = await readFile(`/proc/${pid}/stat`, "utf8");
	const parsed = parseStatLine(text);
	if (!parsed) throw new Error("no stat");
	return parsed.startTicks;
}

function child(script: string): ChildProcess {
	const started = spawn("sh", ["-c", script], { stdio: "ignore" });
	children.push(started);
	return started;
}

function realOptions() {
	return {
		procRoot: "/proc",
		selfPid: process.pid,
		studentUid: process.getuid?.() ?? 0,
		kill: (pid: number, signal: NodeJS.Signals) => process.kill(pid, signal),
		graceMs: 1000,
	};
}

test.skipIf(process.platform !== "linux")(
	"a student's own process is stopped",
	async () => {
		const sleeper = child("exec sleep 60");
		const pid = sleeper.pid as number;
		await new Promise((resolve) => setTimeout(resolve, 50));
		const answer = await stopProcess(
			pid,
			{ startTicks: await startTicksOf(pid), force: false },
			realOptions(),
		);
		expect(answer).toEqual({ pid, exited: true });
	},
);

test.skipIf(process.platform !== "linux")(
	"SIGTERM ignored, exited is false, then force kills it",
	async () => {
		const stubborn = child("trap '' TERM; while :; do sleep 1; done");
		const pid = stubborn.pid as number;
		await new Promise((resolve) => setTimeout(resolve, 100));
		const startTicks = await startTicksOf(pid);
		expect(await stopProcess(pid, { startTicks, force: false }, realOptions())).toEqual(
			{
				pid,
				exited: false,
			},
		);
		expect(await stopProcess(pid, { startTicks, force: true }, realOptions())).toEqual({
			pid,
			exited: true,
		});
	},
);

test.skipIf(process.platform !== "linux")(
	"the agent's own PID is refused",
	async () => {
		await expect(
			stopProcess(
				process.pid,
				{ startTicks: await startTicksOf(process.pid), force: true },
				realOptions(),
			),
		).rejects.toMatchObject({ code: "PROCESS_PROTECTED" });
	},
);

// --- The route ---------------------------------------------------------------

let app: FastifyInstance;

beforeAll(async () => {
	app = Fastify();
	await app.register(processesRoutes, fakeOptions());
});

afterAll(async () => {
	await app.close();
});

function post(pid: string, payload: unknown) {
	return app.inject({
		method: "POST",
		url: `/processes/${pid}/stop`,
		payload: payload as Record<string, unknown>,
	});
}

test("the route answers each refusal with its status", async () => {
	expect((await post("1", { startTicks: 1 })).statusCode).toBe(403);
	expect((await post("302", { startTicks: 1 })).statusCode).toBe(409);
	expect((await post("999", { startTicks: 1 })).statusCode).toBe(404);
	const ok = await post("302", { startTicks: 80, force: true });
	expect(ok.statusCode).toBe(200);
	expect(ok.json()).toEqual({ pid: 302, exited: false });
});

test("a pid that is not a positive integer is a 400", async () => {
	for (const pid of ["0", "-3", "1.5", "abc", "1e3", "99999999999"]) {
		const response = await post(pid, { startTicks: 1 });
		expect(response.statusCode, pid).toBe(400);
		expect(response.json().error.code).toBe("BAD_REQUEST");
	}
	expect((await post("302", {})).statusCode).toBe(400);
	expect((await post("302", { startTicks: -1 })).statusCode).toBe(400);
	expect((await post("302", { startTicks: 1, extra: true })).statusCode).toBe(400);
	expect(signals).toEqual([]);
});
