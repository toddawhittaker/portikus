import type { HealthSeries } from "@portikus/contracts";
import { LineChart } from "./charts/LineChart.js";
import {
	type ChartFrame,
	dense,
	lineSummary,
	PERCENT_TICKS,
	yTicks,
} from "./charts/scales.js";

export function formatPercent(value: number): string {
	return `${Math.round(value)}%`;
}

export function formatLoad(value: number): string {
	return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

/** Storage pool, memory and load over the range (SPEC.md §25.6, #598 item 1). */
export function HostCharts({
	series,
	frame,
	warnPercent,
}: {
	series: HealthSeries;
	frame: ChartFrame;
	/** Where the pool and memory warnings start, drawn as a threshold line. */
	warnPercent: number;
}) {
	const pool = dense(frame, series.host, (point) => point.poolPercent);
	const memory = dense(frame, series.host, (point) => point.memoryPercent);
	const load1 = dense(frame, series.host, (point) => point.load1);
	const load5 = dense(frame, series.host, (point) => point.load5);
	const load15 = dense(frame, series.host, (point) => point.load15);
	const loads = [...load1, ...load5, ...load15].filter(
		(value): value is number => value !== null,
	);
	const cpus = series.cpuCount;
	const threshold = [{ value: warnPercent, label: `${warnPercent}% warning` }];
	return (
		<>
			<LineChart
				testId="health-chart-pool"
				label="Storage pool used"
				frame={frame}
				series={[{ name: "Pool", values: pool }]}
				ticks={PERCENT_TICKS}
				format={formatPercent}
				summary={lineSummary(pool, formatPercent)}
				references={threshold}
			/>
			<LineChart
				testId="health-chart-memory"
				label="Memory used"
				frame={frame}
				series={[{ name: "Memory", values: memory }]}
				ticks={PERCENT_TICKS}
				format={formatPercent}
				summary={lineSummary(memory, formatPercent)}
				references={threshold}
			/>
			<LineChart
				testId="health-chart-load"
				label="Load average"
				frame={frame}
				series={[
					{ name: "1 minute", values: load1 },
					{ name: "5 minutes", values: load5 },
					{ name: "15 minutes", values: load15 },
				]}
				ticks={yTicks(Math.max(cpus ?? 1, ...loads))}
				format={formatLoad}
				summary={`${lineSummary(load1, (value) => value.toFixed(2))}${
					cpus ? ` ${cpus} CPU${cpus === 1 ? "" : "s"}.` : ""
				}`}
				references={
					cpus ? [{ value: cpus, label: `${cpus} CPU${cpus === 1 ? "" : "s"}` }] : []
				}
			/>
		</>
	);
}
