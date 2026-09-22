/**
 * Workspace usage (SPEC.md §18.2, §18.3).
 *
 * Process CPU is the change in utime+stime divided by the change in total
 * CPU time, from two samples of `/proc/<pid>/stat` and `/proc/stat`. The
 * first sample has no rate. Network rates are the same idea on `/proc/net/dev`,
 * loopback left out. Nothing here is logged: the short command is a name,
 * not a command line (STACK.md §15).
 */
import { readdir, readFile, statfs } from "node:fs/promises";
import { join } from "node:path";
import type { UsageProcess, WorkspaceUsage } from "@portikus/contracts";

/** The short name `/proc` allows. Longer text is not a comm. */
const COMM_LIMIT = 15;

/** A cgroup limit above this is "no limit", not a real quota. */
const UNLIMITED_BYTES = 2 ** 50;

/** Where a sample's clock and `/proc` live. Tests point these at fixtures. */
export interface UsageSamplerOptions {
	/** Defaults to `/proc`. Set in tests so the host is never read. */
	procRoot?: string;
	/** The student's home. Its filesystem is the disk figure. */
	homePath?: string;
	/**
	 * Cgroup directory with `memory.current`, or null to skip it. Unset in
	 * production tries `/sys/fs/cgroup`; unset beside a fake procRoot skips
	 * it, so a test cannot pick up the host.
	 */
	cgroupRoot?: string | null;
	now?: () => number;
	statfs?: (path: string) => Promise<DiskStat>;
}

export interface DiskStat {
	blocks: number;
	bfree: number;
	bsize: number;
}

export interface CpuSample {
	/** utime + stime, in the same ticks as `total`. */
	ticks: number;
	/** Sum of the aggregate `cpu` line, guest time excluded. */
	total: number;
}

/**
 * Percent of total CPU time used between two samples.
 * Zero when a counter went backwards or time did not advance.
 */
export function cpuPercentBetween(previous: CpuSample, next: CpuSample): number {
	const used = next.ticks - previous.ticks;
	const total = next.total - previous.total;
	if (!(total > 0) || !(used > 0)) return 0;
	return (100 * used) / total;
}

/** One decimal, so the wire value is stable. */
export function roundPercent(value: number): number {
	return Math.round(value * 10) / 10;
}

/**
 * Bytes per second between two counters. Null when the clock did not move.
 * A counter that went backwards (a reset) is zero for this interval.
 */
export function bytesPerSecond(
	previous: number,
	next: number,
	elapsedMs: number,
): number | null {
	if (!(elapsedMs > 0)) return null;
	const delta = next - previous;
	if (delta <= 0) return 0;
	return Math.round(delta / (elapsedMs / 1000));
}

/**
 * Total CPU time from the aggregate `cpu` line. Guest and guest_nice are
 * already inside user and nice, so they are not added again.
 */
export function parseTotalCpu(text: string): number | null {
	const line = text.split("\n").find((entry) => entry.startsWith("cpu "));
	if (!line) return null;
	const fields = line.trim().split(/\s+/).slice(1, 9).map(Number);
	if (fields.length < 8 || fields.some((value) => !Number.isFinite(value))) return null;
	return fields.reduce((sum, value) => sum + value, 0);
}

/**
 * utime and stime from `/proc/<pid>/stat`. The command field is in
 * parentheses and may itself contain spaces and parentheses, so the fields
 * are counted from the last `)`.
 */
export function parseProcessStat(
	text: string,
): { utime: number; stime: number } | null {
	const end = text.lastIndexOf(")");
	if (end < 0) return null;
	const fields = text
		.slice(end + 1)
		.trim()
		.split(/\s+/);
	// utime is field 14 and stime field 15, which are indexes 11 and 12
	// of what follows the command.
	const utime = Number(fields[11]);
	const stime = Number(fields[12]);
	if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
	return { utime, stime };
}

export function parseStatus(
	text: string,
): { residentBytes: number; command: string } | null {
	let command: string | null = null;
	let residentKb = 0;
	for (const line of text.split("\n")) {
		if (line.startsWith("Name:")) {
			command = line.slice("Name:".length).trim();
		} else if (line.startsWith("VmRSS:")) {
			const parsed = Number(line.trim().split(/\s+/)[1]);
			if (Number.isFinite(parsed) && parsed >= 0) residentKb = parsed;
		}
	}
	if (!command) return null;
	const short = command.slice(0, COMM_LIMIT);
	return {
		residentBytes: Math.round(residentKb * 1024),
		command: short === "" ? "unknown" : short,
	};
}

/** MemTotal and MemAvailable, in bytes. MemFree stands in when Available is absent. */
export function parseMeminfo(
	text: string,
): { usedBytes: number; totalBytes: number } | null {
	let totalKb: number | null = null;
	let availableKb: number | null = null;
	let freeKb: number | null = null;
	for (const line of text.split("\n")) {
		const split = line.indexOf(":");
		if (split <= 0) continue;
		const key = line.slice(0, split);
		const value = Number(
			line
				.slice(split + 1)
				.trim()
				.split(/\s+/)[0],
		);
		if (!Number.isFinite(value)) continue;
		if (key === "MemTotal") totalKb = value;
		else if (key === "MemAvailable") availableKb = value;
		else if (key === "MemFree") freeKb = value;
	}
	if (totalKb === null) return null;
	const available = availableKb ?? freeKb ?? 0;
	const totalBytes = Math.round(totalKb * 1024);
	const usedBytes = Math.max(0, totalBytes - Math.round(available * 1024));
	return { usedBytes, totalBytes };
}

/** Receive and transmit bytes, every interface except loopback. */
export function parseNetDev(text: string): { receive: number; transmit: number } {
	let receive = 0;
	let transmit = 0;
	for (const line of text.split("\n")) {
		const colon = line.indexOf(":");
		if (colon < 0) continue;
		const name = line.slice(0, colon).trim();
		if (name === "" || name === "lo") continue;
		const fields = line
			.slice(colon + 1)
			.trim()
			.split(/\s+/)
			.map(Number);
		const rx = fields[0];
		const tx = fields[8];
		if (typeof rx === "number" && Number.isFinite(rx) && rx > 0) receive += rx;
		if (typeof tx === "number" && Number.isFinite(tx) && tx > 0) transmit += tx;
	}
	return { receive, transmit };
}

export function diskBytes(stat: DiskStat): { usedBytes: number; totalBytes: number } {
	const block = stat.bsize > 0 ? stat.bsize : 0;
	const totalBytes = whole(stat.blocks * block);
	const freeBytes = whole(stat.bfree * block);
	return { totalBytes, usedBytes: Math.max(0, totalBytes - freeBytes) };
}

interface ProcessSnap {
	ticks: number;
	residentBytes: number;
	command: string;
}

interface Sample {
	at: number;
	total: number | null;
	processes: Map<number, number>;
	net: { receive: number; transmit: number } | null;
}

/** Reads one usage sample, remembering the previous one for the rates. */
export class UsageSampler {
	private readonly procRoot: string;
	private readonly homePath: string;
	private readonly cgroupRoot: string | null;
	private readonly now: () => number;
	private readonly readDisk: (path: string) => Promise<DiskStat>;
	private previous: Sample | null = null;
	private tail: Promise<void> = Promise.resolve();

	constructor(options: UsageSamplerOptions = {}) {
		this.procRoot = options.procRoot ?? "/proc";
		this.homePath = options.homePath ?? "/home/student";
		this.now = options.now ?? Date.now;
		this.readDisk = options.statfs ?? readDisk;
		if (options.cgroupRoot === null) this.cgroupRoot = null;
		else if (typeof options.cgroupRoot === "string")
			this.cgroupRoot = options.cgroupRoot;
		else this.cgroupRoot = options.procRoot === undefined ? "/sys/fs/cgroup" : null;
	}

	/** One sample. Overlapping calls run one after another so the delta is real. */
	read(): Promise<WorkspaceUsage> {
		const run = this.tail.then(() => this.readOnce());
		this.tail = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}

	private async readOnce(): Promise<WorkspaceUsage> {
		const at = this.now();
		const [total, processes, memory, disk, net] = await Promise.all([
			this.totalCpu(),
			this.processes(),
			this.memory(),
			this.disk(),
			this.network(),
		]);
		const previous = this.previous;
		const rows: UsageProcess[] = [];
		let usedTicks = 0;
		let compared = false;
		for (const [pid, process] of processes) {
			// /proc here is the workspace container, so the list is this
			// student's, including Docker. The selected Running row looks a
			// pid up in the same list.
			const earlier = previous?.processes.get(pid);
			let cpuPercent: number | null = null;
			if (previous?.total != null && total != null && earlier !== undefined) {
				compared = true;
				const delta = process.ticks - earlier;
				if (delta > 0) usedTicks += delta;
				cpuPercent = roundPercent(
					cpuPercentBetween(
						{ ticks: earlier, total: previous.total },
						{ ticks: process.ticks, total },
					),
				);
			}
			rows.push({
				pid,
				cpuPercent,
				residentBytes: process.residentBytes,
				command: process.command,
			});
		}
		rows.sort((left, right) => left.pid - right.pid);

		let cpuPercent: number | null = null;
		if (compared && previous?.total != null && total != null) {
			cpuPercent = roundPercent(
				cpuPercentBetween(
					{ ticks: 0, total: previous.total },
					{ ticks: usedTicks, total },
				),
			);
		}

		const elapsed = previous ? at - previous.at : 0;
		const network = {
			receiveBytesPerSecond:
				previous?.net && net
					? bytesPerSecond(previous.net.receive, net.receive, elapsed)
					: null,
			transmitBytesPerSecond:
				previous?.net && net
					? bytesPerSecond(previous.net.transmit, net.transmit, elapsed)
					: null,
		};

		this.previous = {
			at,
			total: total ?? previous?.total ?? null,
			processes: new Map([...processes].map(([pid, process]) => [pid, process.ticks])),
			net: net ?? previous?.net ?? null,
		};

		return {
			observedAt: new Date(at).toISOString(),
			cpuPercent,
			memory,
			disk,
			network,
			processes: rows,
		};
	}

	private async totalCpu(): Promise<number | null> {
		const text = await readText(join(this.procRoot, "stat"));
		return text === null ? null : parseTotalCpu(text);
	}

	private async processes(): Promise<Map<number, ProcessSnap>> {
		const found = new Map<number, ProcessSnap>();
		let names: string[];
		try {
			names = await readdir(this.procRoot);
		} catch {
			return found;
		}
		await Promise.all(
			names.map(async (name) => {
				if (!/^[1-9]\d*$/.test(name)) return;
				const pid = Number(name);
				const [statText, statusText] = await Promise.all([
					readText(join(this.procRoot, name, "stat")),
					readText(join(this.procRoot, name, "status")),
				]);
				if (statText === null || statusText === null) return;
				const stat = parseProcessStat(statText);
				const status = parseStatus(statusText);
				if (!stat || !status) return;
				found.set(pid, {
					ticks: stat.utime + stat.stime,
					residentBytes: status.residentBytes,
					command: status.command,
				});
			}),
		);
		return found;
	}

	private async memory(): Promise<{ usedBytes: number; totalBytes: number }> {
		const cgroup = await this.cgroupMemory();
		if (cgroup) return cgroup;
		const text = await readText(join(this.procRoot, "meminfo"));
		return text === null
			? { usedBytes: 0, totalBytes: 0 }
			: (parseMeminfo(text) ?? { usedBytes: 0, totalBytes: 0 });
	}

	/** Cgroup memory, when the container has a limit. Otherwise null. */
	private async cgroupMemory(): Promise<{
		usedBytes: number;
		totalBytes: number;
	} | null> {
		if (!this.cgroupRoot) return null;
		const current = parseByteFile(
			await readText(join(this.cgroupRoot, "memory.current")),
		);
		const maxText = await readText(join(this.cgroupRoot, "memory.max"));
		if (current !== null && maxText !== null && maxText.trim() !== "max") {
			const total = parseByteFile(maxText);
			if (total !== null && total > 0 && total < UNLIMITED_BYTES) {
				return { usedBytes: current, totalBytes: total };
			}
		}
		const usage = parseByteFile(
			await readText(join(this.cgroupRoot, "memory.usage_in_bytes")),
		);
		const limit = parseByteFile(
			await readText(join(this.cgroupRoot, "memory.limit_in_bytes")),
		);
		if (usage !== null && limit !== null && limit > 0 && limit < UNLIMITED_BYTES) {
			return { usedBytes: usage, totalBytes: limit };
		}
		return null;
	}

	private async disk(): Promise<{ usedBytes: number; totalBytes: number }> {
		try {
			return diskBytes(await this.readDisk(this.homePath));
		} catch {
			return { usedBytes: 0, totalBytes: 0 };
		}
	}

	private async network(): Promise<{ receive: number; transmit: number } | null> {
		const text = await readText(join(this.procRoot, "net", "dev"));
		return text === null ? null : parseNetDev(text);
	}
}

async function readText(path: string): Promise<string | null> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return null;
	}
}

function parseByteFile(text: string | null): number | null {
	if (text === null) return null;
	const value = Number(text.trim());
	if (!Number.isFinite(value) || value < 0) return null;
	return Math.round(value);
}

function whole(value: number): number {
	if (!Number.isFinite(value) || value <= 0) return 0;
	return Math.round(value);
}

async function readDisk(path: string): Promise<DiskStat> {
	const stat = await statfs(path);
	return {
		blocks: Number(stat.blocks),
		bfree: Number(stat.bfree),
		bsize: Number(stat.bsize),
	};
}
