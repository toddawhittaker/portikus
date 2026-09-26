import { expect, test } from "vitest";
import { compareProcesses, toggleProcessSort } from "./sort.js";

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
	direction: "asc" | "desc",
) {
	return [...processes]
		.sort((left, right) => compareProcesses(left, right, { column, direction }))
		.map((process) => process.pid);
}

test("pid and memory sort as numbers, not as text", () => {
	expect(order("pid", "asc")).toEqual([2, 9, 10]);
	expect(order("pid", "desc")).toEqual([10, 9, 2]);
	expect(order("memory", "asc")).toEqual([10, 9, 2]);
	expect(order("memory", "desc")).toEqual([2, 9, 10]);
});

test("cpu sorts numerically and a missing sample is less than zero", () => {
	expect(order("cpu", "asc")).toEqual([2, 10, 9]);
	expect(order("cpu", "desc")).toEqual([9, 10, 2]);
});

test("clicking the same column flips direction, and a new column starts ascending", () => {
	const cpu = { column: "cpu" as const, direction: "desc" as const };
	expect(toggleProcessSort(cpu, "cpu")).toEqual({ column: "cpu", direction: "asc" });
	expect(toggleProcessSort(cpu, "pid")).toEqual({ column: "pid", direction: "asc" });
});
