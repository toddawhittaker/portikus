import { type ReactNode, useState } from "react";
import { ApiError } from "../../api/request.js";
import { ApiCharts } from "./ApiCharts.js";
import { frameOf } from "./charts/scales.js";
import { EventCharts } from "./EventCharts.js";
import { HostCharts } from "./HostCharts.js";
import { LogCharts } from "./LogCharts.js";
import { AvailabilityStrip, HostRateCharts, RunningChart } from "./PlatformCharts.js";
import { useHealthSeries } from "./queries.js";
import { RangeControl, useHealthRange } from "./RangeControl.js";
import { UsageHeatMap } from "./UsageHeatMap.js";

const GROUP_STORAGE_PREFIX = "portikus.admin.healthGroup.";

/** Whether a group was left open; open unless this browser closed it. */
export function readGroupOpen(id: string): boolean {
	try {
		return localStorage.getItem(GROUP_STORAGE_PREFIX + id) !== "closed";
	} catch {
		return true;
	}
}

function storeGroupOpen(id: string, open: boolean): void {
	try {
		if (open) localStorage.removeItem(GROUP_STORAGE_PREFIX + id);
		else localStorage.setItem(GROUP_STORAGE_PREFIX + id, "closed");
	} catch {
		// A browser that refuses storage still toggles for this visit.
	}
}

/**
 * One group of charts as a native disclosure, open by default and remembered
 * per browser. A closed group draws nothing, so its charts cost no work.
 */
function TrendGroup({
	id,
	title,
	children,
}: {
	id: string;
	title: string;
	children: ReactNode;
}) {
	const [open, setOpen] = useState(() => readGroupOpen(id));
	return (
		<details
			className="border-line border-t pt-3"
			open={open}
			onToggle={(event) => {
				const next = event.currentTarget.open;
				if (next === open) return;
				setOpen(next);
				storeGroupOpen(id, next);
			}}
			data-testid={`health-group-${id}`}
		>
			<summary className="pk-summary cursor-pointer rounded-sm">
				<h4 className="pk-text-compact m-0 inline font-semibold">{title}</h4>
			</summary>
			{open ? (
				<div className="mt-3 grid grid-cols-[repeat(auto-fill,minmax(min(100%,400px),1fr))] gap-x-8 gap-y-6">
					{children}
				</div>
			) : null}
		</details>
	);
}

/**
 * The Trends card: the range control, then the charts for that range in
 * four groups, Host, Workspaces, API and Events (SPEC.md section 25.6).
 * Charts sit as many to a row as fit at 400 px or more.
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
					className="mt-4 flex flex-col gap-4"
					data-testid="health-trends"
					aria-busy={series.isPlaceholderData}
				>
					<TrendGroup id="host" title="Host">
						<HostCharts series={data} frame={frame} warnPercent={warnPercent} />
						<HostRateCharts series={data} frame={frame} />
					</TrendGroup>
					<TrendGroup id="workspaces" title="Workspaces">
						<RunningChart series={data} frame={frame} />
						<UsageHeatMap series={data} frame={frame} />
					</TrendGroup>
					<TrendGroup id="api" title="API">
						<ApiCharts series={data} frame={frame} />
					</TrendGroup>
					<TrendGroup id="events" title="Events">
						<LogCharts range={range} />
						<EventCharts series={data} frame={frame} />
						<AvailabilityStrip frame={frame} points={data.platform} />
					</TrendGroup>
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
