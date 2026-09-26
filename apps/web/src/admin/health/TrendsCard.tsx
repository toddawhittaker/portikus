import { ApiError } from "../../api/request.js";
import { ApiCharts } from "./ApiCharts.js";
import { frameOf } from "./charts/scales.js";
import { EventCharts } from "./EventCharts.js";
import { HostCharts } from "./HostCharts.js";
import { LogCharts } from "./LogCharts.js";
import { PlatformCharts } from "./PlatformCharts.js";
import { useHealthSeries } from "./queries.js";
import { RangeControl, useHealthRange } from "./RangeControl.js";
import { UsageHeatMap } from "./UsageHeatMap.js";

/**
 * The Trends card: the range control and every chart for that range, two
 * per row from 1280 px (docs/EPIC-19.md rulings 5, 6 and 9).
 */
export function TrendsCard({ warnPercent }: { warnPercent: number }) {
	const [range, setRange] = useHealthRange();
	const series = useHealthSeries(range);
	const data = series.data;
	const frame = data ? frameOf(data) : null;
	return (
		<section className="pk-card p-6" aria-labelledby="health-trends-title">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<h3 className="pk-text-heading m-0" id="health-trends-title">
					Trends
				</h3>
				<RangeControl range={range} onChange={setRange} />
			</div>
			{series.isError ? (
				<p className="pk-error m-0 mt-4 text-status-error" role="alert">
					{series.error instanceof ApiError
						? series.error.message
						: "The trends could not be loaded."}
				</p>
			) : data && frame ? (
				<div
					className="mt-4 grid grid-cols-1 gap-x-8 gap-y-6 min-[1280px]:grid-cols-2"
					data-testid="health-trends"
					aria-busy={series.isPlaceholderData}
				>
					<HostCharts series={data} frame={frame} warnPercent={warnPercent} />
					<PlatformCharts series={data} frame={frame} />
					<ApiCharts series={data} frame={frame} />
					<LogCharts range={range} />
					<EventCharts series={data} frame={frame} />
					<UsageHeatMap series={data} frame={frame} />
				</div>
			) : (
				<div
					aria-busy="true"
					className="mt-4 h-40"
					data-testid="health-trends-loading"
				/>
			)}
		</section>
	);
}
