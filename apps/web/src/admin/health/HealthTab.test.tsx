import type { HealthReport, HealthSeries } from "@portikus/contracts";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderApp, renderWithQuery, stubFetch } from "../../test-utils.js";
import {
	guardRows,
	HealthTab,
	HealthView,
	healthProblems,
	isNearlyFull,
	sampleAge,
	stateRows,
	usedPercent,
} from "./HealthTab.js";

afterEach(() => vi.unstubAllGlobals());

const NOW = Date.parse("2026-09-22T12:00:00.000Z");
const GIB = 1024 ** 3;

const SERIES: HealthSeries = {
	range: "1d",
	bucketSeconds: 900,
	from: "2026-09-21T12:15:00.000Z",
	to: "2026-09-22T12:15:00.000Z",
	cpuCount: 4,
	host: [],
	platform: [],
	events: [],
	usage: { retentionMinutes: 0, from: "2026-09-21T12:15:00.000Z", workspaces: [] },
	api: [],
};

function report(overrides: Partial<HealthReport> = {}): HealthReport {
	return {
		sampledAt: "2026-09-22T11:59:30.000Z",
		workerStale: false,
		packageUpdate: null,
		controller: { reachable: true, errorCode: null },
		host: {
			loadAverage: [0.5, 0.4, 0.3],
			cpuCount: 4,
			memory: { usedBytes: 4 * GIB, totalBytes: 16 * GIB },
			pool: { usedBytes: 50 * GIB, totalBytes: 100 * GIB, metadataPercent: 20.4 },
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

/** Renders a view under a router, since its links lead into other tabs. */
async function renderView(ui: ReactElement) {
	const rootRoute = createRootRoute({ component: () => ui });
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ["/admin/health"] }),
	});
	// biome-ignore lint/suspicious/noExplicitAny: the test router is not the registered one
	const view = render(<RouterProvider router={router as any} />);
	await screen.findByTestId("health");
	return view;
}

/** Renders the whole tab under a router, as the admin page does. */
function renderTab() {
	const rootRoute = createRootRoute({ component: HealthTab });
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ["/admin/health"] }),
	});
	// biome-ignore lint/suspicious/noExplicitAny: the test router is not the registered one
	renderWithQuery(<RouterProvider router={router as any} />);
}

test("sample ages read as plain words", () => {
	expect(sampleAge("2026-09-22T11:59:30.000Z", NOW)).toBe("less than a minute ago");
	expect(sampleAge("2026-09-22T11:57:00.000Z", NOW)).toBe("3 minutes ago");
	expect(sampleAge("2026-09-22T10:00:00.000Z", NOW)).toBe("2 hours ago");
});

test("a healthy report shows the figures and no warnings", async () => {
	await renderView(<HealthView report={report()} now={NOW} />);

	expect(screen.queryByTestId("health-worker-stale")).toBeNull();
	expect(screen.queryByTestId("health-pool-warning")).toBeNull();
	expect(screen.queryByTestId("health-package-update")).toBeNull();
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
	expect(states.getByRole("row", { name: /stopped 5$/i })).toBeDefined();
});

test("a newer package names both versions and the apt command", async () => {
	await renderView(
		<HealthView
			report={report({ packageUpdate: { installed: "0.1.695", available: "0.1.700" } })}
			now={NOW}
		/>,
	);
	const notice = screen.getByTestId("health-package-update");
	expect(notice.textContent).toContain("Portikus 0.1.700 is available");
	expect(notice.textContent).toContain("This server runs 0.1.695");
	expect(notice.querySelector("code")?.textContent).toBe(
		"sudo apt update && sudo apt upgrade",
	);
});

test("the pool at 70 percent or more and memory at 80 or more are flagged", async () => {
	const base = report();
	await renderView(
		<HealthView
			report={report({
				host: base.host && {
					...base.host,
					pool: { usedBytes: 70 * GIB, totalBytes: 100 * GIB, metadataPercent: 5 },
					memory: { usedBytes: 13 * GIB, totalBytes: 16 * GIB },
				},
			})}
			now={NOW}
		/>,
	);

	expect(screen.getByTestId("health-pool-warning").textContent).toBe(
		"Storage pool is over 70% full",
	);
	expect(screen.getByTestId("health-memory-warning").textContent).toBe(
		"Memory is over 80% full",
	);
	expect(screen.getByTestId("health-pool-warning").className).toContain(
		"pk-tag pk-tag--warning",
	);
});

test("metadata use is shown, and warns on its own when it passes 70 percent", async () => {
	const base = report();
	const { unmount } = await renderView(<HealthView report={base} now={NOW} />);
	expect(screen.getByTestId("health-pool-metadata").textContent).toBe("20% used");
	unmount();

	await renderView(
		<HealthView
			report={report({
				host: base.host && {
					...base.host,
					pool: { usedBytes: 10 * GIB, totalBytes: 100 * GIB, metadataPercent: 72 },
				},
			})}
			now={NOW}
		/>,
	);
	expect(screen.getByTestId("health-pool-metadata").textContent).toBe("72% used");
	expect(screen.getByTestId("health-pool-warning").textContent).toBe(
		"Storage pool metadata is over 70% full",
	);
});

test("metadata use the host has not reported reads as such", async () => {
	const base = report();
	await renderView(
		<HealthView
			report={report({
				host: base.host && {
					...base.host,
					pool: { usedBytes: 10 * GIB, totalBytes: 100 * GIB, metadataPercent: null },
				},
			})}
			now={NOW}
		/>,
	);
	expect(screen.getByTestId("health-pool-metadata").textContent).toBe("Not reported");
	expect(screen.queryByTestId("health-pool-warning")).toBeNull();
});

test("a stale worker shows a banner with the sample's age", async () => {
	await renderView(
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
	expect(
		screen
			.getByTestId("health-worker-stale")
			.classList.contains("bg-status-warning-soft"),
	).toBe(true);
});

test("with no sample at all the banner says so", async () => {
	await renderView(
		<HealthView
			report={report({ workerStale: true, sampledAt: null, host: null })}
			now={NOW}
		/>,
	);

	expect(screen.getByTestId("health-worker-stale").textContent).toBe(
		"Worker not reporting. No health sample has been taken yet.",
	);
	expect(screen.getByText("No host figures in the newest sample.")).toBeDefined();
});

test("an unreachable controller shows its error code", async () => {
	await renderView(
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
		if (url.startsWith("/admin/health/series")) return json(200, SERIES);
		throw new Error(`unexpected request: ${url}`);
	});

	renderTab();

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

test("with nothing to act on, the attention list is one all-clear row", async () => {
	await renderView(<HealthView report={report(HEALTHY)} now={NOW} />);
	expect(screen.getByTestId("health-guard-empty").textContent).toContain(
		"All systems healthy",
	);
	expect(screen.queryByTestId("health-guard")).toBeNull();
});

test("a workspace with both a throttle and a flag gets a row for each", () => {
	expect(guardRows([GUARDED]).map((row) => [row.which, row.average])).toEqual([
		["Throttled", "CPU 97% over 30 minutes"],
		["High memory", "Memory 93% over 30 minutes"],
	]);
	expect(guardRows([{ ...GUARDED, memoryFlag: null }])).toHaveLength(1);
});

test("a held throttle shows Held beside Throttled (SPEC.md §19.4)", () => {
	const held = {
		...GUARDED,
		memoryFlag: null,
		cpuThrottle: { ...GUARDED.cpuThrottle, held: { count: 3, hours: 24 } },
	};
	expect(guardRows([held]).map((row) => [row.which, row.held])).toEqual([
		["Throttled", true],
	]);
	expect(guardRows([GUARDED]).map((row) => row.held)).toEqual([false, false]);
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
				secondFactor: null,
			});
		}
		if (url === "/admin/health") return json(200, report({ guard: [GUARDED] }));
		if (url.startsWith("/admin/health/series")) return json(200, SERIES);
		throw new Error(`unexpected request: ${url}`);
	});
	renderApp("/admin/health");

	const table = await screen.findByTestId("health-guard");
	const links = within(table).getAllByRole("link", { name: "Alice Example" });
	expect(links).toHaveLength(2);
	expect(links[0]?.getAttribute("href")).toBe(`/admin/users?user=${OWNER.id}`);
});

test("a failed load is announced", async () => {
	stubFetch(() => json(403, { code: "FORBIDDEN", message: "Administrators only." }));

	renderTab();

	expect((await screen.findByRole("alert")).textContent).toBe("Administrators only.");
});

test("states follow the Workspaces tab's order with zero counts, then newer ones", () => {
	expect(stateRows({ running: 2, stopped: 5, archived: 1 })).toEqual([
		{ state: "provisioning", count: 0 },
		{ state: "starting", count: 0 },
		{ state: "running", count: 2 },
		{ state: "stopping", count: 0 },
		{ state: "stopped", count: 5 },
		{ state: "error", count: 0 },
		{ state: "archived", count: 1 },
	]);
});

test("the tab leads with what needs attention, then the cards, then the trends in four groups", async () => {
	stubFetch((url) => {
		if (url === "/admin/health") return json(200, report());
		if (url.startsWith("/admin/health/series")) return json(200, SERIES);
		if (url.startsWith("/admin/logs/counts"))
			return json(503, { code: "LOGS_UNAVAILABLE", message: "No journal." });
		throw new Error(`unexpected request: ${url}`);
	});

	renderTab();

	await screen.findByTestId("health-trends");
	const outline = screen
		.getAllByRole("heading")
		.map((h) => `${h.tagName} ${h.textContent}`);
	expect(outline).toEqual([
		"H2 Health",
		"H3 At a glance",
		"H4 Needs attention",
		"H4 Failures, last 24 hours",
		"H4 Workspaces by state",
		"H4 Platform",
		"H3 Trends",
		"H4 Host",
		"H4 Workspaces",
		"H4 API",
		"H4 Events",
	]);
	const glance = screen.getByTestId("health-glance");
	expect(glance.querySelectorAll(":scope > section.pk-card")).toHaveLength(2);
});

test("the tab has an intro and help beside the figures that need it", async () => {
	stubFetch((url) => {
		if (url === "/admin/health") return json(200, report());
		if (url.startsWith("/admin/health/series")) return json(200, SERIES);
		if (url.startsWith("/admin/logs/counts"))
			return json(503, { code: "LOGS_UNAVAILABLE", message: "No journal." });
		throw new Error(`unexpected request: ${url}`);
	});

	renderTab();

	await screen.findByTestId("health-trends");
	const intro = screen.getByTestId("intro-admin-health");
	expect(intro.textContent).toContain("Look here first when students report slow");
	expect(
		within(intro)
			.getByRole("link", { name: /More in Help/ })
			.getAttribute("href"),
	).toBe("/admin/help#admin-health");
	for (const label of ["Storage pool", "Pool metadata"]) {
		expect(screen.getByRole("button", { name: `About ${label}` })).toBeDefined();
	}
});

const HEALTHY = {
	agents: { answering: 2, running: 2 },
	last24h: {
		startFailures: 0,
		stopFailures: 0,
		forcedStops: 0,
		provisionFailures: 0,
		controllerOutages: 0,
		signInFailures: 0,
		previewRefusals: 0,
	},
};

test("the verdict says all is healthy only when nothing needs attention", async () => {
	await renderView(<HealthView report={report(HEALTHY)} now={NOW} />);
	expect(screen.getByTestId("health-verdict").textContent).toContain(
		"All systems healthy",
	);
});

test("the verdict names the problems when no workspace is guarded", async () => {
	expect(healthProblems(report()).map((problem) => problem.text)).toEqual([
		"1 workspace agent not answering",
		"10 failures in the last 24 hours",
	]);
	await renderView(<HealthView report={report()} now={NOW} />);
	const verdict = within(screen.getByTestId("health-verdict"));
	expect(verdict.getByRole("heading", { name: "Needs attention" })).toBeDefined();
	const items = verdict.getAllByRole("listitem").map((item) => item.textContent);
	expect(items).toEqual([
		"1 workspace agent not answering" + "Open Users",
		"10 failures in the last 24 hours" + "Open Logs",
	]);
	expect(verdict.getByRole("link", { name: "Open Logs" }).getAttribute("href")).toBe(
		"/admin/logs?level=error%2Cwarn&since=24h",
	);
});
