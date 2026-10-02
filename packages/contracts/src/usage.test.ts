import { expect, test } from "vitest";
import { UsageProcess } from "./usage.js";

test("a process row from an older agent still parses", () => {
	const row = UsageProcess.parse({
		pid: 7,
		cpuPercent: 1,
		residentBytes: 4096,
		command: "node",
	});
	expect(row).toMatchObject({ startTicks: 0, stoppable: false, commandLine: null });
});
