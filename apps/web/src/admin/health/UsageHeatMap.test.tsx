import type { HealthSeries } from "@portikus/contracts";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { fireEvent, screen, within } from "@testing-library/react";
import { expect, test } from "vitest";
import { renderWithQuery } from "../../test-utils.js";
import type { ChartFrame } from "./charts/scales.js";
import { cellText, stepClass, UsageHeatMap } from "./UsageHeatMap.js";

const FROM = Date.parse("2026-09-26T12:00:00.000Z");
const OWNER = "00000000-0000-4000-8000-000000000001";
const WS = "00000000-0000-4000-8000-0000000000a1";

function frame(
	range: HealthSeries["range"],
	bucketSeconds: number,
	count: number,
): ChartFrame {
	return { range, from: FROM, bucketSeconds, count };
}

function at(frameValue: ChartFrame, index: number): string {
	return new Date(
		frameValue.from + index * frameValue.bucketSeconds * 1000,
	).toISOString();
}

function body(
	f: ChartFrame,
	workspaces: HealthSeries["usage"]["workspaces"],
	usageFrom = new Date(f.from).toISOString(),
): HealthSeries {
	return {
		range: f.range,
		bucketSeconds: f.bucketSeconds,
		from: new Date(f.from).toISOString(),
		to: new Date(f.from + f.count * f.bucketSeconds * 1000).toISOString(),
		cpuCount: 4,
		host: [],
		platform: [],
		events: [],
		usage: { retentionMinutes: 245, from: usageFrom, workspaces },
		api: [],
	};
}

function renderMap(series: HealthSeries, f: ChartFrame) {
	const rootRoute = createRootRoute({
		component: () => <UsageHeatMap series={series} frame={f} />,
	});
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ["/admin?tab=health"] }),
	});
	// biome-ignore lint/suspicious/noExplicitAny: the test router is not the registered one
	renderWithQuery(<RouterProvider router={router as any} />);
}

function row(f: ChartFrame): HealthSeries["usage"]["workspaces"][number] {
	return {
		workspaceId: WS,
		owner: { id: OWNER, displayName: "Ann Lee" },
		cpuThresholdPercent: 80,
		memoryThresholdPercent: 90,
		cells: [
			{ at: at(f, 0), cpuPercent: 12, memoryPercent: 40 },
			{ at: at(f, 2), cpuPercent: 85, memoryPercent: 50 },
		],
	};
}

test("shades step by quarter and cell text names the threshold", () => {
	expect(stepClass(0)).toBe("bg-accent/10");
	expect(stepClass(30)).toBe("bg-accent/30");
	expect(stepClass(60)).toBe("bg-accent/55");
	expect(stepClass(99)).toBe("bg-accent/80");
	expect(stepClass(140)).toBe("bg-accent/80");
	expect(cellText(null, 80)).toBe("no data");
	expect(cellText(42.4, 80)).toBe("42%");
	expect(cellText(80, 80)).toBe("80%, at or over the 80% threshold");
});

test("a table row per workspace reads each bucket, hatches the threshold and links the owner", async () => {
	const f = frame("1h", 60, 4);
	renderMap(body(f, [row(f)]), f);

	const table = await screen.findByRole("table", {
		name: "Per-workspace CPU, highest per minute",
	});
	const rows = within(table).getAllByTestId("health-heat-map-row");
	expect(rows).toHaveLength(1);
	const cells = within(rows[0] as HTMLElement).getAllByRole("cell");
	// Four buckets and the peak.
	expect(cells.map((cell) => cell.textContent)).toEqual([
		"12%",
		"no data",
		"85%, at or over the 80% threshold",
		"no data",
		"85%",
	]);
	const over = cells[2]?.querySelector("div");
	expect(over?.getAttribute("data-over")).toBe("true");
	expect(over?.getAttribute("style")).toContain("repeating-linear-gradient");
	expect(cells[0]?.querySelector("div")?.className).toContain("bg-accent/10");

	const link = within(rows[0] as HTMLElement).getByRole("link", { name: "Ann Lee" });
	expect(link.getAttribute("href")).toBe(`/admin?tab=workspaces&user=${OWNER}`);
	expect(screen.queryByTestId("health-heat-map-retention")).toBeNull();
});

test("the toggle switches to memory and its threshold", async () => {
	const f = frame("1h", 60, 4);
	renderMap(body(f, [row(f)]), f);

	const memory = await screen.findByRole("button", { name: "Memory" });
	expect(memory.getAttribute("aria-pressed")).toBe("false");
	fireEvent.click(memory);
	expect(memory.getAttribute("aria-pressed")).toBe("true");
	expect(screen.getByRole("button", { name: "CPU" }).getAttribute("aria-pressed")).toBe(
		"false",
	);
	const table = screen.getByRole("table", {
		name: "Per-workspace memory, highest per minute",
	});
	const cells = within(table).getAllByRole("cell");
	expect(cells.map((cell) => cell.textContent)).toEqual([
		"40%",
		"no data",
		"50%",
		"no data",
		"50%",
	]);
});

test("a range longer than retention says so and starts at the usage window", async () => {
	const f = frame("1d", 900, 96);
	const usageFrom = at(f, 80);
	const r = { ...row(f), cells: [{ at: at(f, 90), cpuPercent: 5, memoryPercent: 5 }] };
	renderMap(body(f, [r], usageFrom), f);

	expect(
		(await screen.findByTestId("health-heat-map-retention")).textContent,
	).toContain("Per-workspace figures are kept for about 4 hours.");
	// Sixteen buckets from the usage window's start, plus the peak.
	expect(
		within(screen.getByTestId("health-heat-map-row")).getAllByRole("cell"),
	).toHaveLength(17);
});

test("fifty rows say the map was capped; none says there is nothing", async () => {
	const f = frame("1h", 60, 4);
	const many = Array.from({ length: 50 }, (_, i) => ({
		...row(f),
		workspaceId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
	}));
	renderMap(body(f, many), f);
	expect((await screen.findByTestId("health-heat-map-capped")).textContent).toContain(
		"Showing the 50 workspaces with the highest peaks.",
	);
});

test("no workspaces shows an empty message", async () => {
	const f = frame("1h", 60, 4);
	renderMap(body(f, []), f);
	expect((await screen.findByTestId("health-heat-map-empty")).textContent).toBe(
		"No workspace has usage figures in this range.",
	);
	expect(screen.queryByRole("table")).toBeNull();
});
