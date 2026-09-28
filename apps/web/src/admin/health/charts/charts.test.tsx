import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { BarChart, seriesAt } from "./BarChart.js";
import { LineChart, linePath } from "./LineChart.js";
import { DEFAULT_WIDTH, moveCursor, plotOf, timeLabelPositions } from "./readout.js";
import type { ChartFrame } from "./scales.js";

const FRAME: ChartFrame = {
	range: "1h",
	from: new Date(2026, 8, 26, 13, 0).getTime(),
	bucketSeconds: 60,
	count: 4,
};

test("arrows move one bucket, Home and End jump to the ends", () => {
	expect(moveCursor("ArrowLeft", null, 4)).toBe(3);
	expect(moveCursor("ArrowLeft", 2, 4)).toBe(1);
	expect(moveCursor("ArrowLeft", 0, 4)).toBe(0);
	expect(moveCursor("ArrowRight", 3, 4)).toBe(3);
	expect(moveCursor("Home", 2, 4)).toBe(0);
	expect(moveCursor("End", 0, 4)).toBe(3);
	expect(moveCursor("a", 0, 4)).toBeNull();
	expect(moveCursor("End", null, 0)).toBeNull();
});

test("a gap starts a new line segment, and a lone point is a dot", () => {
	const plot = plotOf(DEFAULT_WIDTH, ["100"]);
	const path = linePath(FRAME, [10, 20, null, 30], 100, plot);
	expect(path.match(/M/g)).toHaveLength(2);
	expect(path).toMatch(/ l0 0$/);
	expect(linePath(FRAME, [null, null, null, null], 100, plot)).toBe("");
});

function line() {
	render(
		<LineChart
			testId="chart"
			label="Memory used"
			frame={FRAME}
			series={[{ name: "Memory", values: [10, null, 30, 40] }]}
			ticks={[0, 25, 50, 75, 100]}
			format={(value) => `${value}%`}
			summary="Now 40%, highest 40%."
		/>,
	);
}

test("a line chart names its plot, reads the summary and has Y ticks", () => {
	line();
	expect(
		screen.getByRole("img", { name: "Memory used: Now 40%, highest 40%." }),
	).toBeDefined();
	const plot = screen.getByRole("application", {
		name: "Memory used, use the left and right arrow keys to read values",
	});
	expect(plot.getAttribute("tabindex")).toBe("0");
	// Bare numbers: the unit belongs in the title.
	expect(screen.getByText("100")).toBeDefined();
	expect(screen.getByText("0")).toBeDefined();
});

test("a line chart with no values draws no axis, only its summary", () => {
	render(
		<LineChart
			testId="empty"
			label="API response time, ms"
			frame={FRAME}
			series={[{ name: "Median", values: [null, null, null, null] }]}
			ticks={[0, 1]}
			format={String}
			summary="No requests in this range."
		/>,
	);
	expect(screen.queryByRole("application")).toBeNull();
	expect(screen.queryByRole("img")).toBeNull();
	const summary = screen.getByTestId("empty-summary");
	expect(summary.textContent).toBe("No requests in this range.");
	expect(summary.getAttribute("aria-hidden")).toBeNull();
});

test("the Y gutter grows with the longest tick label", () => {
	expect(plotOf(560, ["0", "60K"]).left).toBeLessThan(plotOf(560, ["0", "1,500"]).left);
	const plot = plotOf(560, ["0", "1,500"]);
	// Five characters at 12 px, plus the 6 px gap to the plot.
	expect(plot.left).toBeGreaterThanOrEqual(5 * 7 + 6);
	expect(plot.plotWidth).toBe(560 - plot.left - 12);
});

test("time labels never overlap or pass either edge, however narrow the chart", () => {
	const day: ChartFrame = {
		range: "1d",
		from: new Date(2026, 8, 26, 0, 0).getTime(),
		bucketSeconds: 900,
		count: 96,
	};
	for (const width of [240, 400, 1200]) {
		const plot = plotOf(width, ["100"]);
		const labels = timeLabelPositions(day, plot);
		expect(labels.length).toBeGreaterThan(0);
		for (let i = 1; i < labels.length; i++) {
			const before = labels[i - 1];
			const label = labels[i];
			if (!before || !label) continue;
			const gap =
				label.x -
				(label.text.length * 7.5) / 2 -
				(before.x + (before.text.length * 7.5) / 2);
			expect(gap).toBeGreaterThanOrEqual(12);
		}
		const first = labels[0];
		if (first)
			expect(first.x - (first.text.length * 7.5) / 2).toBeGreaterThanOrEqual(0);
		const last = labels.at(-1);
		if (last) expect(last.x + (last.text.length * 7.5) / 2).toBeLessThanOrEqual(width);
	}
});

test("the keyboard readout announces each bucket, gaps as no data", () => {
	line();
	const plot = screen.getByTestId("chart-plot");
	fireEvent.keyDown(plot, { key: "End" });
	const live = document.querySelector("[aria-live=polite]");
	expect(live?.textContent).toMatch(/, 40%$/);
	expect(screen.getByTestId("chart-readout").textContent).toMatch(/, 40%$/);
	fireEvent.keyDown(plot, { key: "Home" });
	expect(live?.textContent).toMatch(/, 10%$/);
	fireEvent.keyDown(plot, { key: "ArrowRight" });
	expect(live?.textContent).toMatch(/, no data$/);
});

test("a chart with several series has a legend and names each value", () => {
	render(
		<LineChart
			testId="load"
			label="Load average"
			frame={FRAME}
			series={[
				{ name: "1 minute", values: [1, 1, 1, 2] },
				{ name: "5 minutes", values: [1, 1, 1, 1.5] },
			]}
			ticks={[0, 1, 2]}
			format={(value) => value.toFixed(2)}
			summary="Now 2.00, highest 2.00."
		/>,
	);
	expect(screen.getByText("5 minutes")).toBeDefined();
	fireEvent.keyDown(screen.getByTestId("load-plot"), { key: "End" });
	expect(screen.getByTestId("load-readout").textContent).toMatch(
		/1 minute 2\.00, 5 minutes 1\.50$/,
	);
});

test("Up and Down pick a series in a bar and Enter opens it", () => {
	const onOpen = vi.fn();
	render(
		<BarChart
			testId="bars"
			label="Log lines per minute"
			frame={FRAME}
			series={[
				{ name: "Errors", tone: "error", values: [1, 0, null, 2] },
				{ name: "Warnings", tone: "warning", values: [3, 0, null, 1] },
			]}
			ticks={[0, 2, 4]}
			format={String}
			summary="3 errors, 4 warnings."
			onOpen={onOpen}
		/>,
	);
	const plot = screen.getByTestId("bars-plot");
	fireEvent.keyDown(plot, { key: "Home" });
	fireEvent.keyDown(plot, { key: "ArrowUp" });
	fireEvent.keyDown(plot, { key: "Enter" });
	expect(onOpen).toHaveBeenCalledWith(0, 1);
	fireEvent.keyDown(plot, { key: "ArrowDown" });
	fireEvent.keyDown(plot, { key: "End" });
	fireEvent.keyDown(plot, { key: "Enter" });
	expect(onOpen).toHaveBeenLastCalledWith(3, 0);
	expect(document.querySelectorAll("rect[data-series]")).toHaveLength(4);
});

function renderBars(onOpen = vi.fn()) {
	render(
		<BarChart
			testId="bars"
			label="Errors and warnings"
			frame={FRAME}
			series={[
				{ name: "Errors", tone: "error", values: [1, 0, null, 2] },
				{ name: "Warnings", tone: "warning", values: [3, 0, null, 1] },
			]}
			ticks={[0, 2, 4]}
			format={String}
			summary="3 errors, 4 warnings."
			onOpen={onOpen}
			openHint="open the logs"
		/>,
	);
	return onOpen;
}

test("warnings are hatched and sit 1px above the errors, so colour is not the only cue", () => {
	renderBars();
	const warning = document.querySelector('rect[data-series="1"]');
	const error = document.querySelector('rect[data-series="0"]');
	expect(warning?.getAttribute("class")).toBe("fill-[url(#health-bar-warning)]");
	expect(document.getElementById("health-bar-warning")?.tagName).toBe("pattern");
	const errorTop = Number(error?.getAttribute("y"));
	const warningBottom =
		Number(warning?.getAttribute("y")) + Number(warning?.getAttribute("height"));
	expect(errorTop - warningBottom).toBeCloseTo(1);
});

test("Up and Down announce the chosen level, and the keys are named", () => {
	renderBars();
	const plot = screen.getByTestId("bars-plot");
	expect(plot.getAttribute("aria-label")).toBe(
		"Errors and warnings, use the left and right arrow keys to read values, up and down to choose errors or warnings, Enter to open the logs",
	);
	expect(screen.getByTestId("bars-keys").textContent).toContain(
		"Enter to open the logs",
	);
	fireEvent.keyDown(plot, { key: "Home" });
	fireEvent.keyDown(plot, { key: "ArrowUp" });
	expect(screen.getByText("Warnings 3 selected")).toBeDefined();
	fireEvent.keyDown(plot, { key: "ArrowDown" });
	expect(screen.getByText("Errors 1 selected")).toBeDefined();
});

test("each bucket has a full-height click column that opens the series under the pointer", () => {
	const onOpen = renderBars();
	const columns = document.querySelectorAll("rect[data-hit]");
	expect(columns).toHaveLength(4);
	const first = columns[0] as SVGRectElement;
	expect(Number(first.getAttribute("height"))).toBeGreaterThan(100);
	fireEvent.click(first);
	expect(onOpen).toHaveBeenCalledWith(0, expect.any(Number));
	expect(seriesAt([1, 3], 0.5)).toBe(0);
	expect(seriesAt([1, 3], 2)).toBe(1);
	expect(seriesAt([1, 3], 9)).toBe(0);
});

test("a bucket with no data draws a dotted baseline", () => {
	renderBars();
	expect(document.querySelectorAll("line[data-gap]")).toHaveLength(1);
});
