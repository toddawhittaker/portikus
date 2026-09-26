import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { BarChart } from "./BarChart.js";
import { LineChart, linePath } from "./LineChart.js";
import { moveCursor } from "./readout.js";
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
	const path = linePath(FRAME, [10, 20, null, 30], 100);
	expect(path.match(/M/g)).toHaveLength(2);
	expect(path).toMatch(/ l0 0$/);
	expect(linePath(FRAME, [null, null, null, null], 100)).toBe("");
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
	expect(screen.getByText("100%")).toBeDefined();
	expect(screen.getByText("0%")).toBeDefined();
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
