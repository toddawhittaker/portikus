import type { UsageProcess } from "@portikus/contracts";
import { expect, test } from "vitest";
import { descendantsOf } from "./tree.js";

function row(pid: number, ppid: number, session = 0): UsageProcess {
	return {
		pid,
		ppid,
		session,
		cpuPercent: null,
		residentBytes: 0,
		command: "x",
		startTicks: pid,
		stoppable: true,
		commandLine: null,
	};
}

function pidsUnder(pid: number, rows: UsageProcess[]): number[] {
	const root = rows.find((one) => one.pid === pid) as UsageProcess;
	return descendantsOf(root, rows)
		.map((one) => one.pid)
		.sort((a, b) => a - b);
}

test("descendants follow parent links at any depth, and stop at a cycle", () => {
	const rows = [row(1, 0), row(7, 1), row(8, 7), row(9, 8), row(10, 1), row(11, 11)];
	expect(pidsUnder(7, rows)).toEqual([8, 9]);
	expect(pidsUnder(10, rows)).toEqual([]);
	expect(pidsUnder(11, rows)).toEqual([]);
});

test("an older agent's rows, all with parent 0 and session 0, give no process any children", () => {
	const rows = [row(7, 0), row(8, 0)];
	expect(pidsUnder(7, rows)).toEqual([]);
});

test("a session leader counts its re-parented session members, as the agent's tree does", () => {
	// 7 ran setsid; 8 and 9 were re-parented to PID 1 but stay in session 7.
	const rows = [row(1, 0, 1), row(7, 1, 7), row(8, 1, 7), row(9, 8, 7), row(12, 1, 12)];
	expect(pidsUnder(7, rows)).toEqual([8, 9]);
});

test("a root that does not lead its session gets no session members", () => {
	const rows = [row(5, 1, 5), row(7, 5, 5), row(8, 1, 5)];
	expect(pidsUnder(7, rows)).toEqual([]);
});
