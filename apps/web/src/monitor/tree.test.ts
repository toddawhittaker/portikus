import { expect, test } from "vitest";
import { childMap, descendantsOf } from "./tree.js";

function row(pid: number, ppid: number) {
	return {
		pid,
		ppid,
		cpuPercent: null,
		residentBytes: 0,
		command: "x",
		startTicks: pid,
		stoppable: true,
		commandLine: null,
	};
}

test("descendants follow parent links at any depth, and stop at a cycle", () => {
	const rows = [row(1, 0), row(7, 1), row(8, 7), row(9, 8), row(10, 1), row(11, 11)];
	const children = childMap(rows);
	expect(
		descendantsOf(7, children)
			.map((one) => one.pid)
			.sort(),
	).toEqual([8, 9]);
	expect(descendantsOf(10, children)).toEqual([]);
	expect(descendantsOf(11, children)).toEqual([]);
});

test("an older agent's rows, all with parent 0, give no process any children", () => {
	const rows = [row(7, 0), row(8, 0)];
	expect(descendantsOf(7, childMap(rows))).toEqual([]);
});
