import type { HealthSeries } from "@portikus/contracts";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import type { ChartFrame } from "./charts/scales.js";
import { PlatformCharts, rateScale, stripSummary } from "./PlatformCharts.js";

const FROM = new Date(2026, 8, 26, 13, 0);
const FRAME: ChartFrame = {
	range: "6h",
	from: FROM.getTime(),
	bucketSeconds: 300,
	count: 3,
};

function at(index: number): string {
	return new Date(FROM.getTime() + index * 300_000).toISOString();
}

function point(
	index: number,
	overrides: Partial<HealthSeries["platform"][number]> = {},
) {
	return {
		at: at(index),
		sampleMinutes: 5,
		reachableMinutes: 5,
		runningWorkspaces: 3,
		cpuPercent: 42,
		netRxBytesPerSecond: 2 * 1024 * 1024,
		netTxBytesPerSecond: 512 * 1024,
		diskReadBytesPerSecond: 1000,
		diskWriteBytesPerSecond: 0,
		...overrides,
	};
}

const PLATFORM = [point(0, { sampleMinutes: 4, reachableMinutes: 1 }), point(2)];

function series(platform: HealthSeries["platform"]): HealthSeries {
	return {
		range: "6h",
		bucketSeconds: 300,
		from: at(0),
		to: at(3),
		cpuCount: 4,
		host: [],
		platform,
		events: [],
		usage: { retentionMinutes: 245, from: at(0), workspaces: [] },
		api: [],
	};
}

test("the strip sums sampled and unreachable minutes across the range", () => {
	// Bucket 0 has 4 of 5 minutes, 3 of them unreachable; bucket 1 has none.
	expect(stripSummary(FRAME, PLATFORM)).toBe(
		"Samples in 9 of 15 minutes; controller unreachable for 3.",
	);
	expect(stripSummary({ ...FRAME, bucketSeconds: 3600, count: 24 }, [])).toBe(
		"Samples in 0 of 1,440 minutes; controller unreachable for 0.",
	);
});

test("the strip reads each bucket from the keyboard and marks outages and gaps", () => {
	render(<PlatformCharts series={series(PLATFORM)} frame={FRAME} />);
	const strip = screen.getByTestId("health-chart-availability");
	expect(strip.querySelectorAll("[data-part=outage]")).toHaveLength(1);
	// Bucket 0 lacks one minute and bucket 1 lacks all five.
	expect(strip.querySelectorAll("[data-part=gap]")).toHaveLength(2);
	expect(screen.getByText("Controller unreachable")).toBeDefined();
	expect(screen.getByText("No sample")).toBeDefined();

	const plot = screen.getByTestId("health-chart-availability-plot");
	fireEvent.keyDown(plot, { key: "Home" });
	expect(screen.getByTestId("health-chart-availability-readout").textContent).toMatch(
		/, samples in 4 of 5 minutes, controller unreachable for 3$/,
	);
});

test("the charts carry units in their ticks and summaries", () => {
	render(<PlatformCharts series={series(PLATFORM)} frame={FRAME} />);
	expect(screen.getByTestId("health-chart-running-summary").textContent).toBe(
		"Now 3, highest 3.",
	);
	expect(screen.getByTestId("health-chart-cpu-summary").textContent).toBe(
		"Now 42%, highest 42%.",
	);
	expect(screen.getByTestId("health-chart-network-summary").textContent).toBe(
		"In: Now 2 MB/s, highest 2 MB/s. Out: Now 0.5 MB/s, highest 0.5 MB/s.",
	);
	expect(screen.getByTestId("health-chart-disk-summary").textContent).toBe(
		"Read: Now 1000 B/s, highest 1000 B/s. Write: Now 0 B/s, highest 0 B/s.",
	);
	expect(screen.getByText("In")).toBeDefined();
	expect(screen.getByText("Out")).toBeDefined();
});

test("old samples without rates give no-samples summaries, not zeros", () => {
	render(
		<PlatformCharts
			series={series([
				point(0, {
					runningWorkspaces: null,
					cpuPercent: null,
					netRxBytesPerSecond: null,
					netTxBytesPerSecond: null,
					diskReadBytesPerSecond: null,
					diskWriteBytesPerSecond: null,
				}),
			])}
			frame={FRAME}
		/>,
	);
	expect(screen.getByTestId("health-chart-cpu-summary").textContent).toBe(
		"No samples in this range.",
	);
});

test("rate ticks use one unit picked from the largest value", () => {
	const scale = rateScale(3 * 1024 * 1024);
	expect(scale.ticks.map(scale.format)).toEqual([
		"0 MB/s",
		"1 MB/s",
		"2 MB/s",
		"3 MB/s",
	]);
	expect(rateScale(0).ticks.length).toBeGreaterThanOrEqual(3);
});
