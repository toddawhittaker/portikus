import { expect, test } from "vitest";
import { ProcessStopRequest, ProcessStopResponse } from "./processes.js";
import { UsageProcess } from "./usage.js";

test("a stop request needs start ticks and takes nothing else", () => {
	expect(ProcessStopRequest.parse({ startTicks: 5 })).toEqual({
		startTicks: 5,
		force: false,
	});
	expect(ProcessStopRequest.safeParse({}).success).toBe(false);
	expect(ProcessStopRequest.safeParse({ startTicks: -1 }).success).toBe(false);
	expect(ProcessStopRequest.safeParse({ startTicks: 1, signal: 9 }).success).toBe(
		false,
	);
});

test("a stop answer carries only the pid and whether it exited", () => {
	expect(ProcessStopResponse.safeParse({ pid: 7, exited: true }).success).toBe(true);
	expect(
		ProcessStopResponse.safeParse({ pid: 7, exited: true, name: "x" }).success,
	).toBe(false);
});

test("a usage row's command line is capped at 1024 characters", () => {
	const row = {
		pid: 7,
		cpuPercent: null,
		residentBytes: 0,
		command: "node",
		startTicks: 1,
		stoppable: true,
		commandLine: "a".repeat(1024),
	};
	expect(UsageProcess.safeParse(row).success).toBe(true);
	expect(
		UsageProcess.safeParse({ ...row, commandLine: "a".repeat(1025) }).success,
	).toBe(false);
});
