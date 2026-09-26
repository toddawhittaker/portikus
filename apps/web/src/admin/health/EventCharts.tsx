import type { HealthSeries } from "@portikus/contracts";
import { LineChart } from "./charts/LineChart.js";
import { bucketPhrase, type ChartFrame, dense, niceNumber } from "./charts/scales.js";

type EventPoint = HealthSeries["events"][number];
type Measure = { name: string; pick: (point: EventPoint) => number };

const GUARD: readonly Measure[] = [
	{ name: "Throttles", pick: (point) => point.throttles },
	{ name: "Memory flags", pick: (point) => point.memoryFlags },
	{ name: "Idle stops", pick: (point) => point.idleStops },
	{ name: "Lifts", pick: (point) => point.guardLifts },
];

const ACTIVITY: readonly Measure[] = [
	{ name: "Starts", pick: (point) => point.starts },
	{ name: "Stops", pick: (point) => point.stops },
	{ name: "Sign-ins", pick: (point) => point.signIns },
];

function formatCount(value: number): string {
	return String(Math.round(value));
}

/** Whole-number Y ticks from 0 to at least `max`, three to five of them. */
export function countTicks(max: number): number[] {
	const step = Math.max(1, Math.ceil(niceNumber(max / 4)));
	const steps = Math.max(2, Math.ceil(max / step));
	return Array.from({ length: steps + 1 }, (_, i) => i * step);
}

/** "Total in this range: throttles 3, memory flags 0." */
export function totalsSummary(
	names: readonly string[],
	totals: readonly number[],
): string {
	const parts = names.map((name, i) => `${name.toLowerCase()} ${totals[i] ?? 0}`);
	return `Total in this range: ${parts.join(", ")}.`;
}

/**
 * One count chart. The API leaves out buckets with no events, so absent
 * buckets are zero here rather than gaps.
 */
function CountChart({
	testId,
	label,
	frame,
	events,
	measures,
}: {
	testId: string;
	label: string;
	frame: ChartFrame;
	events: readonly EventPoint[];
	measures: readonly Measure[];
}) {
	const series = measures.map((measure) => ({
		name: measure.name,
		values: dense(frame, events, measure.pick).map((value) => value ?? 0),
	}));
	const totals = series.map((line) =>
		line.values.reduce((sum, value) => sum + value, 0),
	);
	const highest = Math.max(0, ...series.flatMap((line) => line.values));
	return (
		<LineChart
			testId={testId}
			label={`${label} ${bucketPhrase(frame.bucketSeconds)}`}
			frame={frame}
			series={series}
			ticks={countTicks(highest)}
			format={formatCount}
			summary={totalsSummary(
				measures.map((measure) => measure.name),
				totals,
			)}
		/>
	);
}

/** Guard events and workspace activity per bucket (SPEC.md §25.6, #598 items 4 and 5). */
export function EventCharts({
	series,
	frame,
}: {
	series: HealthSeries;
	frame: ChartFrame;
}) {
	return (
		<>
			<CountChart
				testId="health-chart-guard-events"
				label="Resource guard events"
				frame={frame}
				events={series.events}
				measures={GUARD}
			/>
			<CountChart
				testId="health-chart-activity"
				label="Workspace starts, stops and sign-ins"
				frame={frame}
				events={series.events}
				measures={ACTIVITY}
			/>
		</>
	);
}
