/**
 * The administrator's process read (ADR 0037; docs/EPIC-21.md rulings 17 and
 * 18). Short names come from student-controlled /proc data, so the parser is
 * tested with hostile names and broken output.
 */
import { InstanceProcess } from "@portikus/contracts";
import { describe, expect, test } from "vitest";
import {
	cleanShortName,
	PROCESS_SNAPSHOT_SCRIPT,
	parseProcessOutput,
	parseStatLine,
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

function output(
	first: Array<[number, number, string, number, number, number]>,
	second: Array<[number, number, string, number, number, number]>,
	agentPid = "300",
): string {
	const records = ["T 100 4096", "U 1000.00"];
	for (const [uid, pid, name, ticks, start, rss] of first) {
		records.push(`P ${uid} ${stat(pid, name, ticks, start, rss)}`);
	}
	records.push("U 1001.00");
	for (const [uid, pid, name, ticks, start, rss] of second) {
		records.push(`P ${uid} ${stat(pid, name, ticks, start, rss)}`);
	}
	records.push(`A ${agentPid}`);
	return `${records.join("\0")}\0`;
}

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
			rssPages: 30,
		});
	});

	test("refuses truncated or malformed lines", () => {
		expect(parseStatLine("")).toBeNull();
		expect(parseStatLine("12 (bash")).toBeNull();
		expect(parseStatLine("12 (bash) R 1 2 3")).toBeNull();
		expect(parseStatLine(stat(12, "x", 1, 2, 3).replace(/^12/, "x1"))).toBeNull();
		expect(
			parseStatLine(stat(12, "x", 1, 2, 3).replace(/ 2 0 3$/, " -2 0 3")),
		).toBeNull();
	});
});

describe("cleanShortName", () => {
	test("replaces control and bidirectional characters and caps at 15", () => {
		expect(cleanShortName("evil\nline\ttab\u001b[31m")).toBe("evil?line?tab?[");
		expect(cleanShortName("a‮b")).toBe("a?b");
		expect(cleanShortName("x".repeat(40))).toHaveLength(15);
	});
});

describe("parseProcessOutput", () => {
	test("computes CPU over the second against the limit, and memory in bytes", () => {
		const rows = parseProcessOutput(
			output([[1000, 500, "burn", 1000, 50, 10]], [[1000, 500, "burn", 1200, 50, 10]]),
			2,
		);
		// 200 ticks of 100 per second, over 1 s, on 2 CPUs.
		expect(rows).toEqual([
			{
				pid: 500,
				uid: 1000,
				name: "burn",
				startTicks: 50,
				cpuPercent: 100,
				residentBytes: 10 * 4096,
				protected: false,
			},
		]);
	});

	test("a reused PID does not borrow the old process's CPU time", () => {
		const rows = parseProcessOutput(
			output([[1000, 500, "old", 5000, 50, 1]], [[1000, 500, "new", 20, 99, 1]]),
			1,
		);
		expect(rows[0]?.cpuPercent).toBe(20);
	});

	test("marks PID 1, other users, the agent and the tmux server protected", () => {
		const second: Array<[number, number, string, number, number, number]> = [
			[0, 1, "systemd", 0, 1, 1],
			[0, 200, "sshd", 0, 1, 1],
			[1000, 300, "node", 0, 1, 1],
			[1000, 400, "tmux: server", 0, 1, 1],
			[1000, 500, "python3", 0, 1, 1],
		];
		const rows = parseProcessOutput(output([], second), 1);
		const protectedPids = rows.filter((r) => r.protected).map((r) => r.pid);
		expect(protectedPids.sort((a, b) => a - b)).toEqual([1, 200, 300, 400]);
		expect(rows.find((r) => r.pid === 500)?.protected).toBe(false);
	});

	test("with no agent PID, only the other rules protect", () => {
		const rows = parseProcessOutput(output([], [[1000, 300, "node", 0, 1, 1]], ""), 1);
		expect(rows[0]?.protected).toBe(false);
	});

	test("keeps the top ten by CPU and by memory, merged", () => {
		const second: Array<[number, number, string, number, number, number]> = [];
		for (let i = 1; i <= 30; i++) {
			// PIDs 1001-1030 rise in CPU, 2001-2030 in memory.
			second.push([1000, 1000 + i, "cpu", i, 1, 1]);
			second.push([1000, 2000 + i, "mem", 0, 1, 1000 + i]);
		}
		const rows = parseProcessOutput(output([], second), 1);
		expect(rows).toHaveLength(20);
		const pids = new Set(rows.map((r) => r.pid));
		for (let i = 21; i <= 30; i++) {
			expect(pids.has(1000 + i)).toBe(true);
			expect(pids.has(2000 + i)).toBe(true);
		}
		expect(rows[0]?.pid).toBe(1030);
	});

	test("hostile names reach the answer only as clean short names", () => {
		const hostile = "x\nP 0 1 (fake) R\u0000";
		const rows = parseProcessOutput(
			`${output([], [[1000, 600, "ok", 0, 1, 1]])}`.replace(
				"(ok)",
				`(${hostile.replace("\u0000", "")})`,
			),
			1,
		);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.name).toBe("x?P 0 1 (fake) ");
		for (const row of rows) expect(InstanceProcess.safeParse(row).success).toBe(true);
	});

	test("skips a record with a bad uid or stat line instead of failing", () => {
		const text = output([], [[1000, 600, "ok", 0, 1, 1]]).replace(
			"U 1001.00\0",
			"U 1001.00\0P root 700 (x) R\0P 1000 garbage\0",
		);
		expect(parseProcessOutput(text, 1).map((r) => r.pid)).toEqual([600]);
	});

	test("throws on incomplete or truncated output", () => {
		expect(() => parseProcessOutput("", 1)).toThrow();
		expect(() => parseProcessOutput("T 100 4096\0U 1.0\0", 1)).toThrow();
		const full = output([[1000, 1, "a", 0, 1, 1]], [[1000, 1, "a", 0, 1, 1]]);
		expect(() => parseProcessOutput(full.replace("T 100 4096", "T x y"), 1)).toThrow();
		expect(() => parseProcessOutput(full.replace("U 1001.00", "U nope"), 1)).toThrow();
	});
});

test("the command is fixed and reads only /proc, uptime, getconf and systemctl", () => {
	expect(PROCESS_SNAPSHOT_SCRIPT).not.toContain("cmdline");
	expect(PROCESS_SNAPSHOT_SCRIPT).not.toContain("environ");
	expect(PROCESS_SNAPSHOT_SCRIPT).toContain("systemctl show -p MainPID");
});
