import type { HealthSeries } from "@portikus/contracts";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import type { ChartFrame } from "./charts/scales.js";
import { countTicks, EventCharts, totalsSummary } from "./EventCharts.js";

const FRAME: ChartFrame = {
	range: "1d",
	from: Date.parse("2026-09-26T12:00:00.000Z"),
	bucketSeconds: 900,
	count: 4,
};

function point(index: number, values: Partial<HealthSeries["events"][number]>) {
	return {
		at: new Date(FRAME.from + index * 900_000).toISOString(),
		throttles: 0,
		memoryFlags: 0,
		idleStops: 0,
		guardLifts: 0,
		starts: 0,
		stops: 0,
		signIns: 0,
		...values,
	};
}

function series(events: HealthSeries["events"]): HealthSeries {
	return {
		range: "1d",
		bucketSeconds: 900,
		from: new Date(FRAME.from).toISOString(),
		to: new Date(FRAME.from + 4 * 900_000).toISOString(),
		cpuCount: 4,
		host: [],
		platform: [],
		events,
		usage: {
			retentionMinutes: 245,
			from: new Date(FRAME.from).toISOString(),
			workspaces: [],
		},
		api: [],
	};
}

test("count ticks are whole numbers from zero to at least the maximum", () => {
	expect(countTicks(0)).toEqual([0, 1, 2]);
	expect(countTicks(4)).toEqual([0, 1, 2, 3, 4]);
	expect(countTicks(10)).toEqual([0, 3, 6, 9, 12]);
	expect(countTicks(100)).toEqual([0, 25, 50, 75, 100]);
});

test("summaries total each measure over the range", () => {
	expect(totalsSummary(["Starts", "Sign-ins"], [3, 0])).toBe(
		"Total in this range: starts 3, sign-ins 0.",
	);
});

test("the two charts label their bucket, total their counts and read zero between events", () => {
	render(
		<EventCharts
			series={series([
				point(0, { throttles: 2, guardLifts: 1, starts: 1, signIns: 4 }),
				point(2, { memoryFlags: 1, idleStops: 1, stops: 3 }),
			])}
			frame={FRAME}
		/>,
	);

	expect(
		screen.getByRole("img", {
			name: "Resource guard events per 15 minutes: Total in this range: throttles 2, memory flags 1, idle stops 1, lifts 1.",
		}),
	).toBeDefined();
	expect(
		screen.getByRole("img", {
			name: "Workspace starts, stops and sign-ins per 15 minutes: Total in this range: starts 1, stops 3, sign-ins 4.",
		}),
	).toBeDefined();
	// Each series has a legend entry, so none relies on colour.
	for (const name of [
		"Throttles",
		"Memory flags",
		"Idle stops",
		"Lifts",
		"Starts",
		"Stops",
		"Sign-ins",
	]) {
		expect(screen.getByText(name)).toBeDefined();
	}

	const plot = screen.getByRole("application", {
		name: "Workspace starts, stops and sign-ins per 15 minutes, use the left and right arrow keys to read values",
	});
	fireEvent.keyDown(plot, { key: "Home" });
	fireEvent.keyDown(plot, { key: "ArrowRight" });
	expect(screen.getByTestId("health-chart-activity-readout").textContent).toContain(
		"Starts 0, Stops 0, Sign-ins 0",
	);
});

test("every guard line has its own pattern", () => {
	const { container } = render(<EventCharts series={series([])} frame={FRAME} />);
	const dashes = [
		...container.querySelectorAll('[data-testid="health-chart-guard-events-line"]'),
	].map((path) => path.getAttribute("stroke-dasharray"));
	expect(new Set(dashes).size).toBe(4);
});
