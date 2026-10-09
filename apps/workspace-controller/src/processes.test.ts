/**
 * The administrator's process read from the host (ADR 0037; SPEC.md §20.1).
 * Everything under /proc and the cgroup tree that a
 * student can influence is faked here, including hostile names.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { InstanceProcess } from "@portikus/contracts";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	cleanShortName,
	mapHostUid,
	parseIdmap,
	parseStatLine,
	parseStatus,
	readInstanceProcesses,
} from "./processes.js";

/** A stat line with the fields the parser reads; the rest are zeros. */
function stat(
	pid: number,
	name: string,
	ticks: number,
	start: number,
	rss: number,
): string {
	const rest = Array.from({ length: 22 }, () => "0");
	rest[0] = "R";
	rest[11] = String(ticks);
	rest[19] = String(start);
	rest[21] = String(rss);
	return `${pid} (${name}) ${rest.join(" ")}`;
}

const BASE = 1_000_000;
const IDMAP = [{ Isuid: true, Hostid: BASE, Nsid: 0, Maprange: 1_000_000_000 }];
const AGENT = "system.slice/portikus-workspace-agent.service";
const TERMINALS = "system.slice/portikus-terminals.service";

interface FakeProc {
	hostPid: number;
	/** PIDs from the host namespace inward, as in NSpid. */
	nsPids: number[];
	/** The uid inside the workspace; the fake stores it shifted like the kernel. */
	uid: number;
	name: string;
	ticks: number;
	start: number;
	rssKiB: number;
	cgroup: string;
}

let root: string;
let procRoot: string;
let cgroupDir: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "procs-test-"));
	procRoot = path.join(root, "proc");
	cgroupDir = path.join(root, "cgroup", "lxc.payload.p_ws");
	fs.mkdirSync(procRoot, { recursive: true });
	fs.mkdirSync(cgroupDir, { recursive: true });
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function writeTree(procs: FakeProc[], uptime: number): void {
	fs.writeFileSync(path.join(procRoot, "uptime"), `${uptime} 5.00\n`);
	const byCgroup = new Map<string, number[]>();
	for (const p of procs) {
		const dir = path.join(procRoot, String(p.hostPid));
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, "stat"),
			`${stat(p.hostPid, p.name, p.ticks, p.start, 0)}\n`,
		);
		const hostUid = p.uid + BASE;
		fs.writeFileSync(
			path.join(dir, "status"),
			[
				`Name:\t${p.name.replace(/\n/g, "\\n")}`,
				`Uid:\t${hostUid}\t${hostUid}\t${hostUid}\t${hostUid}`,
				`NSpid:\t${p.nsPids.join("\t")}`,
				`VmRSS:\t    ${p.rssKiB} kB`,
				"",
			].join("\n"),
		);
		byCgroup.set(p.cgroup, [...(byCgroup.get(p.cgroup) ?? []), p.hostPid]);
	}
	for (const cg of [...byCgroup.keys(), "", AGENT, TERMINALS]) {
		const dir = cg === "" ? cgroupDir : path.join(cgroupDir, cg);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, "cgroup.procs"),
			(byCgroup.get(cg) ?? []).map((pid) => `${pid}\n`).join(""),
		);
	}
}

function proc(over: Partial<FakeProc> & { hostPid: number; nsPid: number }): FakeProc {
	return {
		nsPids: [over.hostPid, over.nsPid],
		uid: 1000,
		name: "sh",
		ticks: 0,
		start: 100,
		rssKiB: 0,
		cgroup: "user.slice",
		...over,
	};
}

const INIT = proc({
	hostPid: 5000,
	nsPid: 1,
	uid: 0,
	name: "systemd",
	start: 10,
	cgroup: "init.scope",
});

/** Read with `second` written to the fake tree between the two samples. */
function read(first: FakeProc[], second: FakeProc[] = first, cpuLimit = 2) {
	writeTree(first, 1000);
	return readInstanceProcesses({
		procRoot,
		cgroupDir,
		initPid: INIT.hostPid,
		idmap: IDMAP,
		cpuLimit,
		wait: async () => {
			fs.rmSync(procRoot, { recursive: true, force: true });
			fs.rmSync(cgroupDir, { recursive: true, force: true });
			fs.mkdirSync(procRoot, { recursive: true });
			writeTree(second, 1001);
		},
	});
}

const row = (rows: InstanceProcess[], pid: number) => rows.find((r) => r.pid === pid);

describe("parseStatLine", () => {
	test("reads the name between the first ( and the last )", () => {
		const parsed = parseStatLine(stat(42, "a) (b c) R 9", 5, 77, 3));
		expect(parsed).toMatchObject({
			pid: 42,
			name: "a) (b c) R 9",
			ticks: 5,
			startTicks: 77,
		});
	});

	test("reads fields after a name made of spaces and parentheses", () => {
		expect(parseStatLine(stat(7, ") ) )", 10, 20, 30))).toMatchObject({
			ticks: 10,
			startTicks: 20,
		});
	});

	test("refuses truncated or malformed lines", () => {
		expect(parseStatLine("")).toBeNull();
		expect(parseStatLine("12 (bash")).toBeNull();
		expect(parseStatLine("12 (bash) R 1 2 3")).toBeNull();
		expect(parseStatLine(stat(12, "x", 1, 2, 3).replace(/^12/, "x1"))).toBeNull();
		expect(parseStatLine(stat(12, "x", 1, -2, 3))).toBeNull();
	});
});

describe("cleanShortName", () => {
	test("replaces control and bidirectional characters and caps at 15", () => {
		expect(cleanShortName("evil\nline\ttab\u001b[31m")).toBe("evil?line?tab?[");
		expect(cleanShortName("a‮b")).toBe("a?b");
		expect(cleanShortName("x".repeat(40))).toHaveLength(15);
	});
});

describe("parseStatus and the idmap", () => {
	test("reads NSpid, the real uid and resident memory", () => {
		expect(
			parseStatus("Name:\tx\nUid:\t1001000\t0\t0\t0\nNSpid:\t77\t12\nVmRSS:\t 8 kB\n"),
		).toEqual({ nsPids: [77, 12], uid: 1_001_000, rssBytes: 8192 });
		expect(parseStatus("Uid:\t1\n")).toBeNull();
		expect(parseStatus("NSpid:\t1 x\nUid:\t1\n")).toBeNull();
	});

	test("maps host uids back into the workspace and flags unmapped ones", () => {
		const idmap = parseIdmap(
			JSON.stringify([
				{ Isuid: true, Isgid: false, Hostid: BASE, Nsid: 0, Maprange: 65536 },
				{ Isuid: false, Isgid: true, Hostid: 5, Nsid: 0, Maprange: 1 },
			]),
		);
		expect(idmap).toHaveLength(1);
		expect(mapHostUid(BASE + 1000, idmap)).toBe(1000);
		expect(mapHostUid(1000, idmap)).toBe(65534);
		expect(parseIdmap("not json")).toEqual([]);
		expect(parseIdmap(undefined)).toEqual([]);
	});
});

describe("readInstanceProcesses", () => {
	test("reports workspace PIDs, mapped uids, CPU over the second and memory", async () => {
		const burn = proc({
			hostPid: 6001,
			nsPid: 500,
			name: "burn",
			ticks: 1000,
			rssKiB: 10,
		});
		const rows = await read([INIT, burn], [INIT, { ...burn, ticks: 1200 }]);
		expect(row(rows, 500)).toEqual({
			pid: 500,
			uid: 1000,
			name: "burn",
			startTicks: 100,
			// 200 ticks over one second on two CPUs.
			cpuPercent: 100,
			residentBytes: 10 * 1024,
			protected: false,
		});
		expect(() => InstanceProcess.array().parse(rows)).not.toThrow();
	});

	test("uses the workspace's PID level, not a nested container's", async () => {
		const nested = proc({
			hostPid: 6002,
			nsPid: 0,
			nsPids: [6002, 700, 1],
			name: "node",
		});
		const rows = await read([INIT, nested]);
		expect(row(rows, 700)).toBeDefined();
		expect(row(rows, 1)?.name).toBe("systemd");
	});

	test("cleans hostile names", async () => {
		const evil = proc({
			hostPid: 6003,
			nsPid: 30,
			name: "a) (b\u202e\u001b[31mlong-long-name",
		});
		const rows = await read([INIT, evil]);
		expect(row(rows, 30)?.name).toBe("a) (b??[31mlong");
	});

	test("protects only PID 1 and other uids; a student program in a platform unit is not (the agent says which are)", async () => {
		const agent = proc({
			hostPid: 6010,
			nsPid: 90,
			name: "node",
			start: 20,
			cgroup: AGENT,
		});
		const agentChild = proc({
			hostPid: 6011,
			nsPid: 91,
			name: "bash",
			start: 40,
			cgroup: AGENT,
		});
		const tmux = proc({
			hostPid: 6012,
			nsPid: 92,
			name: "tmux: server",
			start: 30,
			cgroup: TERMINALS,
		});
		const shell = proc({
			hostPid: 6013,
			nsPid: 93,
			name: "bash",
			start: 50,
			cgroup: `${TERMINALS}/sub`,
		});
		const fakeTmux = proc({ hostPid: 6014, nsPid: 94, name: "tmux: server", start: 5 });
		const rootOwned = proc({ hostPid: 6015, nsPid: 95, uid: 0, name: "cron" });
		const rows = await read([
			INIT,
			agent,
			agentChild,
			tmux,
			shell,
			fakeTmux,
			rootOwned,
		]);
		const prot = Object.fromEntries(rows.map((r) => [r.pid, r.protected]));
		expect(prot).toEqual({
			1: true,
			90: false,
			91: false,
			92: false,
			93: false,
			94: false,
			95: true,
		});
	});

	test("skips processes that vanish or turn malformed between reads", async () => {
		const gone = proc({ hostPid: 6020, nsPid: 20 });
		const stays = proc({ hostPid: 6021, nsPid: 21 });
		writeTree([INIT, gone, stays], 1000);
		const rows = await readInstanceProcesses({
			procRoot,
			cgroupDir,
			initPid: INIT.hostPid,
			idmap: IDMAP,
			cpuLimit: 1,
			wait: async () => {
				// Still listed in cgroup.procs but its /proc entry is gone.
				fs.rmSync(path.join(procRoot, "6020"), { recursive: true });
				fs.writeFileSync(path.join(procRoot, "6021", "status"), "garbage");
				fs.writeFileSync(path.join(procRoot, "uptime"), "1001 0\n");
			},
		});
		expect(rows.map((r) => r.pid)).toEqual([1]);
	});

	test("fails when the init PID is not PID 1 of a child namespace", async () => {
		writeTree([{ ...INIT, nsPids: [5000] }], 1000);
		await expect(
			readInstanceProcesses({
				procRoot,
				cgroupDir,
				initPid: INIT.hostPid,
				idmap: IDMAP,
				cpuLimit: 1,
				wait: async () => {},
			}),
		).rejects.toThrow(/PID 1/);
	});

	// A read nobody waits for stops instead of walking the rest (ADR 0034).
	test("an abort stops the walk before the next cgroup or process", async () => {
		writeTree([INIT, proc({ hostPid: 6030, nsPid: 30 })], 1000);
		const ac = new AbortController();
		const reason = new Error("caller left");
		let waits = 0;
		await expect(
			readInstanceProcesses({
				procRoot,
				cgroupDir,
				initPid: INIT.hostPid,
				idmap: IDMAP,
				cpuLimit: 1,
				wait: async () => {
					waits++;
					ac.abort(reason);
				},
				signal: ac.signal,
			}),
		).rejects.toBe(reason);
		expect(waits).toBe(1);

		await expect(
			readInstanceProcesses({
				procRoot,
				cgroupDir,
				initPid: INIT.hostPid,
				idmap: IDMAP,
				cpuLimit: 1,
				wait: async () => {
					waits++;
				},
				signal: ac.signal,
			}),
		).rejects.toBe(reason);
		expect(waits).toBe(1);
	});

	test("keeps the union of the top ten by CPU and by memory", async () => {
		const many = Array.from({ length: 30 }, (_, i) =>
			proc({
				hostPid: 7000 + i,
				nsPid: 100 + i,
				rssKiB: i < 5 ? 1000 + i : 1,
				ticks: 0,
			}),
		);
		const later = many.map((p, i) => ({ ...p, ticks: i >= 25 ? 50 + i : 0 }));
		const rows = await read([INIT, ...many], [INIT, ...later]);
		const pids = new Set(rows.map((r) => r.pid));
		for (let i = 25; i < 30; i++) expect(pids.has(100 + i)).toBe(true);
		for (let i = 0; i < 5; i++) expect(pids.has(100 + i)).toBe(true);
		expect(rows.length).toBeLessThanOrEqual(20);
	});
});
