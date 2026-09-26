import type { InstanceProcess } from "@portikus/contracts";

/**
 * The fixed command the controller runs in an instance, as uid 1000, to read
 * its processes (ADR 0037; docs/EPIC-21.md ruling 17). It takes no input.
 * Records are separated by NUL bytes:
 *   `T <clock ticks per second> <page size>`
 *   `U <uptime seconds>` at the start of each of the two samples
 *   `P <uid> <the /proc/<pid>/stat line>` for each process
 *   `A <the agent's MainPID>`
 * The Uid is read from `status`, whose Name line the kernel escapes, so a
 * process name cannot forge it.
 */
export const PROCESS_SNAPSHOT_SCRIPT = `
snap() {
	read -r up _ < /proc/uptime
	printf 'U %s\\0' "$up"
	for d in /proc/[0-9]*; do
		uid=
		{ while read -r k a _; do
			if [ "$k" = "Uid:" ]; then uid=$a; break; fi
		done < "$d/status"; } 2>/dev/null
		[ -n "$uid" ] || continue
		s=$(cat "$d/stat" 2>/dev/null) || continue
		printf 'P %s %s\\0' "$uid" "$s"
	done
}
printf 'T %s %s\\0' "$(getconf CLK_TCK)" "$(getconf PAGESIZE)"
snap
sleep 1
snap
printf 'A %s\\0' "$(systemctl show -p MainPID --value portikus-workspace-agent.service 2>/dev/null)"
`;

/** The student's uid in every workspace image. */
export const STUDENT_UID = 1000;

/** How many rows each ranking keeps; the answer is their union. */
const TOP = 10;

/** More records than any workspace's process limit allows are not read. */
const MAX_RECORDS = 200_000;

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
	rssPages: number;
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
	// Fields 3 onwards; field 24 (rss) is rest[21].
	if (rest.length < 22) return null;
	const utime = rest[11] ?? "";
	const stime = rest[12] ?? "";
	const start = rest[19] ?? "";
	const rss = rest[21] ?? "";
	if (![utime, stime, start, rss].every((f) => DIGITS.test(f))) return null;
	const pid = Number(pidText);
	if (!Number.isSafeInteger(pid) || pid < 1) return null;
	return {
		pid,
		name: cleanShortName(line.slice(open + 1, close)),
		ticks: Number(utime) + Number(stime),
		startTicks: Number(start),
		rssPages: Number(rss),
	};
}

interface Sample {
	uptime: number;
	processes: Array<StatFields & { uid: number }>;
}

/**
 * Turn the script's output into the administrator's rows: CPU over the
 * sampled second against `cpuLimit` CPUs, resident memory, and the top ten
 * by each, merged. Throws when the output lacks its framing records.
 */
export function parseProcessOutput(
	output: string,
	cpuLimit: number,
): InstanceProcess[] {
	const records = output.split("\0");
	if (records.length > MAX_RECORDS) {
		throw new Error("process output has too many records");
	}
	let clockTicks = 0;
	let pageSize = 0;
	let agentPid: number | null = null;
	const samples: Sample[] = [];
	for (const record of records) {
		const kind = record.slice(0, 2);
		const body = record.slice(2);
		if (kind === "T ") {
			const [tck, page] = body.split(" ");
			if (DIGITS.test(tck ?? "") && DIGITS.test(page ?? "")) {
				clockTicks = Number(tck);
				pageSize = Number(page);
			}
		} else if (kind === "U ") {
			const uptime = Number.parseFloat(body);
			if (!Number.isFinite(uptime)) throw new Error("process output has a bad uptime");
			samples.push({ uptime, processes: [] });
		} else if (kind === "P ") {
			const space = body.indexOf(" ");
			const uidText = body.slice(0, space);
			const stat =
				space > 0 && DIGITS.test(uidText) ? parseStatLine(body.slice(space + 1)) : null;
			const sample = samples.at(-1);
			if (stat && sample) sample.processes.push({ ...stat, uid: Number(uidText) });
		} else if (kind === "A ") {
			const main = body.trim();
			agentPid = DIGITS.test(main) && Number(main) > 0 ? Number(main) : null;
		}
	}
	const [first, second] = samples;
	if (!(clockTicks > 0 && pageSize > 0) || !first || !second || samples.length !== 2) {
		throw new Error("process output is incomplete");
	}

	const before = new Map<string, number>();
	for (const p of first.processes) before.set(`${p.pid}:${p.startTicks}`, p.ticks);
	const elapsed = second.uptime - first.uptime > 0 ? second.uptime - first.uptime : 1;

	const rows: InstanceProcess[] = second.processes.map((p) => {
		const used = Math.max(0, p.ticks - (before.get(`${p.pid}:${p.startTicks}`) ?? 0));
		const percent = (used / clockTicks / elapsed / cpuLimit) * 100;
		return {
			pid: p.pid,
			uid: p.uid,
			name: p.name,
			startTicks: p.startTicks,
			cpuPercent: Math.round(percent * 10) / 10,
			residentBytes: p.rssPages * pageSize,
			protected:
				p.pid === 1 ||
				p.uid !== STUDENT_UID ||
				p.pid === agentPid ||
				p.name === "tmux: server",
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
