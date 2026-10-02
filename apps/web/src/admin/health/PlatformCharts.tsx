import type { HealthSeries } from "@portikus/contracts";
import { LineChart } from "./charts/LineChart.js";
import { ChartShell, PLOT_HEIGHT, type SeriesStyle, valueY } from "./charts/readout.js";
import {
	bucketStart,
	type ChartFrame,
	countTicks,
	dense,
	lineSummary,
	PERCENT_TICKS,
	tickText,
	yTicks,
} from "./charts/scales.js";
import { formatPercent } from "./HostCharts.js";

type PlatformPoint = HealthSeries["platform"][number];

const RATE_UNITS = ["B/s", "KB/s", "MB/s", "GB/s"] as const;

/**
 * Y ticks and formatters for bytes per second, all in one unit picked from
 * the largest value: the chart title names the unit ("MB/s"), the ticks are
 * bare numbers in it ("0, 0.5, 1"), and the readout says "1.5 MB/s".
 */
export function rateScale(max: number): {
	unit: string;
	ticks: number[];
	tick: (value: number) => string;
	format: (value: number) => string;
} {
	let power = 0;
	while (max >= 1024 ** (power + 1) && power < RATE_UNITS.length - 1) power += 1;
	const size = 1024 ** power;
	const unit = RATE_UNITS[power] as string;
	return {
		unit,
		ticks: yTicks(max / size).map((tick) => tick * size),
		tick: (value) => tickText(value / size),
		format: (value) => {
			const scaled = value / size;
			return `${Number.isInteger(scaled) ? scaled : scaled.toFixed(1)} ${unit}`;
		},
	};
}

function formatCount(value: number): string {
	return String(Math.round(value));
}

function presentMax(...lists: (number | null)[][]): number {
	let max = 0;
	for (const list of lists) {
		for (const value of list) if (value !== null && value > max) max = value;
	}
	return max;
}

/** Ids of the SVG patterns the strip and its legend share; one strip per page. */
const OUTAGE_PATTERN = "health-strip-outage";
const GAP_PATTERN = "health-strip-gap";

/** Red is kept for the controller being down; a missing sample is only a quiet dot. */
const STRIP_STYLES: Record<"sampled" | "outage" | "gap", SeriesStyle> = {
	sampled: { className: "fill-accent" },
	outage: { className: "fill-[url(#health-strip-outage)]" },
	gap: { className: "fill-[url(#health-strip-gap)]" },
};

/**
 * Per bucket, the minutes with a sample and a reachable controller, the
 * minutes with a sample but no controller, and the minutes with no sample.
 */
export function stripMinutes(frame: ChartFrame, points: readonly PlatformPoint[]) {
	const perBucket = frame.bucketSeconds / 60;
	const sampled = dense(frame, points, (point) => point.sampleMinutes);
	const reachable = dense(frame, points, (point) => point.reachableMinutes);
	return sampled.map((value, index) => {
		const minutes = Math.min(perBucket, value ?? 0);
		const up = Math.min(minutes, reachable[index] ?? 0);
		return {
			total: perBucket,
			reachable: up,
			unreachable: minutes - up,
			missing: perBucket - minutes,
		};
	});
}

/** "Samples in 1,436 of 1,440 minutes; controller unreachable for 3." */
export function stripSummary(
	frame: ChartFrame,
	points: readonly PlatformPoint[],
): string {
	const buckets = stripMinutes(frame, points);
	const total = buckets.reduce((sum, bucket) => sum + bucket.total, 0);
	const missing = buckets.reduce((sum, bucket) => sum + bucket.missing, 0);
	const unreachable = buckets.reduce((sum, bucket) => sum + bucket.unreachable, 0);
	return `Samples in ${(total - missing).toLocaleString()} of ${total.toLocaleString()} minutes; controller unreachable for ${unreachable.toLocaleString()}.`;
}

/**
 * The availability strip (SPEC.md section 25.6): each bucket is a
 * column filled by its share of minutes. Outages are status-error with a
 * stripe; missing samples are an ink-faint dot pattern, so neither relies
 * on colour and only an outage reads as alarm.
 */
export function AvailabilityStrip({
	frame,
	points,
}: {
	frame: ChartFrame;
	points: readonly PlatformPoint[];
}) {
	const buckets = stripMinutes(frame, points);
	function describe(index: number): string {
		const bucket = buckets[index];
		if (!bucket) return "no data";
		const sampled = bucket.total - bucket.missing;
		return `samples in ${sampled} of ${bucket.total} minutes, controller unreachable for ${bucket.unreachable}`;
	}
	return (
		<ChartShell
			testId="health-chart-availability"
			label="Sampling and controller availability, % of minutes"
			frame={frame}
			yTicks={[0, 50, 100]}
			summary={stripSummary(frame, points)}
			describe={describe}
			legend={[
				{ name: "Sampled", style: STRIP_STYLES.sampled, swatch: "box" },
				{ name: "Controller unreachable", style: STRIP_STYLES.outage, swatch: "box" },
				{ name: "No sample", style: STRIP_STYLES.gap, swatch: "box" },
			]}
		>
			{(_, plot) => (
				<>
					<defs>
						<pattern
							id={OUTAGE_PATTERN}
							width="6"
							height="6"
							patternUnits="userSpaceOnUse"
							patternTransform="rotate(45)"
						>
							<rect width="6" height="6" className="fill-status-error" />
							<line
								x1="1"
								y1="0"
								x2="1"
								y2="6"
								strokeWidth="2"
								className="stroke-surface-raised"
							/>
						</pattern>
						<pattern
							id={GAP_PATTERN}
							width="5"
							height="5"
							patternUnits="userSpaceOnUse"
						>
							<circle cx="2.5" cy="2.5" r="1.25" className="fill-ink-faint" />
						</pattern>
					</defs>
					{buckets.map((bucket, index) => {
						const slot = plot.plotWidth / frame.count;
						const x = plot.left + index * slot;
						const parts = [
							{ key: "sampled", minutes: bucket.reachable },
							{ key: "outage", minutes: bucket.unreachable },
							{ key: "gap", minutes: bucket.missing },
						] as const;
						let below = 0;
						return parts.map((part) => {
							if (part.minutes <= 0) return null;
							const bottom = valueY((100 * below) / bucket.total, 100);
							below += part.minutes;
							const y = valueY((100 * below) / bucket.total, 100);
							return (
								<rect
									key={`${bucketStart(frame, index)}-${part.key}`}
									x={x}
									y={y}
									width={slot}
									height={Math.min(PLOT_HEIGHT, bottom - y)}
									className={STRIP_STYLES[part.key].className}
									data-part={part.key}
								/>
							);
						});
					})}
				</>
			)}
		</ChartShell>
	);
}

/** Running workspaces over the range. */
export function RunningChart({
	series,
	frame,
}: {
	series: HealthSeries;
	frame: ChartFrame;
}) {
	const running = dense(frame, series.platform, (point) => point.runningWorkspaces);
	return (
		<LineChart
			testId="health-chart-running"
			label="Running workspaces"
			frame={frame}
			series={[{ name: "Running", values: running }]}
			ticks={countTicks(Math.max(4, presentMax(running)))}
			format={formatCount}
			summary={lineSummary(running, formatCount)}
		/>
	);
}

/** Host CPU, network and disk over the range. */
export function HostRateCharts({
	series,
	frame,
}: {
	series: HealthSeries;
	frame: ChartFrame;
}) {
	const points = series.platform;
	const cpu = dense(frame, points, (point) => point.cpuPercent);
	const rx = dense(frame, points, (point) => point.netRxBytesPerSecond);
	const tx = dense(frame, points, (point) => point.netTxBytesPerSecond);
	const read = dense(frame, points, (point) => point.diskReadBytesPerSecond);
	const write = dense(frame, points, (point) => point.diskWriteBytesPerSecond);
	const network = rateScale(presentMax(rx, tx));
	const disk = rateScale(presentMax(read, write));
	const pair = (
		names: readonly [string, string],
		lines: readonly [(number | null)[], (number | null)[]],
		format: (value: number) => string,
	) =>
		lines.every((line) => line.every((value) => value === null))
			? "No samples in this range."
			: `${names[0]}: ${lineSummary(lines[0], format)} ${names[1]}: ${lineSummary(lines[1], format)}`;
	return (
		<>
			<LineChart
				testId="health-chart-cpu"
				label="Host CPU used, %"
				frame={frame}
				series={[{ name: "CPU", values: cpu }]}
				ticks={PERCENT_TICKS}
				format={formatPercent}
				summary={lineSummary(cpu, formatPercent)}
			/>
			<LineChart
				testId="health-chart-network"
				label={`Network on the default interface, ${network.unit}`}
				frame={frame}
				series={[
					{ name: "In", values: rx },
					{ name: "Out", values: tx },
				]}
				ticks={network.ticks}
				tickFormat={network.tick}
				format={network.format}
				summary={pair(["In", "Out"], [rx, tx], network.format)}
			/>
			<LineChart
				testId="health-chart-disk"
				label={`Disk, ${disk.unit}`}
				frame={frame}
				series={[
					{ name: "Read", values: read },
					{ name: "Write", values: write },
				]}
				ticks={disk.ticks}
				tickFormat={disk.tick}
				format={disk.format}
				summary={pair(["Read", "Write"], [read, write], disk.format)}
			/>
		</>
	);
}
