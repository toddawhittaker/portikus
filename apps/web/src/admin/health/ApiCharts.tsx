import type { HealthSeries } from "@portikus/contracts";
import { LineChart } from "./charts/LineChart.js";
import { type ChartFrame, dense, lineSummary, yTicks } from "./charts/scales.js";

function present(values: readonly (number | null)[]): number[] {
	return values.filter((value): value is number => value !== null);
}

export function formatRate(value: number): string {
	const rounded = value >= 10 ? Math.round(value) : Math.round(value * 10) / 10;
	return `${rounded.toLocaleString("en-US")}/min`;
}

export function formatShare(value: number): string {
	return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10}%`;
}

export function formatMs(value: number): string {
	return `${Math.round(value).toLocaleString("en-US")} ms`;
}

/**
 * The API's request rate, error rate and response time over the range
 * (docs/EPIC-19.md ruling 25, issue #599).
 */
export function ApiCharts({
	series,
	frame,
}: {
	series: HealthSeries;
	frame: ChartFrame;
}) {
	const minutes = frame.bucketSeconds / 60;
	const rate = dense(frame, series.api, (point) => point.requests / minutes);
	const share = (count: number, requests: number) =>
		requests === 0 ? null : (100 * count) / requests;
	const clientErrors = dense(frame, series.api, (point) =>
		share(point.clientErrors, point.requests),
	);
	const serverErrors = dense(frame, series.api, (point) =>
		share(point.serverErrors, point.requests),
	);
	const median = dense(frame, series.api, (point) => point.medianMs);
	const p95 = dense(frame, series.api, (point) => point.p95Ms);
	const upgrades = series.api.reduce((sum, point) => sum + point.webSocketUpgrades, 0);
	const errors = [...present(clientErrors), ...present(serverErrors)];
	const times = [...present(median), ...present(p95)];

	return (
		<>
			<LineChart
				testId="health-chart-api-requests"
				label="API requests"
				frame={frame}
				series={[{ name: "Requests", values: rate }]}
				ticks={yTicks(Math.max(1, ...present(rate)))}
				format={formatRate}
				summary={`${lineSummary(rate, formatRate)} ${upgrades.toLocaleString("en-US")} WebSocket upgrade${upgrades === 1 ? "" : "s"} in this range.`}
			/>
			<LineChart
				testId="health-chart-api-errors"
				label="API error rate"
				frame={frame}
				series={[
					{ name: "4xx", values: clientErrors },
					{ name: "5xx", values: serverErrors },
				]}
				ticks={yTicks(Math.max(1, ...errors))}
				format={formatShare}
				summary={
					errors.length === 0
						? "No requests in this range."
						: `4xx: ${lineSummary(clientErrors, formatShare)} 5xx: ${lineSummary(serverErrors, formatShare)}`
				}
			/>
			<LineChart
				testId="health-chart-api-latency"
				label="API response time"
				frame={frame}
				series={[
					{ name: "Median", values: median },
					{ name: "95th percentile", values: p95 },
				]}
				ticks={yTicks(Math.max(1, ...times))}
				format={formatMs}
				summary={
					times.length === 0
						? "No requests in this range."
						: `Median: ${lineSummary(median, formatMs)} 95th percentile: ${lineSummary(p95, formatMs)}`
				}
			/>
		</>
	);
}
