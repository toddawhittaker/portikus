import { expect, test } from "vitest";
import { compareProcesses, keepOrder } from "./sort.js";

const processes = [
	{
		pid: 10,
		cpuPercent: 1,
		residentBytes: 100,
		command: "node10",
		startTicks: 100,
		stoppable: true,
		commandLine: null,
	},
	{
		pid: 2,
		cpuPercent: null,
		residentBytes: 5000,
		command: "node2",
		startTicks: 100,
		stoppable: true,
		commandLine: null,
	},
	{
		pid: 9,
		cpuPercent: 20,
		residentBytes: 200,
		command: "python",
		startTicks: 100,
		stoppable: true,
		commandLine: null,
	},
];

function order(
	column: "pid" | "cpu" | "memory" | "command",
	direction: "ascending" | "descending",
) {
	return [...processes]
		.sort((left, right) => compareProcesses(left, right, { column, direction }))
		.map((process) => process.pid);
}

test("pid and memory sort as numbers, not as text", () => {
	expect(order("pid", "ascending")).toEqual([2, 9, 10]);
	expect(order("pid", "descending")).toEqual([10, 9, 2]);
	expect(order("memory", "ascending")).toEqual([10, 9, 2]);
	expect(order("memory", "descending")).toEqual([2, 9, 10]);
});

test("cpu sorts numerically and a missing sample is less than zero", () => {
	expect(order("cpu", "ascending")).toEqual([2, 10, 9]);
	expect(order("cpu", "descending")).toEqual([9, 10, 2]);
});

test("keepOrder holds known rows in place and puts new ones after", () => {
	const key = (row: { id: string }) => row.id;
	const rows = [{ id: "c" }, { id: "a" }, { id: "d" }];
	expect(keepOrder(rows, ["a", "b", "c"], key).map(key)).toEqual(["a", "c", "d"]);
	expect(keepOrder(rows, [], key).map(key)).toEqual(["c", "a", "d"]);
});
