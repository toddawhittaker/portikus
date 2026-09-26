/**
 * CPU from two /proc samples, and the usage route that reports it
 * (SPEC.md §18.2, §18.3). The sample and its command names are not logged.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkspaceUsage } from "@portikus/contracts";
import { collectingLogger } from "@portikus/observability/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, expect, test } from "vitest";
import { buildServer } from "./server.js";
import {
	bytesPerSecond,
	cpuPercentBetween,
	diskBytes,
	parseMeminfo,
	parseMountPoints,
	parseNetDev,
	parseProcessStat,
	parseTotalCpu,
	roundPercent,
	statValue,
	UsageSampler,
} from "./usage.js";

const STUDENT = 1000;

test("cpu percent is the change in utime+stime over the change in total CPU time", () => {
	// 10 ticks of a 100-tick interval is 10 percent. Guest time is not part
	// of the total, so the 99s on the cpu line do not dilute it.
	const previousTotal = parseTotalCpu(
		"cpu  1000 0 0 0 0 0 0 0 99 99\ncpu0 1 0 0 0 0 0 0 0\n",
	);
	const nextTotal = parseTotalCpu("cpu  1100 0 0 0 0 0 0 0 99 99\n");
	expect(previousTotal).toBe(1000);
	expect(nextTotal).toBe(1100);

	const previous = parseProcessStat(statLine(7, "node (worker)", 10, 0));
	const next = parseProcessStat(statLine(7, "node (worker)", 15, 5));
	expect(previous).toEqual({ utime: 10, stime: 0 });
	expect(next).toEqual({ utime: 15, stime: 5 });

	expect(
		cpuPercentBetween(
			{ ticks: 10, total: previousTotal ?? 0 },
			{ ticks: 20, total: nextTotal ?? 0 },
		),
	).toBe(10);
	expect(roundPercent(100 / 3)).toBe(33.3);
});

test("cpu percent is zero when a counter did not advance", () => {
	expect(cpuPercentBetween({ ticks: 5, total: 100 }, { ticks: 5, total: 100 })).toBe(0);
	expect(cpuPercentBetween({ ticks: 8, total: 100 }, { ticks: 4, total: 200 })).toBe(0);
	expect(bytesPerSecond(100, 50, 1000)).toBe(0);
	expect(bytesPerSecond(100, 200, 0)).toBeNull();
});

test("memory, disk and network parsers ignore what they should", () => {
	expect(parseMeminfo("MemTotal: 2048 kB\nMemAvailable: 1024 kB\n")).toEqual({
		usedBytes: 1024 * 1024,
		totalBytes: 2048 * 1024,
	});
	expect(diskBytes({ blocks: 10, bfree: 4, bsize: 1024 })).toEqual({
		usedBytes: 6 * 1024,
		totalBytes: 10 * 1024,
	});
	const net = parseNetDev(
		[
			"Inter-|   Receive                                                |  Transmit",
			" face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed",
			"    lo: 99999 0 0 0 0 0 0 0 99999 0 0 0 0 0 0 0",
			"  eth0: 1000 0 0 0 0 0 0 0 2000 0 0 0 0 0 0 0",
			"  eth1: 5 0 0 0 0 0 0 0 7 0 0 0 0 0 0 0",
		].join("\n"),
	);
	expect(net).toEqual({ receive: 1005, transmit: 2007 });
});

test("two samples produce process and workspace CPU from every process", async () => {
	const root = await mkdtemp(join(tmpdir(), "portikus-usage-"));
	let now = 1_700_000_000_000;
	const sampler = new UsageSampler({
		procRoot: root,
		homePath: root,
		now: () => now,
		statfs: async () => ({ blocks: 10, bfree: 4, bsize: 1024 }),
		studentUid: STUDENT,
		selfPid: 4242,
	});
	try {
		await writeSample(root, {
			total: 1000,
			rx: 1000,
			tx: 500,
			loRx: 10,
			processes: [
				{ pid: 7, utime: 10, stime: 0, uid: STUDENT, rssKb: 2048, command: "zzsecret" },
				{ pid: 3, utime: 50, stime: 50, uid: 0, rssKb: 100, command: "systemd" },
			],
		});
		const first = await sampler.read();
		expect(first.cpuPercent).toBeNull();
		expect(first.network.receiveBytesPerSecond).toBeNull();
		expect(first.processes.map((process) => process.pid)).toEqual([3, 7]);
		const student = first.processes.find((process) => process.pid === 7);
		expect(student?.cpuPercent).toBeNull();
		expect(student?.residentBytes).toBe(2048 * 1024);
		expect(first.disk).toEqual({ usedBytes: 6 * 1024, totalBytes: 10 * 1024 });
		expect(first.memory.totalBytes).toBe(4096 * 1024);

		now += 1000;
		await writeSample(root, {
			total: 1100,
			rx: 5000,
			tx: 500,
			// Loopback moved a lot. It must not show up in the rate.
			loRx: 500_000,
			processes: [
				{
					pid: 7,
					utime: 15,
					stime: 5,
					uid: STUDENT,
					rssKb: 2048,
					command: "zzsecret",
					cmdline: "node\0app.js\0",
				},
				{
					pid: 3,
					utime: 80,
					stime: 80,
					uid: 0,
					rssKb: 100,
					command: "systemd",
					cmdline: "/sbin/init\0",
				},
				// New since the previous sample: its whole life is not this interval.
				{ pid: 9, utime: 400, stime: 0, uid: STUDENT, rssKb: 10, command: "fresh" },
			],
		});
		const second = await sampler.read();
		// systemd used 60 of the 100 new ticks, zzsecret 10. The new process
		// has no previous sample, so it does not count yet.
		expect(second.cpuPercent).toBe(70);
		expect(second.processes).toEqual([
			{
				pid: 3,
				cpuPercent: 60,
				residentBytes: 100 * 1024,
				command: "systemd",
				startTicks: 30,
				stoppable: false,
				// Not the student's, so never read.
				commandLine: null,
			},
			{
				pid: 7,
				cpuPercent: 10,
				residentBytes: 2048 * 1024,
				command: "zzsecret",
				startTicks: 70,
				stoppable: true,
				commandLine: "node app.js",
			},
			{
				pid: 9,
				cpuPercent: null,
				residentBytes: 10 * 1024,
				command: "fresh",
				startTicks: 90,
				stoppable: true,
				commandLine: null,
			},
		]);
		expect(second.network).toEqual({
			receiveBytesPerSecond: 4000,
			transmitBytesPerSecond: 0,
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("cgroup memory wins over meminfo when the container has a limit", async () => {
	const root = await mkdtemp(join(tmpdir(), "portikus-usage-cg-"));
	const cgroup = join(root, "cgroup");
	await mkdir(cgroup, { recursive: true });
	await writeFile(join(cgroup, "memory.current"), "4096\n");
	await writeFile(join(cgroup, "memory.max"), "8192\n");
	// Page cache the kernel can drop is not counted (SPEC.md §19.4).
	await writeFile(join(cgroup, "memory.stat"), "active_file 99\ninactive_file 1024\n");
	await writeSample(root, {
		total: 10,
		rx: 0,
		tx: 0,
		loRx: 0,
		processes: [],
	});
	const sampler = new UsageSampler({
		procRoot: root,
		cgroupRoot: cgroup,
		statfs: async () => ({ blocks: 1, bfree: 1, bsize: 1 }),
	});
	try {
		const sample = await sampler.read();
		expect(sample.memory).toEqual({ usedBytes: 3072, totalBytes: 8192 });
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

const TOKEN = "e".repeat(64);
let app: FastifyInstance;
let procRoot: string;
let now = 1_700_000_000_000;
const logs = collectingLogger("debug");

test("GET /usage reports the second sample and does not log the command", async () => {
	procRoot = await mkdtemp(join(tmpdir(), "portikus-usage-route-"));
	const tokenPath = join(procRoot, "agent.token");
	await writeFile(tokenPath, TOKEN);
	await writeSample(procRoot, {
		total: 1000,
		rx: 0,
		tx: 0,
		loRx: 0,
		processes: [
			{
				pid: 7,
				utime: 1,
				stime: 0,
				uid: STUDENT,
				rssKb: 1,
				command: "zzsecret",
				cmdline: "run\0--password=zzline\0",
			},
		],
	});
	app = buildServer({
		tokenPath,
		homeDir: procRoot,
		logger: logs.logger,
		listening: { procRoot, interfaceAddress: null, docker: null, intervalMs: 60_000 },
		usage: {
			procRoot,
			now: () => now,
			statfs: async () => ({ blocks: 2, bfree: 1, bsize: 512 }),
			studentUid: STUDENT,
		},
	});

	const denied = await app.inject({ method: "GET", url: "/usage" });
	expect(denied.statusCode).toBe(401);

	const first = await app.inject({
		method: "GET",
		url: "/usage",
		headers: { authorization: `Bearer ${TOKEN}` },
	});
	expect(first.statusCode).toBe(200);
	expect(WorkspaceUsage.parse(first.json()).cpuPercent).toBeNull();

	now += 1000;
	await writeSample(procRoot, {
		total: 1100,
		rx: 1000,
		tx: 0,
		loRx: 0,
		processes: [
			{
				pid: 7,
				utime: 11,
				stime: 0,
				uid: STUDENT,
				rssKb: 1,
				command: "zzsecret",
				cmdline: "run\0--password=zzline\0",
			},
		],
	});
	const second = await app.inject({
		method: "GET",
		url: "/usage",
		headers: { authorization: `Bearer ${TOKEN}` },
	});
	const body = WorkspaceUsage.parse(second.json());
	expect(body.cpuPercent).toBe(10);
	expect(body.processes[0]?.command).toBe("zzsecret");
	expect(JSON.stringify(logs.lines)).not.toContain("zzsecret");
	// The student sees their own command line; no log line carries it.
	expect(body.processes[0]?.commandLine).toBe("run --password=zzline");
	expect(JSON.stringify(logs.lines)).not.toContain("zzline");
});

test("the stop route is registered behind the agent token", async () => {
	const url = "/processes/7/stop";
	const denied = await app.inject({ method: "POST", url, payload: { startTicks: 70 } });
	expect(denied.statusCode).toBe(401);
	// The fake /proc's pid 7 started at 70 ticks; 71 is someone else.
	const changed = await app.inject({
		method: "POST",
		url,
		headers: { authorization: `Bearer ${TOKEN}` },
		payload: { startTicks: 71 },
	});
	expect(changed.statusCode).toBe(409);
	expect(changed.json().error.code).toBe("PROCESS_CHANGED");
	expect(JSON.stringify(logs.lines)).not.toContain("zzline");
});

afterAll(async () => {
	await app?.close();
	if (procRoot) await rm(procRoot, { recursive: true, force: true });
});

test("mount points come from field five of mountinfo, octal escapes decoded", () => {
	const points = parseMountPoints(
		[
			"36 35 98:0 / / rw,noatime master:1 - ext3 /dev/root rw",
			"40 36 0:33 / /home/my\\040home rw - btrfs /dev/sdb rw",
			"",
		].join("\n"),
	);
	expect([...points]).toEqual(["/", "/home/my home"]);
});

test("storage reports each mounted class from statfs and null for a missing mount", async () => {
	// SPEC.md §18.3, §19.2: three classes. Recovery is not mounted here, as on
	// a workspace that has not restarted since the volume was added.
	const root = await mkdtemp(join(tmpdir(), "portikus-usage-storage-"));
	try {
		await writeSample(root, { total: 1, rx: 0, tx: 0, loRx: 0, processes: [] });
		await mkdir(join(root, "self"));
		await writeFile(
			join(root, "self", "mountinfo"),
			[
				"36 35 98:0 / / rw - ext4 /dev/root rw",
				"40 36 0:33 / /home/student rw - btrfs /dev/a rw",
				"41 36 0:34 / /var/lib/docker rw - btrfs /dev/b rw",
			].join("\n"),
		);
		const sizes: Record<string, { blocks: number; bfree: number; bsize: number }> = {
			"/home/student": { blocks: 100, bfree: 20, bsize: 1024 },
			"/var/lib/docker": { blocks: 50, bfree: 45, bsize: 4096 },
			"/var/lib/portikus/recovery": { blocks: 9, bfree: 9, bsize: 1 },
		};
		const sampler = new UsageSampler({
			procRoot: root,
			homePath: "/home/student",
			statfs: async (path) => {
				const size = sizes[path];
				if (!size) throw new Error("no such path");
				return size;
			},
		});
		const usage = WorkspaceUsage.parse(await sampler.read());
		expect(usage.storage).toEqual({
			home: { usedBytes: 80 * 1024, totalBytes: 100 * 1024 },
			docker: { usedBytes: 5 * 4096, totalBytes: 50 * 4096 },
			recovery: null,
		});

		// Mounted but unreadable is null too, never a zero that looks real.
		await writeFile(
			join(root, "self", "mountinfo"),
			"42 36 0:35 / /var/lib/portikus/recovery rw - btrfs /dev/c rw\n",
		);
		const failing = new UsageSampler({
			procRoot: root,
			homePath: "/home/student",
			recoveryPath: "/var/lib/portikus/recovery",
			statfs: async () => {
				throw new Error("EACCES");
			},
		});
		expect((await failing.read()).storage).toEqual({
			home: null,
			docker: null,
			recovery: null,
		});

		// A mount at the configured recovery path is measured.
		const measured = new UsageSampler({
			procRoot: root,
			homePath: "/home/student",
			statfs: async () => ({ blocks: 3, bfree: 1, bsize: 1024 }),
		});
		expect((await measured.read()).storage.recovery).toEqual({
			usedBytes: 2048,
			totalBytes: 3072,
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

function statLine(pid: number, command: string, utime: number, stime: number): string {
	const after = [
		"S",
		"1",
		"1",
		"1",
		"0",
		"-1",
		"0",
		"0",
		"0",
		"0",
		"0",
		String(utime),
		String(stime),
		// Fields 16 to 21, then field 22: the start ticks.
		"0",
		"0",
		"0",
		"0",
		"0",
		"0",
		String(pid * 10),
	].join(" ");
	return `${pid} (${command}) ${after}\n`;
}

async function writeSample(
	root: string,
	sample: {
		total: number;
		rx: number;
		tx: number;
		loRx: number;
		processes: {
			pid: number;
			utime: number;
			stime: number;
			uid: number;
			rssKb: number;
			command: string;
			cmdline?: string;
		}[];
	},
): Promise<void> {
	await mkdir(join(root, "net"), { recursive: true });
	await writeFile(join(root, "stat"), `cpu  ${sample.total} 0 0 0 0 0 0 0 99 99\n`);
	await writeFile(join(root, "meminfo"), "MemTotal: 4096 kB\nMemAvailable: 1024 kB\n");
	await writeFile(
		join(root, "net", "dev"),
		[
			"Inter-|   Receive                                                |  Transmit",
			" face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed",
			`    lo: ${sample.loRx} 0 0 0 0 0 0 0 1 0 0 0 0 0 0 0`,
			`  eth0: ${sample.rx} 0 0 0 0 0 0 0 ${sample.tx} 0 0 0 0 0 0 0`,
		].join("\n"),
	);
	for (const process of sample.processes) {
		const dir = join(root, String(process.pid));
		await mkdir(dir, { recursive: true });
		await writeFile(
			join(dir, "stat"),
			statLine(process.pid, process.command, process.utime, process.stime),
		);
		await writeFile(
			join(dir, "status"),
			`Name:\t${process.command}\nUid:\t${process.uid}\t${process.uid}\t${process.uid}\t${process.uid}\nVmRSS:\t${process.rssKb} kB\n`,
		);
		await writeFile(join(dir, "cmdline"), process.cmdline ?? "");
	}
}

test("memory.stat counters are read by name, and a missing one is zero", () => {
	expect(statValue("active_file 5\ninactive_file 42\n", "inactive_file")).toBe(42);
	expect(statValue("total_inactive_file 7\n", "total_inactive_file")).toBe(7);
	expect(statValue("anon 1\n", "inactive_file")).toBe(0);
	expect(statValue(null, "inactive_file")).toBe(0);
});
