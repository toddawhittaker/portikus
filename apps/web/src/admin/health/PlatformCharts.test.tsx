import type { HealthSeries } from "@portikus/contracts";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import type { ChartFrame } from "./charts/scales.js";
import {
	AvailabilityStrip,
	HostRateCharts,
	RunningChart,
	rateScale,
	stripSummary,
} from "./PlatformCharts.js";

function PlatformCharts({
	series,
	frame,
}: {
	series: HealthSeries;
	frame: ChartFrame;
}) {
	return (
		<>
			<AvailabilityStrip frame={frame} points={series.platform} />
			<RunningChart series={series} frame={frame} />
			<HostRateCharts series={series} frame={frame} />
		</>
	);
}

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

test("a missing sample is a quiet dot; only an outage is red", () => {
	render(<PlatformCharts series={series(PLATFORM)} frame={FRAME} />);
	const gap = document.getElementById("health-strip-gap");
	const outage = document.getElementById("health-strip-outage");
	expect(gap?.querySelector("circle")?.getAttribute("class")).toBe("fill-ink-faint");
	expect(gap?.innerHTML).not.toContain("status-error");
	expect(outage?.innerHTML).toContain("fill-status-error");
});

test("the charts name their unit in the title, with bare-number ticks", () => {
	render(<PlatformCharts series={series(PLATFORM)} frame={FRAME} />);
	const network = screen.getByTestId("health-chart-network");
	expect(network.querySelector("figcaption")?.textContent).toBe(
		"Network on the default interface, MB/s",
	);
	const ticks = [...network.querySelectorAll('text[data-axis="y"]')].map(
		(tick) => tick.textContent,
	);
	expect(ticks).toEqual(["0", "0.5", "1", "1.5", "2"]);
	expect(new Set(ticks).size).toBe(ticks.length);
	expect(
		screen.getByTestId("health-chart-cpu").querySelector("figcaption")?.textContent,
	).toBe("Host CPU used, %");
});

test("the charts carry units in their summaries", () => {
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
	expect(
		screen.getByTestId("health-chart-disk").querySelector("figcaption")?.textContent,
	).toBe("Disk, B/s");
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
	expect(screen.getByTestId("health-chart-network-summary").textContent).toBe(
		"No samples in this range.",
	);
	// No samples, no axis and no tab stop: only the sentence.
	expect(screen.queryByTestId("health-chart-cpu-plot")).toBeNull();
	expect(screen.getByTestId("health-chart-cpu").querySelector("svg")).toBeNull();
});

test("rate ticks use one unit picked from the largest value", () => {
	const scale = rateScale(3 * 1024 * 1024);
	expect(scale.unit).toBe("MB/s");
	expect(scale.ticks.map(scale.tick)).toEqual(["0", "1", "2", "3"]);
	expect(scale.format(1.5 * 1024 * 1024)).toBe("1.5 MB/s");
	expect(rateScale(0).ticks.length).toBeGreaterThanOrEqual(3);
});
