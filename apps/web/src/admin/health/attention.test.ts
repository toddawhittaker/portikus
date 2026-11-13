import type { HealthReport } from "@portikus/contracts";
import { expect, test } from "vitest";
import { WARN_AT } from "../../monitor/format.js";
import { attentionOf, MEMORY_WARNING, poolWarning } from "./attention.js";

const GIB = 1024 ** 3;

function report(overrides: Partial<HealthReport> = {}): HealthReport {
	return {
		sampledAt: "2026-09-22T11:59:30.000Z",
		workerStale: false,
		packageUpdate: null,
		controller: { reachable: true, errorCode: null },
		host: null,
		workspacesByState: { running: 1 },
		agents: { answering: 1, running: 1 },
		last24h: {
			startFailures: 0,
			stopFailures: 0,
			forcedStops: 0,
			provisionFailures: 0,
			controllerOutages: 0,
			signInFailures: 0,
			previewRefusals: 0,
		},
		guard: [],
		...overrides,
	};
}

const OWNER = {
	id: "11111111-1111-4111-8111-111111111111",
	displayName: "Diego Santos",
};

const THROTTLED: HealthReport["guard"][number] = {
	workspaceId: "22222222-2222-4222-8222-222222222222",
	owner: OWNER,
	cpuThrottle: {
		at: "2026-09-22T11:40:00.000Z",
		thresholdPercent: 80,
		windowMinutes: 30,
		sharePercent: 25,
		averagePercent: 96,
		allowance: "25ms/100ms",
	},
	memoryFlag: {
		at: "2026-09-22T11:45:00.000Z",
		averagePercent: 91,
		thresholdPercent: 90,
		windowMinutes: 30,
	},
};

test("a healthy report has nothing to look at", () => {
	expect(attentionOf(report())).toEqual({ guard: [], problems: [], count: 0 });
});

test("the count is every row the Needs attention list shows, guard rows and problems alike (SPEC.md section 25.6)", () => {
	const attention = attentionOf(
		report({
			guard: [THROTTLED],
			controller: { reachable: false, errorCode: "ECONNREFUSED" },
			last24h: { ...report().last24h, startFailures: 2 },
		}),
	);
	expect(attention.guard.map((row) => row.which)).toEqual(["Throttled", "High memory"]);
	expect(attention.problems.map((problem) => problem.text)).toEqual([
		"Controller not reachable",
		"2 failures in the last 24 hours",
	]);
	expect(attention.count).toBe(4);
});

test("with no sample the controller is unknown: one Worker not reporting item that opens the worker's logs (SPEC.md section 25.6)", () => {
	const attention = attentionOf(report({ controller: null, sampledAt: null }));
	expect(attention.problems).toEqual([
		{
			text: "Worker not reporting",
			action: "Open Logs",
			tab: "logs",
			search: { service: "worker", since: "24h" },
		},
	]);
	expect(attention.count).toBe(1);
});

test("a sample that says the controller is down still names the controller", () => {
	const attention = attentionOf(
		report({ controller: { reachable: false, errorCode: null } }),
	);
	expect(attention.problems.map((problem) => problem.text)).toEqual([
		"Controller not reachable",
	]);
});

test("a full pool names metadata only when metadata is the fuller of the two", () => {
	expect(
		poolWarning({ usedBytes: 50 * GIB, totalBytes: 100 * GIB, metadataPercent: 95 }),
	).toMatch(/^Storage pool metadata is over/);
	expect(
		poolWarning({ usedBytes: 95 * GIB, totalBytes: 100 * GIB, metadataPercent: 20 }),
	).toMatch(/^Storage pool is over/);
	expect(
		poolWarning({ usedBytes: 10 * GIB, totalBytes: 100 * GIB, metadataPercent: 20 }),
	).toBeNull();
});

test("the memory warning names the share where the meters turn amber", () => {
	expect(MEMORY_WARNING).toBe(`Memory is over ${Math.round(WARN_AT * 100)}% full`);
	const full = attentionOf(
		report({
			host: {
				loadAverage: [0, 0, 0],
				cpuCount: 4,
				memory: { usedBytes: 15 * GIB, totalBytes: 16 * GIB },
				pool: { usedBytes: 1 * GIB, totalBytes: 100 * GIB, metadataPercent: 1 },
				profileLimits: { cpu: null, memory: null, processes: null },
				image: { fingerprint: null, serial: null },
			},
		}),
	);
	expect(full.problems.map((problem) => problem.text)).toEqual([MEMORY_WARNING]);
});
