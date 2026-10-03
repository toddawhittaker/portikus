import type { HealthSeries } from "@portikus/contracts";
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from "@tanstack/react-router";
import { fireEvent, screen, within } from "@testing-library/react";
import { useState } from "react";
import { expect, test } from "vitest";
import { renderWithQuery } from "../../test-utils.js";
import { type ChartFrame, readoutTime } from "./charts/scales.js";
import { cellText, moveCell, stepClass, UsageHeatMap } from "./UsageHeatMap.js";

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

function renderMap(
	series: HealthSeries,
	f: ChartFrame,
	component = () => <UsageHeatMap series={series} frame={f} />,
) {
	const rootRoute = createRootRoute({ component });
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ["/admin/health"] }),
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
	// Filled cells are outlined and empty ones dotted, so low use never looks like no data.
	expect(cells[0]?.querySelector("div")?.className).toContain("border-line-strong");
	const empty = cells[1]?.querySelector("div");
	expect(empty?.getAttribute("data-empty")).toBe("true");
	expect(empty?.className).not.toContain("border-line-strong");
	expect(empty?.getAttribute("style")).toContain("radial-gradient");
	// The figure is named by its caption.
	expect(
		screen.getByRole("figure", { name: "Per-workspace CPU, highest per minute" }),
	).toBeDefined();

	const link = within(rows[0] as HTMLElement).getByRole("link", { name: "Ann Lee" });
	expect(link.getAttribute("href")).toBe(`/admin/users?user=${OWNER}`);
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

test("the cursor moves by row and column, clamps at the edges and starts at the newest bucket", () => {
	expect(moveCell("ArrowRight", null, 3, 4)).toEqual({ row: 0, column: 3 });
	expect(moveCell("ArrowDown", null, 3, 4)).toEqual({ row: 0, column: 3 });
	expect(moveCell("ArrowDown", { row: 0, column: 1 }, 3, 4)).toEqual({
		row: 1,
		column: 1,
	});
	expect(moveCell("ArrowDown", { row: 2, column: 1 }, 3, 4)).toEqual({
		row: 2,
		column: 1,
	});
	expect(moveCell("ArrowUp", { row: 0, column: 1 }, 3, 4)).toEqual({
		row: 0,
		column: 1,
	});
	expect(moveCell("ArrowLeft", { row: 1, column: 0 }, 3, 4)).toEqual({
		row: 1,
		column: 0,
	});
	expect(moveCell("Home", { row: 2, column: 2 }, 3, 4)).toEqual({ row: 2, column: 0 });
	expect(moveCell("End", { row: 2, column: 0 }, 3, 4)).toEqual({ row: 2, column: 3 });
	expect(moveCell("Enter", { row: 0, column: 0 }, 3, 4)).toBeNull();
	expect(moveCell("ArrowDown", null, 0, 4)).toBeNull();
});

test("one tab stop on the table; arrow keys show and announce a cell's exact value", async () => {
	const f = frame("1h", 60, 4);
	const second = {
		...row(f),
		workspaceId: "00000000-0000-4000-8000-0000000000a2",
		owner: { id: OWNER, displayName: "Bo Diaz" },
		cells: [{ at: at(f, 3), cpuPercent: 7, memoryPercent: 9 }],
	};
	renderMap(body(f, [row(f), second]), f);

	const table = await screen.findByRole("table", {
		name: "Per-workspace CPU, highest per minute",
	});
	expect(table.getAttribute("tabindex")).toBe("0");
	// No cell is a tab stop of its own.
	expect(table.querySelectorAll("td[tabindex], td div[tabindex]")).toHaveLength(0);
	const readout = screen.getByTestId("health-heat-map-readout");
	expect(readout.getAttribute("aria-hidden")).toBe("true");
	expect(readout.textContent).toContain("arrow keys");

	table.focus();
	fireEvent.keyDown(table, { key: "ArrowRight" });
	// The newest bucket of the first row.
	const time = (index: number) => readoutTime(Date.parse(at(f, index)), "1h");
	expect(readout.textContent).toBe(`Ann Lee, ${time(3)}, no data`);
	fireEvent.keyDown(table, { key: "ArrowLeft" });
	expect(readout.textContent).toBe(
		`Ann Lee, ${time(2)}, 85%, at or over the 80% threshold`,
	);
	const marked = table.querySelectorAll('[data-cursor="true"]');
	expect(marked).toHaveLength(1);
	expect(marked[0]?.textContent).toBe("85%, at or over the 80% threshold");
	expect(marked[0]?.className).toContain("outline-ink");

	fireEvent.keyDown(table, { key: "ArrowDown" });
	fireEvent.keyDown(table, { key: "End" });
	expect(readout.textContent).toBe(`Bo Diaz, ${time(3)}, 7%`);
	// The same words go to a polite live region for a screen reader in focus mode.
	const live = document.querySelector('[aria-live="polite"]');
	expect(live?.textContent).toBe(`Bo Diaz, ${time(3)}, 7%`);

	// The memory toggle keeps the cursor and reads the new measure.
	fireEvent.click(screen.getByRole("button", { name: "Memory" }));
	expect(readout.textContent).toBe(`Bo Diaz, ${time(3)}, 9%`);

	fireEvent.blur(table);
	expect(table.querySelectorAll('[data-cursor="true"]')).toHaveLength(0);
	expect(readout.textContent).toContain("arrow keys");
});

test("a refresh that reorders the rows keeps the cursor on the same workspace", async () => {
	const f = frame("1h", 60, 4);
	const ann = row(f);
	const bo = {
		...row(f),
		workspaceId: "00000000-0000-4000-8000-0000000000a2",
		owner: { id: OWNER, displayName: "Bo Diaz" },
		cells: [{ at: at(f, 3), cpuPercent: 7, memoryPercent: 9 }],
	};
	function Refreshing() {
		const [series, setSeries] = useState(body(f, [ann, bo]));
		return (
			<>
				<button type="button" onClick={() => setSeries(body(f, [bo, ann]))}>
					Refresh
				</button>
				<UsageHeatMap series={series} frame={f} />
			</>
		);
	}
	renderMap(body(f, []), f, Refreshing);

	const table = await screen.findByTestId("health-heat-map-table");
	fireEvent.keyDown(table, { key: "ArrowLeft" });
	fireEvent.keyDown(table, { key: "ArrowDown" });
	const readout = screen.getByTestId("health-heat-map-readout");
	expect(readout.textContent).toMatch(/^Bo Diaz, /);
	fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
	expect(readout.textContent).toMatch(/^Bo Diaz, /);
	const marked = table.querySelector('[data-cursor="true"]');
	expect(marked?.closest("tr")?.textContent).toContain("Bo Diaz");
});

test("arrow keys on an owner link are left to the link", async () => {
	const f = frame("1h", 60, 4);
	renderMap(body(f, [row(f)]), f);
	const link = await screen.findByRole("link", { name: "Ann Lee" });
	fireEvent.keyDown(link, { key: "ArrowRight" });
	expect(screen.getByTestId("health-heat-map-readout").textContent).toContain(
		"arrow keys",
	);
});
