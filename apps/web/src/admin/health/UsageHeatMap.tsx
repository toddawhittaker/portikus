import type { HealthSeries } from "@portikus/contracts";
import { Button } from "@portikus/ui";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import {
	bucketPhrase,
	bucketStart,
	type ChartFrame,
	dense,
	readoutTime,
} from "./charts/scales.js";

type Measure = "cpu" | "memory";
type Row = HealthSeries["usage"]["workspaces"][number];

/** The API's row cap (docs/EPIC-19.md ruling 18). */
export const HEAT_MAP_MAX_ROWS = 50;

/** Accent steps for values under the threshold, lightest first. */
const STEPS = ["bg-accent/10", "bg-accent/30", "bg-accent/55", "bg-accent/80"];

/** Stripes over the warning colour, so "at the threshold" is not colour alone. */
const HATCH = {
	backgroundImage:
		"repeating-linear-gradient(45deg, var(--status-warning) 0 3px, var(--surface-raised) 3px 5px)",
};

/** The shade class for a value under the threshold: four even steps of 0 to 100%. */
export function stepClass(value: number): string {
	const index = Math.min(STEPS.length - 1, Math.max(0, Math.floor(value / 25)));
	return STEPS[index] as string;
}

/** One cell's text, which the table reads out and the hover shows. */
export function cellText(value: number | null, threshold: number): string {
	if (value === null) return "no data";
	const text = `${Math.round(value)}%`;
	return value >= threshold ? `${text}, at or over the ${threshold}% threshold` : text;
}

/**
 * Per-workspace CPU or memory as a grid: one row per workspace, one cell per
 * bucket (SPEC.md §25.6, #598 item 3). It is an HTML table, so a screen
 * reader walks it by row and column and hears each value; a cell at or over
 * the workspace's guard threshold is hatched as well as coloured.
 */
export function UsageHeatMap({
	series,
	frame,
}: {
	series: HealthSeries;
	frame: ChartFrame;
}) {
	const [measure, setMeasure] = useState<Measure>("cpu");
	const usage = series.usage;
	const bucketMs = frame.bucketSeconds * 1000;
	const first = Math.max(
		0,
		Math.round((Date.parse(usage.from) - frame.from) / bucketMs),
	);
	const columns = Array.from(
		{ length: Math.max(0, frame.count - first) },
		(_, i) => first + i,
	);
	const rangeMinutes = (frame.count * frame.bucketSeconds) / 60;
	const name = measure === "cpu" ? "CPU" : "memory";
	const per = bucketPhrase(frame.bucketSeconds);

	return (
		<figure
			className="m-0 min-w-0 min-[1280px]:col-span-2"
			data-testid="health-heat-map"
		>
			<div className="flex flex-wrap items-center justify-between gap-3">
				<figcaption className="pk-text-label text-ink-muted">
					Per-workspace {name}, highest {per}
				</figcaption>
				<fieldset className="pk-actions m-0 border-0 p-0">
					<legend className="sr-only">Heat map measure</legend>
					{(["cpu", "memory"] as const).map((option) => (
						<Button
							key={option}
							size="sm"
							variant={option === measure ? "primary" : "secondary"}
							aria-pressed={option === measure}
							onClick={() => setMeasure(option)}
						>
							{option === "cpu" ? "CPU" : "Memory"}
						</Button>
					))}
				</fieldset>
			</div>
			<p className="pk-text-body pk-muted m-0 mt-1 text-[12px]">
				Only running and recently running workspaces appear; a stopped workspace's
				figures are removed.
				{rangeMinutes > usage.retentionMinutes ? (
					<span data-testid="health-heat-map-retention">
						{" "}
						Per-workspace figures are kept for about{" "}
						{Math.round(usage.retentionMinutes / 60)} hours.
					</span>
				) : null}
				{usage.workspaces.length >= HEAT_MAP_MAX_ROWS ? (
					<span data-testid="health-heat-map-capped">
						{" "}
						Showing the {HEAT_MAP_MAX_ROWS} workspaces with the highest peaks.
					</span>
				) : null}
			</p>
			{usage.workspaces.length === 0 ? (
				<p className="pk-text-body m-0 mt-2" data-testid="health-heat-map-empty">
					No workspace has usage figures in this range.
				</p>
			) : (
				<>
					<div className="mt-2 overflow-x-auto">
						<table className="w-full table-fixed border-collapse text-[12px]">
							<caption className="sr-only">
								Per-workspace {name}, highest {per}
							</caption>
							<thead>
								<tr>
									<th scope="col" className="w-40 text-left font-normal text-ink-muted">
										Owner
									</th>
									{columns.map((index) => (
										<th key={index} scope="col" className="p-0">
											<span className="sr-only">
												{readoutTime(bucketStart(frame, index), frame.range)}
											</span>
										</th>
									))}
									<th
										scope="col"
										className="w-14 text-right font-normal text-ink-muted"
									>
										Peak
									</th>
								</tr>
							</thead>
							<tbody>
								{usage.workspaces.map((row) => (
									<HeatRow
										key={row.workspaceId}
										row={row}
										measure={measure}
										frame={frame}
										columns={columns}
									/>
								))}
							</tbody>
						</table>
					</div>
					<HeatLegend />
				</>
			)}
		</figure>
	);
}

function HeatRow({
	row,
	measure,
	frame,
	columns,
}: {
	row: Row;
	measure: Measure;
	frame: ChartFrame;
	columns: readonly number[];
}) {
	const threshold =
		measure === "cpu" ? row.cpuThresholdPercent : row.memoryThresholdPercent;
	const values = dense(frame, row.cells, (cell) =>
		measure === "cpu" ? cell.cpuPercent : cell.memoryPercent,
	);
	const present = values.filter((value): value is number => value !== null);
	const peak = present.length > 0 ? Math.max(...present) : null;
	return (
		<tr data-testid="health-heat-map-row">
			<th scope="row" className="truncate py-0.5 pr-2 text-left font-normal">
				<Link
					to="/admin"
					search={{ tab: "workspaces", user: row.owner.id }}
					className="pk-link text-[var(--accent-text)] underline"
				>
					{row.owner.displayName}
				</Link>
			</th>
			{columns.map((index) => {
				const value = values[index] ?? null;
				const text = cellText(value, threshold);
				const over = value !== null && value >= threshold;
				const shade = value === null || over ? "" : stepClass(value);
				return (
					<td key={index} className="p-px" title={text}>
						<div
							className={`h-4 rounded-[2px] ${shade}`}
							style={over ? HATCH : undefined}
							data-over={over ? "true" : undefined}
						>
							<span className="sr-only">{text}</span>
						</div>
					</td>
				);
			})}
			<td className="pk-num text-right tabular-nums">
				{peak === null ? "none" : `${Math.round(peak)}%`}
			</td>
		</tr>
	);
}

function HeatLegend() {
	const swatch = "inline-block h-3 w-3 rounded-[2px] border border-line";
	return (
		<ul
			className="m-0 mt-2 flex list-none flex-wrap gap-4 p-0 text-[12px]"
			aria-hidden="true"
		>
			<li className="flex items-center gap-1.5">
				{STEPS.map((step) => (
					<span key={step} className={`${swatch} ${step}`} />
				))}
				0 to 100%
			</li>
			<li className="flex items-center gap-1.5">
				<span className={swatch} style={HATCH} />
				At or over the workspace's guard threshold
			</li>
		</ul>
	);
}
