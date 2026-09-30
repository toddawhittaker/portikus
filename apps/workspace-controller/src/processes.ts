import { readdir, readFile } from "node:fs/promises";
import type { InstanceProcess } from "@portikus/contracts";

/** The student's uid in every workspace image. */
export const STUDENT_UID = 1000;

/** How many rows each ranking keeps; the answer is their union. */
const TOP = 10;

/** More processes or cgroups than any workspace can have are not read. */
const MAX_PIDS = 100_000;
const MAX_CGROUPS = 10_000;

/** Linux reports CPU times in units of USER_HZ, which is 100 on every architecture we run. */
const CLOCK_TICKS = 100;

/** The uid the kernel shows for a host uid outside the instance's map. */
const OVERFLOW_UID = 65534;

/** Units inside the container whose main process no stop may touch (ADR 0037). */
const PROTECTED_UNITS = [
	"system.slice/portikus-workspace-agent.service",
	"system.slice/portikus-terminals.service",
];

const DIGITS = /^\d+$/;

/**
 * The kernel's short name made safe to show: control and format characters
 * (including bidirectional overrides) become `?`, and at most 15 characters
 * are kept. It is the only text from the workspace the admin ever sees.
 */
export function cleanShortName(raw: string): string {
	return Array.from(raw.replace(/[\p{Cc}\p{Cf}]/gu, "?"))
		.slice(0, 15)
		.join("");
}

interface StatFields {
	pid: number;
	name: string;
	ticks: number;
	startTicks: number;
}

/**
 * Parse one `/proc/<pid>/stat` line. The name sits between the first `(`
 * and the last `)`, because a process may put spaces or parentheses in it.
 * Anything malformed gives null.
 */
export function parseStatLine(line: string): StatFields | null {
	const open = line.indexOf("(");
	const close = line.lastIndexOf(")");
	if (open < 1 || close < open) return null;
	const pidText = line.slice(0, open).trim();
	if (!DIGITS.test(pidText)) return null;
	const rest = line
		.slice(close + 1)
		.trim()
		.split(" ");
	// Fields 3 onwards; field 22 (starttime) is rest[19].
	if (rest.length < 20) return null;
	const utime = rest[11] ?? "";
	const stime = rest[12] ?? "";
	const start = rest[19] ?? "";
	if (![utime, stime, start].every((f) => DIGITS.test(f))) return null;
	const pid = Number(pidText);
	if (!Number.isSafeInteger(pid) || pid < 1) return null;
	return {
		pid,
		name: cleanShortName(line.slice(open + 1, close)),
		ticks: Number(utime) + Number(stime),
		startTicks: Number(start),
	};
}

/** One uid range of an instance's idmap, as Incus stores it in `volatile.idmap.current`. */
export interface IdmapEntry {
	Isuid: boolean;
	Hostid: number;
	Nsid: number;
	Maprange: number;
}

/** Parse `volatile.idmap.current`; anything malformed gives an empty map. */
export function parseIdmap(text: string | undefined): IdmapEntry[] {
	try {
		const parsed: unknown = JSON.parse(text ?? "[]");
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(e): e is IdmapEntry =>
				typeof e === "object" &&
				e !== null &&
				e.Isuid === true &&
				[e.Hostid, e.Nsid, e.Maprange].every(Number.isSafeInteger),
		);
	} catch {
		return [];
	}
}

/** A host uid as the workspace sees it, or the overflow uid when unmapped. */
export function mapHostUid(hostUid: number, idmap: IdmapEntry[]): number {
	for (const e of idmap) {
		if (hostUid >= e.Hostid && hostUid < e.Hostid + e.Maprange) {
			return e.Nsid + (hostUid - e.Hostid);
		}
	}
	return OVERFLOW_UID;
}

interface StatusFields {
	nsPids: number[];
	uid: number;
	rssBytes: number;
}

/** The NSpid, real Uid and VmRSS lines of `/proc/<pid>/status`; null when malformed. */
export function parseStatus(text: string): StatusFields | null {
	let nsPids: number[] | null = null;
	let uid: number | null = null;
	let rssBytes = 0;
	for (const line of text.split("\n")) {
		const [key, ...values] = line.split(/\s+/).filter((v) => v !== "");
		if (key === "NSpid:") {
			nsPids = values.every((v) => DIGITS.test(v)) ? values.map(Number) : null;
		} else if (key === "Uid:") {
			uid = DIGITS.test(values[0] ?? "") ? Number(values[0]) : null;
		} else if (key === "VmRSS:" && DIGITS.test(values[0] ?? "")) {
			rssBytes = Number(values[0]) * 1024;
		}
	}
	if (!nsPids || nsPids.length === 0 || uid === null) return null;
	return { nsPids, uid, rssBytes };
}

/**
 * Every process in an instance's cgroup tree, with the cgroup path it sits in
 * relative to the instance's root cgroup. Cgroups that vanish mid-walk are
 * skipped.
 */
export async function readCgroupMembers(root: string): Promise<Map<number, string>> {
	const members = new Map<number, string>();
	const pending = [""];
	let seen = 0;
	while (pending.length > 0) {
		const rel = pending.pop() as string;
		if (++seen > MAX_CGROUPS) throw new Error("instance has too many cgroups");
		const dir = rel === "" ? root : `${root}/${rel}`;
		let entries: Array<{ name: string; isDirectory(): boolean }>;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch (err) {
			if (rel === "") throw err;
			continue;
		}
		const procs = await readFile(`${dir}/cgroup.procs`, "utf8").catch(() => "");
		for (const line of procs.split("\n")) {
			if (!DIGITS.test(line)) continue;
			members.set(Number(line), rel);
			if (members.size > MAX_PIDS) throw new Error("instance has too many processes");
		}
		for (const e of entries) {
			if (e.isDirectory()) pending.push(rel === "" ? e.name : `${rel}/${e.name}`);
		}
	}
	return members;
}

interface HostProcess extends StatFields {
	hostPid: number;
	uid: number;
	rssBytes: number;
	cgroup: string;
}

/** Stat and status for one host PID, or null if it vanished or is malformed. */
async function readHostProcess(
	procRoot: string,
	hostPid: number,
	cgroup: string,
	level: number,
	idmap: IdmapEntry[],
): Promise<HostProcess | null> {
	let statText: string;
	let statusText: string;
	try {
		statText = await readFile(`${procRoot}/${hostPid}/stat`, "utf8");
		statusText = await readFile(`${procRoot}/${hostPid}/status`, "utf8");
	} catch {
		return null;
	}
	const stat = parseStatLine(statText.trim());
	const status = parseStatus(statusText);
	const nsPid = status?.nsPids[level];
	if (!stat || !status || nsPid === undefined || stat.pid !== hostPid) return null;
	return {
		...stat,
		pid: nsPid,
		hostPid,
		uid: mapHostUid(status.uid, idmap),
		rssBytes: status.rssBytes,
		cgroup,
	};
}

interface Sample {
	uptime: number;
	processes: HostProcess[];
}

export interface HostProcessSource {
	/** The host's /proc; tests point it elsewhere. */
	procRoot: string;
	/** The instance's own cgroup directory on the host. */
	cgroupDir: string;
	/** The host PID of the instance's init, from Incus's state. */
	initPid: number;
	idmap: IdmapEntry[];
	cpuLimit: number;
	/** Waits between the two samples; one second in production. */
	wait: () => Promise<void>;
}

async function takeSample(src: HostProcessSource, level: number): Promise<Sample> {
	const uptimeText = await readFile(`${src.procRoot}/uptime`, "utf8");
	const uptime = Number.parseFloat(uptimeText);
	if (!Number.isFinite(uptime)) throw new Error("host uptime is unreadable");
	const members = await readCgroupMembers(src.cgroupDir);
	const processes: HostProcess[] = [];
	for (const [hostPid, cgroup] of members) {
		const p = await readHostProcess(src.procRoot, hostPid, cgroup, level, src.idmap);
		if (p) processes.push(p);
	}
	return { uptime, processes };
}

/** The main process of each protected unit: the oldest process in its cgroup. */
function protectedUnitPids(processes: HostProcess[]): Set<number> {
	const result = new Set<number>();
	for (const unit of PROTECTED_UNITS) {
		let oldest: HostProcess | null = null;
		for (const p of processes) {
			if (p.cgroup !== unit && !p.cgroup.startsWith(`${unit}/`)) continue;
			if (
				!oldest ||
				p.startTicks < oldest.startTicks ||
				(p.startTicks === oldest.startTicks && p.hostPid < oldest.hostPid)
			) {
				oldest = p;
			}
		}
		if (oldest) result.add(oldest.hostPid);
	}
	return result;
}

/**
 * Read an instance's processes from the host (ADR 0037): walk its cgroup
 * tree, read each PID's stat and status twice, `wait` apart, and return CPU
 * over that interval against `cpuLimit` CPUs, resident memory, and the top
 * ten by each, merged. Nothing runs inside the instance.
 */
export async function readInstanceProcesses(
	src: HostProcessSource,
): Promise<InstanceProcess[]> {
	const initStatus = parseStatus(
		await readFile(`${src.procRoot}/${src.initPid}/status`, "utf8"),
	);
	// The workspace's PID namespace is the one where its init is PID 1; nested
	// containers add deeper levels that must not be used.
	const level = (initStatus?.nsPids.length ?? 0) - 1;
	if (!initStatus || level < 1 || initStatus.nsPids[level] !== 1) {
		throw new Error("instance init is not PID 1 in its namespace");
	}
	const first = await takeSample(src, level);
	await src.wait();
	const second = await takeSample(src, level);

	const before = new Map<string, number>();
	for (const p of first.processes) before.set(`${p.hostPid}:${p.startTicks}`, p.ticks);
	const elapsed = second.uptime - first.uptime > 0 ? second.uptime - first.uptime : 1;
	const unitMains = protectedUnitPids(second.processes);

	const rows: InstanceProcess[] = second.processes.map((p) => {
		const used = Math.max(
			0,
			p.ticks - (before.get(`${p.hostPid}:${p.startTicks}`) ?? 0),
		);
		const percent = (used / CLOCK_TICKS / elapsed / src.cpuLimit) * 100;
		return {
			pid: p.pid,
			uid: p.uid,
			name: p.name,
			startTicks: p.startTicks,
			cpuPercent: Math.round(percent * 10) / 10,
			residentBytes: p.rssBytes,
			protected: p.pid === 1 || p.uid !== STUDENT_UID || unitMains.has(p.hostPid),
		};
	});

	const byCpu = [...rows].sort((a, b) => b.cpuPercent - a.cpuPercent).slice(0, TOP);
	const byMemory = [...rows]
		.sort((a, b) => b.residentBytes - a.residentBytes)
		.slice(0, TOP);
	const union = new Map<number, InstanceProcess>();
	for (const row of [...byCpu, ...byMemory]) union.set(row.pid, row);
	return [...union.values()].sort(
		(a, b) => b.cpuPercent - a.cpuPercent || b.residentBytes - a.residentBytes,
	);
}

/**
 * When the oldest process in a unit's cgroup started, read from the host's
 * /proc (issue #887), or null when the cgroup is gone or empty. Nothing is
 * read inside the instance.
 */
export async function readUnitStartTime(
	procRoot: string,
	unitCgroupDir: string,
): Promise<Date | null> {
	let members: Map<number, string>;
	try {
		members = await readCgroupMembers(unitCgroupDir);
	} catch {
		return null;
	}
	let oldest: number | null = null;
	for (const hostPid of members.keys()) {
		const text = await readFile(`${procRoot}/${hostPid}/stat`, "utf8").catch(() => "");
		const stat = parseStatLine(text.trim());
		if (stat && stat.pid === hostPid && (oldest === null || stat.startTicks < oldest)) {
			oldest = stat.startTicks;
		}
	}
	if (oldest === null) return null;
	const procStat = await readFile(`${procRoot}/stat`, "utf8");
	const btime = /^btime (\d+)$/m.exec(procStat)?.[1];
	if (!btime) throw new Error("host boot time is unreadable");
	return new Date((Number(btime) + oldest / CLOCK_TICKS) * 1000);
}
