import type { HealthSeries } from "@portikus/contracts";
import { Button } from "@portikus/ui";
import { Link } from "@tanstack/react-router";
import { memo, useId, useMemo, useState } from "react";
import { moveCursor } from "./charts/readout.js";
import {
	bucketPhrase,
	bucketStart,
	type ChartFrame,
	dense,
	readoutTime,
} from "./charts/scales.js";

type Measure = "cpu" | "memory";
type Row = HealthSeries["usage"]["workspaces"][number];

/** The API's row cap (SPEC.md section 25.6). */
const HEAT_MAP_MAX_ROWS = 50;

/** Accent steps for values under the threshold, lightest first. */
const STEPS = ["bg-accent/10", "bg-accent/30", "bg-accent/55", "bg-accent/80"];

/** Filled cells get a strong outline, so even the lightest step stands apart from "no data" (WCAG 1.4.11). */
const FILLED = "border border-line-strong";

/** No data: an empty cell with a small centred dot. */
const NO_DATA = {
	backgroundImage:
		"radial-gradient(circle, var(--ink-muted) 1.25px, transparent 1.5px)",
};

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

/** The keyboard cursor's cell: a row of the table and a position among its bucket columns. */
export interface Cell {
	row: number;
	column: number;
}

/**
 * The heat map's keyboard cursor: Up and Down move a row, Left, Right, Home
 * and End move along it as the charts' cursor does. The first key lands on
 * the newest bucket of the first row. Returns null for a key it does not handle.
 */
export function moveCell(
	key: string,
	cell: Cell | null,
	rowCount: number,
	columnCount: number,
): Cell | null {
	if (rowCount === 0 || columnCount === 0) return null;
	const row = cell?.row ?? 0;
	if (key === "ArrowUp" || key === "ArrowDown") {
		const column = cell?.column ?? columnCount - 1;
		if (cell === null) return { row, column };
		const next = key === "ArrowUp" ? row - 1 : row + 1;
		return { row: Math.min(rowCount - 1, Math.max(0, next)), column };
	}
	const column = moveCursor(key, cell?.column ?? null, columnCount);
	return column === null ? null : { row, column };
}

/**
 * Per-workspace CPU or memory as a grid: one row per workspace, one cell per
 * bucket (SPEC.md §25.6). It is an HTML table, so a screen
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
	// Kept stable, so the memoised rows skip a redraw when only the cursor moves.
	const columns = useMemo(
		() => Array.from({ length: Math.max(0, frame.count - first) }, (_, i) => first + i),
		[first, frame.count],
	);
	const rangeMinutes = (frame.count * frame.bucketSeconds) / 60;
	const name = measure === "cpu" ? "CPU" : "memory";
	const per = bucketPhrase(frame.bucketSeconds);
	const captionId = useId();
	// Held as a workspace and a bucket time, so a refresh that reorders the rows
	// or slides the window along keeps the cursor on the same figure.
	const [cursor, setCursor] = useState<{ workspaceId: string; time: number } | null>(
		null,
	);
	const [announcement, setAnnouncement] = useState("");
	const rows = useMemo(
		() =>
			usage.workspaces.map((row) => {
				const values = dense(frame, row.cells, (cell) =>
					measure === "cpu" ? cell.cpuPercent : cell.memoryPercent,
				);
				const threshold =
					measure === "cpu" ? row.cpuThresholdPercent : row.memoryThresholdPercent;
				return { row, values, threshold };
			}),
		[usage.workspaces, frame, measure],
	);

	/** "Ann Lee, 14:05, 85%, at or over the 80% threshold", or null off the table. */
	function readoutOf(cell: Cell): string | null {
		const entry = rows[cell.row];
		const index = columns[cell.column];
		if (!entry || index === undefined) return null;
		return `${entry.row.owner.displayName}, ${readoutTime(
			bucketStart(frame, index),
			frame.range,
		)}, ${cellText(entry.values[index] ?? null, entry.threshold)}`;
	}

	/** Where the cursor sits in the table now, or null once its row or bucket has gone. */
	function cellOf(held: typeof cursor): Cell | null {
		if (held === null) return null;
		const row = rows.findIndex((entry) => entry.row.workspaceId === held.workspaceId);
		const column = columns.findIndex(
			(index) => bucketStart(frame, index) === held.time,
		);
		return row < 0 || column < 0 ? null : { row, column };
	}

	function onKeyDown(event: React.KeyboardEvent<HTMLTableElement>) {
		// Keys meant for a link inside the table stay with it.
		if (event.target !== event.currentTarget) return;
		const next = moveCell(event.key, cellOf(cursor), rows.length, columns.length);
		const entry = next === null ? undefined : rows[next.row];
		const index = next === null ? undefined : columns[next.column];
		if (next === null || entry === undefined || index === undefined) return;
		event.preventDefault();
		setCursor({ workspaceId: entry.row.workspaceId, time: bucketStart(frame, index) });
		setAnnouncement(readoutOf(next) ?? "");
	}

	const cell = cellOf(cursor);
	const readout = cell === null ? null : readoutOf(cell);

	return (
		<figure
			className="col-span-full m-0 min-w-0"
			data-testid="health-heat-map"
			aria-labelledby={captionId}
		>
			<div className="flex flex-wrap items-center justify-between gap-3">
				<figcaption id={captionId} className="pk-text-label text-ink-muted">
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
					<div className="mt-1 overflow-x-auto p-1">
						{/* One tab stop for the whole map; a screen reader still walks it as a table. */}
						<table
							className="pk-focus-ring w-full table-fixed border-collapse rounded-sm text-[12px]"
							// biome-ignore lint/a11y/noNoninteractiveTabindex: one tab stop for the keyboard cursor, as the charts have
							tabIndex={0}
							onKeyDown={onKeyDown}
							onBlur={() => setCursor(null)}
							data-testid="health-heat-map-table"
						>
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
								{rows.map((entry, rowIndex) => (
									<HeatRow
										key={entry.row.workspaceId}
										row={entry.row}
										values={entry.values}
										threshold={entry.threshold}
										columns={columns}
										cursorColumn={cell?.row === rowIndex ? cell.column : null}
									/>
								))}
							</tbody>
						</table>
					</div>
					{/* Always one line high, so the legend does not jump as the cursor comes and goes. */}
					<p
						className="pk-text-body m-0 mt-1 min-h-4 text-[12px] tabular-nums"
						aria-hidden="true"
						data-testid="health-heat-map-readout"
					>
						{readout ?? (
							<span className="pk-muted">
								Keyboard: focus the map, then use the arrow keys to read each value.
							</span>
						)}
					</p>
					<p className="sr-only" aria-live="polite">
						{announcement}
					</p>
					<HeatLegend />
				</>
			)}
		</figure>
	);
}

/** Memoised, so moving the cursor redraws only the rows it leaves and enters. */
const HeatRow = memo(function HeatRow({
	row,
	values,
	threshold,
	columns,
	cursorColumn,
}: {
	row: Row;
	values: readonly (number | null)[];
	threshold: number;
	columns: readonly number[];
	cursorColumn: number | null;
}) {
	const present = values.filter((value): value is number => value !== null);
	const peak = present.length > 0 ? Math.max(...present) : null;
	return (
		<tr data-testid="health-heat-map-row">
			<th scope="row" className="truncate py-0.5 pr-2 text-left font-normal">
				<Link
					to="/admin/$tab"
					params={{ tab: "users" }}
					search={{ user: row.owner.id }}
					className="pk-link"
				>
					{row.owner.displayName}
				</Link>
			</th>
			{columns.map((index, position) => {
				const value = values[index] ?? null;
				const text = cellText(value, threshold);
				const over = value !== null && value >= threshold;
				const shade = value === null || over ? "" : stepClass(value);
				const current = position === cursorColumn;
				return (
					<td key={index} className="p-px" title={text}>
						<div
							className={`h-4 rounded-[2px] ${value === null ? "" : FILLED} ${shade} ${
								current ? "outline-2 outline-offset-1 outline-ink outline-solid" : ""
							}`}
							data-cursor={current ? "true" : undefined}
							style={over ? HATCH : value === null ? NO_DATA : undefined}
							data-over={over ? "true" : undefined}
							data-empty={value === null ? "true" : undefined}
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
});

function HeatLegend() {
	const swatch = "inline-block h-3 w-3 rounded-[2px] border border-line";
	return (
		<ul
			className="m-0 mt-2 flex list-none flex-wrap gap-4 p-0 text-[12px]"
			aria-hidden="true"
		>
			<li className="flex items-center gap-1.5">
				{STEPS.map((step) => (
					<span key={step} className={`${swatch} border-line-strong ${step}`} />
				))}
				0 to 100%
			</li>
			<li className="flex items-center gap-1.5">
				<span className={swatch} style={NO_DATA} />
				No data
			</li>
			<li className="flex items-center gap-1.5">
				<span className={swatch} style={HATCH} />
				At or over the workspace's guard threshold
			</li>
		</ul>
	);
}
