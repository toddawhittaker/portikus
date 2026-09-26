import type { HealthReport } from "@portikus/contracts";
import { render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderApp, renderWithQuery, stubFetch } from "../../test-utils.js";
import {
	guardRows,
	HealthTab,
	HealthView,
	isNearlyFull,
	sampleAge,
	usedPercent,
} from "./HealthTab.js";
import { sparklinePoints } from "./Sparkline.js";

afterEach(() => vi.unstubAllGlobals());

const NOW = Date.parse("2026-09-22T12:00:00.000Z");
const GIB = 1024 ** 3;

function report(overrides: Partial<HealthReport> = {}): HealthReport {
	return {
		sampledAt: "2026-09-22T11:59:30.000Z",
		workerStale: false,
		controller: { reachable: true, errorCode: null },
		host: {
			loadAverage: [0.5, 0.4, 0.3],
			cpuCount: 4,
			memory: { usedBytes: 4 * GIB, totalBytes: 16 * GIB },
			pool: { usedBytes: 50 * GIB, totalBytes: 100 * GIB },
			profileLimits: { cpu: "2", memory: "4GiB", processes: "2000" },
			image: { fingerprint: "abcdef0123456789abcdef", serial: "2026.09.9" },
		},
		workspacesByState: { running: 2, stopped: 5 },
		agents: { answering: 1, running: 2 },
		last24h: {
			startFailures: 3,
			stopFailures: 0,
			forcedStops: 1,
			provisionFailures: 0,
			controllerOutages: 0,
			signInFailures: 4,
			previewRefusals: 2,
		},
		series: [
			{
				at: "2026-09-22T11:30:00.000Z",
				poolUsedBytes: 40 * GIB,
				poolTotalBytes: 100 * GIB,
				memoryUsedBytes: 2 * GIB,
				memoryTotalBytes: 16 * GIB,
				load1: 1,
			},
			{
				at: "2026-09-22T11:45:00.000Z",
				poolUsedBytes: 50 * GIB,
				poolTotalBytes: 100 * GIB,
				memoryUsedBytes: 4 * GIB,
				memoryTotalBytes: 16 * GIB,
				load1: 0.5,
			},
		],
		guard: [],
		...overrides,
	};
}

test("the warning starts at 80 percent", () => {
	expect(isNearlyFull(79, 100)).toBe(false);
	expect(isNearlyFull(80, 100)).toBe(true);
	expect(isNearlyFull(0, 0)).toBe(false);
	expect(usedPercent(1, 3)).toBe(33);
});

test("sample ages read as plain words", () => {
	expect(sampleAge("2026-09-22T11:59:30.000Z", NOW)).toBe("less than a minute ago");
	expect(sampleAge("2026-09-22T11:57:00.000Z", NOW)).toBe("3 minutes ago");
	expect(sampleAge("2026-09-22T10:00:00.000Z", NOW)).toBe("2 hours ago");
});

test("sparkline points span the box and cap at the maximum", () => {
	expect(sparklinePoints([], 100)).toBe("");
	expect(sparklinePoints([0, 50, 200], 100)).toBe("0,40 120,20 240,0");
});

test("a healthy report shows the figures and no warnings", () => {
	render(<HealthView report={report()} now={NOW} />);

	expect(screen.queryByTestId("health-worker-stale")).toBeNull();
	expect(screen.queryByTestId("health-pool-warning")).toBeNull();
	expect(screen.getByTestId("health-pool").textContent).toContain(
		"50.0 GB of 100 GB (50%)",
	);
	expect(screen.getByTestId("health-controller").textContent).toBe("Reachable");
	expect(screen.getByTestId("health-agents").textContent).toBe("1 of 2 running");
	expect(screen.getByTestId("health-image").textContent).toBe(
		"2026.09.9 (abcdef012345)",
	);
	const counts = within(
		screen.getByRole("table", { name: "Failures in the last 24 hours" }),
	);
	expect(counts.getByRole("row", { name: "Start failures 3" })).toBeDefined();
	const states = within(screen.getByRole("table", { name: "Workspaces by state" }));
	expect(states.getByRole("row", { name: "stopped 5" })).toBeDefined();
	// The chart has a text alternative.
	expect(
		screen.getByRole("img", { name: "Storage pool used: Now 50%, highest 50%." }),
	).toBeDefined();
	expect(
		screen.getByRole("img", { name: "Load, 1 minute: Now 0.50, highest 1.00." }),
	).toBeDefined();
});

test("pool and memory at 80 percent or more are flagged", () => {
	const base = report();
	render(
		<HealthView
			report={report({
				host: base.host && {
					...base.host,
					pool: { usedBytes: 85 * GIB, totalBytes: 100 * GIB },
					memory: { usedBytes: 13 * GIB, totalBytes: 16 * GIB },
				},
			})}
			now={NOW}
		/>,
	);

	expect(screen.getByTestId("health-pool-warning").textContent).toBe(
		"Storage pool is over 80% full",
	);
	expect(screen.getByTestId("health-memory-warning").textContent).toBe(
		"Memory is over 80% full",
	);
});

test("a stale worker shows a banner with the sample's age", () => {
	render(
		<HealthView
			report={report({ workerStale: true, sampledAt: "2026-09-22T11:57:00.000Z" })}
			now={NOW}
		/>,
	);

	expect(screen.getByTestId("health-worker-stale").textContent).toBe(
		"Worker not reporting. The last health sample was taken 3 minutes ago.",
	);
	// Only fixed text is live, so a refresh does not re-announce the age.
	expect(screen.getByRole("alert").textContent).toBe("Worker not reporting.");
});

test("with no sample at all the banner says so", () => {
	render(
		<HealthView
			report={report({ workerStale: true, sampledAt: null, host: null, series: [] })}
			now={NOW}
		/>,
	);

	expect(screen.getByTestId("health-worker-stale").textContent).toBe(
		"Worker not reporting. No health sample has been taken yet.",
	);
	expect(screen.getByText("No host figures in the newest sample.")).toBeDefined();
	expect(
		screen.getByRole("img", { name: "Memory used: No samples in the last 24 hours." }),
	).toBeDefined();
});

test("an unreachable controller shows its error code", () => {
	render(
		<HealthView
			report={report({
				controller: { reachable: false, errorCode: "CONTROLLER_UNAVAILABLE" },
				host: null,
			})}
			now={NOW}
		/>,
	);

	expect(screen.getByTestId("health-controller").textContent).toBe(
		"Not reachable (CONTROLLER_UNAVAILABLE)",
	);
});

test("the tab loads the report from the API", async () => {
	stubFetch((url) => {
		if (url === "/admin/health") return json(200, report());
		throw new Error(`unexpected request: ${url}`);
	});

	renderWithQuery(<HealthTab />);

	expect((await screen.findByTestId("health-agents")).textContent).toBe(
		"1 of 2 running",
	);
});

const OWNER = {
	id: "11111111-1111-4111-8111-111111111111",
	displayName: "Alice Example",
};
const GUARDED = {
	workspaceId: "22222222-2222-4222-8222-222222222222",
	owner: OWNER,
	cpuThrottle: {
		at: "2026-09-22T11:00:00.000Z",
		thresholdPercent: 80,
		windowMinutes: 30,
		sharePercent: 25,
		averagePercent: 97.4,
		allowance: "100ms/100ms",
	},
	memoryFlag: {
		at: "2026-09-22T11:10:00.000Z",
		averagePercent: 92.6,
		thresholdPercent: 90,
		windowMinutes: 30,
	},
};

test("the guard list says when nothing is throttled or flagged", () => {
	render(<HealthView report={report()} now={NOW} />);
	expect(screen.getByTestId("health-guard-empty").textContent).toBe(
		"No workspace is throttled or flagged.",
	);
});

test("a workspace with both a throttle and a flag gets a row for each", () => {
	expect(guardRows([GUARDED]).map((row) => [row.which, row.average])).toEqual([
		["Throttled", "CPU 97% over 30 minutes"],
		["High memory", "Memory 93% over 30 minutes"],
	]);
	expect(guardRows([{ ...GUARDED, memoryFlag: null }])).toHaveLength(1);
});

test("each guard row links to the owner's detail panel", async () => {
	stubFetch((url) => {
		if (url === "/auth/me") {
			return json(200, {
				id: "33333333-3333-4333-8333-333333333333",
				email: "carol@example.invalid",
				displayName: "Carol Admin",
				role: "administrator",
				mustChangePassword: false,
				mustAcceptUse: false,
				localPassword: false,
			});
		}
		if (url === "/admin/health") return json(200, report({ guard: [GUARDED] }));
		throw new Error(`unexpected request: ${url}`);
	});
	renderApp("/admin?tab=health");

	const table = await screen.findByTestId("health-guard");
	const links = within(table).getAllByRole("link", { name: "Alice Example" });
	expect(links).toHaveLength(2);
	expect(links[0]?.getAttribute("href")).toBe(`/admin?tab=workspaces&user=${OWNER.id}`);
});

test("a failed load is announced", async () => {
	stubFetch(() => json(403, { code: "FORBIDDEN", message: "Administrators only." }));

	renderWithQuery(<HealthTab />);

	expect((await screen.findByRole("alert")).textContent).toBe("Administrators only.");
});
