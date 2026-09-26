import type { HealthSeries } from "@portikus/contracts";
import { LineChart } from "./charts/LineChart.js";
import {
	BOX,
	ChartShell,
	PLOT_HEIGHT,
	PLOT_WIDTH,
	type SeriesStyle,
	valueY,
} from "./charts/readout.js";
import {
	bucketStart,
	type ChartFrame,
	dense,
	lineSummary,
	PERCENT_TICKS,
	yTicks,
} from "./charts/scales.js";
import { formatPercent } from "./HostCharts.js";

type PlatformPoint = HealthSeries["platform"][number];

const RATE_UNITS = ["B/s", "KB/s", "MB/s", "GB/s"] as const;

/**
 * Y ticks and a formatter for bytes per second, both in one unit picked from
 * the largest value, so the ticks read "0, 250, 500 KB/s" and not raw bytes.
 */
export function rateScale(max: number): {
	ticks: number[];
	format: (value: number) => string;
} {
	let power = 0;
	while (max >= 1024 ** (power + 1) && power < RATE_UNITS.length - 1) power += 1;
	const unit = 1024 ** power;
	const name = RATE_UNITS[power];
	return {
		ticks: yTicks(max / unit).map((tick) => tick * unit),
		format: (value) => {
			const scaled = value / unit;
			return `${Number.isInteger(scaled) ? scaled : scaled.toFixed(1)} ${name}`;
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
 * The availability strip (docs/EPIC-19.md ruling 14): each bucket is a
 * column filled by its share of minutes. Outages and missing samples use
 * status-error with a stripe or a dot pattern, so they never rely on colour.
 */
function AvailabilityStrip({
	frame,
	points,
}: {
	frame: ChartFrame;
	points: readonly PlatformPoint[];
}) {
	const buckets = stripMinutes(frame, points);
	const slot = PLOT_WIDTH / frame.count;
	function describe(index: number): string {
		const bucket = buckets[index];
		if (!bucket) return "no data";
		const sampled = bucket.total - bucket.missing;
		return `samples in ${sampled} of ${bucket.total} minutes, controller unreachable for ${bucket.unreachable}`;
	}
	return (
		<ChartShell
			testId="health-chart-availability"
			label="Sampling and controller availability"
			frame={frame}
			yTicks={[0, 50, 100]}
			formatTick={formatPercent}
			summary={stripSummary(frame, points)}
			describe={describe}
			legend={[
				{ name: "Sampled", style: STRIP_STYLES.sampled, swatch: "box" },
				{ name: "Controller unreachable", style: STRIP_STYLES.outage, swatch: "box" },
				{ name: "No sample", style: STRIP_STYLES.gap, swatch: "box" },
			]}
		>
			{() => (
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
							<circle cx="2.5" cy="2.5" r="1.25" className="fill-status-error" />
						</pattern>
					</defs>
					{buckets.map((bucket, index) => {
						const x = BOX.left + index * slot;
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

/**
 * The platform family of the Trends card (#598 items 2, 6, 7 and 8):
 * availability, running workspaces, host CPU, network and disk.
 */
export function PlatformCharts({
	series,
	frame,
}: {
	series: HealthSeries;
	frame: ChartFrame;
}) {
	const points = series.platform;
	const running = dense(frame, points, (point) => point.runningWorkspaces);
	const cpu = dense(frame, points, (point) => point.cpuPercent);
	const rx = dense(frame, points, (point) => point.netRxBytesPerSecond);
	const tx = dense(frame, points, (point) => point.netTxBytesPerSecond);
	const read = dense(frame, points, (point) => point.diskReadBytesPerSecond);
	const write = dense(frame, points, (point) => point.diskWriteBytesPerSecond);
	const network = rateScale(presentMax(rx, tx));
	const disk = rateScale(presentMax(read, write));
	return (
		<>
			<AvailabilityStrip frame={frame} points={points} />
			<LineChart
				testId="health-chart-running"
				label="Running workspaces"
				frame={frame}
				series={[{ name: "Running", values: running }]}
				ticks={yTicks(Math.max(4, presentMax(running)))}
				format={formatCount}
				summary={lineSummary(running, formatCount)}
			/>
			<LineChart
				testId="health-chart-cpu"
				label="Host CPU used"
				frame={frame}
				series={[{ name: "CPU", values: cpu }]}
				ticks={PERCENT_TICKS}
				format={formatPercent}
				summary={lineSummary(cpu, formatPercent)}
			/>
			<LineChart
				testId="health-chart-network"
				label="Network, default interface"
				frame={frame}
				series={[
					{ name: "In", values: rx },
					{ name: "Out", values: tx },
				]}
				ticks={network.ticks}
				format={network.format}
				summary={`In: ${lineSummary(rx, network.format)} Out: ${lineSummary(tx, network.format)}`}
			/>
			<LineChart
				testId="health-chart-disk"
				label="Disk"
				frame={frame}
				series={[
					{ name: "Read", values: read },
					{ name: "Write", values: write },
				]}
				ticks={disk.ticks}
				format={disk.format}
				summary={`Read: ${lineSummary(read, disk.format)} Write: ${lineSummary(write, disk.format)}`}
			/>
		</>
	);
}
