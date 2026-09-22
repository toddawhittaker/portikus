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
	parseNetDev,
	parseProcessStat,
	parseTotalCpu,
	roundPercent,
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
				{ pid: 7, utime: 15, stime: 5, uid: STUDENT, rssKb: 2048, command: "zzsecret" },
				{ pid: 3, utime: 80, stime: 80, uid: 0, rssKb: 100, command: "systemd" },
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
			},
			{
				pid: 7,
				cpuPercent: 10,
				residentBytes: 2048 * 1024,
				command: "zzsecret",
			},
			{
				pid: 9,
				cpuPercent: null,
				residentBytes: 10 * 1024,
				command: "fresh",
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
		expect(sample.memory).toEqual({ usedBytes: 4096, totalBytes: 8192 });
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
			{ pid: 7, utime: 1, stime: 0, uid: STUDENT, rssKb: 1, command: "zzsecret" },
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
			{ pid: 7, utime: 11, stime: 0, uid: STUDENT, rssKb: 1, command: "zzsecret" },
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
});

afterAll(async () => {
	await app?.close();
	if (procRoot) await rm(procRoot, { recursive: true, force: true });
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
	}
}
