import { type ReactNode, useCallback, useId, useState } from "react";
import {
	bucketStart,
	type ChartFrame,
	readoutTime,
	tickText,
	timeLabel,
	timeTickIndexes,
} from "./scales.js";

/**
 * The SVG's vertical layout, in CSS pixels. The SVG is drawn at its real
 * width (see `Plot`), so text stays 12 px however wide the chart is.
 */
export const BOX = { height: 200, right: 12, top: 8, bottom: 26 };
export const PLOT_HEIGHT = BOX.height - BOX.top - BOX.bottom;

/** The width drawn before the chart has been measured, and in tests. */
export const DEFAULT_WIDTH = 560;

/** Axis text size in CSS pixels; nothing in the product is smaller than 12 px. */
export const AXIS_FONT = 12;

/** A generous width of one axis character at 12 px, digits being tabular. */
const CHAR_WIDTH = 7.5;

/** The horizontal layout of one chart at its measured width. */
export interface Plot {
	width: number;
	/** Where the plot starts: the Y-axis gutter, sized to the longest tick label. */
	left: number;
	plotWidth: number;
}

export function plotOf(width: number, tickLabels: readonly string[]): Plot {
	const longest = Math.max(1, ...tickLabels.map((label) => label.length));
	const left = Math.ceil(longest * CHAR_WIDTH) + 10;
	return { width, left, plotWidth: Math.max(1, width - left - BOX.right) };
}

/** X positions of the time labels, dropping any that would overlap the one before or pass either edge. */
export function timeLabelPositions(
	frame: ChartFrame,
	plot: Plot,
): { index: number; x: number; text: string }[] {
	const placed: { index: number; x: number; text: string }[] = [];
	let lastEnd = Number.NEGATIVE_INFINITY;
	for (const index of timeTickIndexes(frame)) {
		const text = timeLabel(bucketStart(frame, index), frame.range);
		const x = plot.left + (index * plot.plotWidth) / frame.count;
		const half = (text.length * CHAR_WIDTH) / 2;
		if (x - half < Math.max(0, lastEnd + 12) || x + half > plot.width) continue;
		placed.push({ index, x, text });
		lastEnd = x + half;
	}
	return placed;
}

/** One line or bar series and how it is drawn, so no series relies on colour. */
export interface SeriesStyle {
	/** Tailwind stroke or fill class from the existing tokens. */
	className: string;
	dash?: string;
}

/** Solid accent, then dashed, dotted and dash-dot, so no series relies on colour. */
export const LINE_STYLES: readonly SeriesStyle[] = [
	{ className: "stroke-accent" },
	{ className: "stroke-ink-muted", dash: "6 4" },
	{ className: "stroke-ink-muted", dash: "1 4" },
	{ className: "stroke-ink-muted", dash: "10 3 1 3" },
];

export function bucketCenterX(frame: ChartFrame, index: number, plot: Plot): number {
	return plot.left + ((index + 0.5) * plot.plotWidth) / frame.count;
}

export function valueY(value: number, top: number): number {
	const ratio = top > 0 ? Math.min(Math.max(value / top, 0), 1) : 0;
	return BOX.top + PLOT_HEIGHT - ratio * PLOT_HEIGHT;
}

/**
 * The keyboard cursor: Left and Right move one bucket, Home and End jump to
 * the ends. Returns the new index, or null for a key it does not handle.
 */
export function moveCursor(
	key: string,
	index: number | null,
	count: number,
): number | null {
	if (count === 0) return null;
	if (key === "Home") return 0;
	if (key === "End") return count - 1;
	if (key === "ArrowLeft") return index === null ? count - 1 : Math.max(0, index - 1);
	if (key === "ArrowRight")
		return index === null ? count - 1 : Math.min(count - 1, index + 1);
	return null;
}

export interface LegendEntry {
	name: string;
	style: SeriesStyle;
	/** Bars show a filled square rather than a line sample. */
	swatch?: "line" | "box";
}

/**
 * The parts every Health chart shares (SPEC.md section 25.6): a caption
 * that names the unit, one focusable plot whose SVG is `role="img"` named by
 * the summary, gridlines and bare-number Y ticks, X time labels, the cursor
 * with a hover and keyboard readout, a polite live region, the visible
 * summary, and a legend when there is more than one series. `children`
 * draws the data inside the plot box.
 *
 * With `empty` there is nothing to plot: no axis and no tab stop, only the
 * caption and the summary, which then says so ("No requests in this range.").
 *
 * `describe(index)` gives the readout's values for a bucket, such as "42%".
 * `onKey` lets a chart claim extra keys (a bar chart's Up, Down and Enter);
 * it returns true when it handled the key, or text to announce. `keysHint`
 * names those extra keys in the plot's name and under the chart.
 */
export function ChartShell({
	testId,
	label,
	frame,
	yTicks,
	formatTick = tickText,
	summary,
	empty = false,
	legend,
	describe,
	onKey,
	keysHint,
	children,
}: {
	testId: string;
	label: string;
	frame: ChartFrame;
	yTicks: readonly number[];
	/** A tick's text: a bare number, the unit being in `label`. */
	formatTick?: (value: number) => string;
	summary: string;
	empty?: boolean;
	legend?: readonly LegendEntry[];
	describe: (index: number) => string;
	onKey?: (key: string, index: number) => boolean | string;
	keysHint?: string;
	children: (cursor: number | null, plot: Plot) => ReactNode;
}) {
	const [cursor, setCursor] = useState<number | null>(null);
	const [announcement, setAnnouncement] = useState("");
	const [width, setWidth] = useState(DEFAULT_WIDTH);
	const summaryId = useId();
	const top = yTicks[yTicks.length - 1] ?? 1;

	// Draw at the real width before the first paint, then follow the pane.
	const measure = useCallback((box: HTMLDivElement | null) => {
		if (!box) return;
		const read = () => {
			const measured = Math.round(box.clientWidth);
			if (measured > 0) setWidth(measured);
		};
		read();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(read);
		observer.observe(box);
		return () => observer.disconnect();
	}, []);

	if (empty) {
		return (
			<figure className="m-0 min-w-0" data-testid={testId}>
				<figcaption className="pk-text-label text-ink-muted">{label}</figcaption>
				<p
					className="pk-text-body pk-muted m-0 mt-2 text-[13px]"
					data-testid={`${testId}-summary`}
				>
					{summary}
				</p>
			</figure>
		);
	}

	const tickLabels = yTicks.map(formatTick);
	const plot = plotOf(width, tickLabels);
	const readout =
		cursor === null
			? null
			: `${readoutTime(bucketStart(frame, cursor), frame.range)}, ${describe(cursor)}`;

	function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
		const handled = cursor === null ? false : onKey?.(event.key, cursor);
		if (handled) {
			event.preventDefault();
			if (typeof handled === "string") setAnnouncement(handled);
			return;
		}
		const next = moveCursor(event.key, cursor, frame.count);
		if (next === null) return;
		event.preventDefault();
		setCursor(next);
		setAnnouncement(
			`${readoutTime(bucketStart(frame, next), frame.range)}, ${describe(next)}`,
		);
	}

	function onMouseMove(event: React.MouseEvent<SVGSVGElement>) {
		const rect = event.currentTarget.getBoundingClientRect();
		if (rect.width === 0) return;
		const x = ((event.clientX - rect.left) / rect.width) * plot.width;
		const index = Math.floor(((x - plot.left) / plot.plotWidth) * frame.count);
		setCursor(index >= 0 && index < frame.count ? index : null);
	}

	const cursorX = cursor === null ? null : bucketCenterX(frame, cursor, plot);
	return (
		<figure className="m-0 min-w-0" data-testid={testId}>
			<figcaption className="pk-text-label text-ink-muted">{label}</figcaption>
			<div
				ref={measure}
				className="pk-focus-ring relative mt-2 rounded-sm"
				// "application" lets screen readers pass the arrow keys through.
				role="application"
				aria-roledescription="chart"
				// biome-ignore lint/a11y/noNoninteractiveTabindex: one tab stop per chart for the keyboard readout
				tabIndex={0}
				aria-label={`${label}, use the left and right arrow keys to read values${
					keysHint ? `, ${keysHint}` : ""
				}`}
				aria-describedby={summaryId}
				onKeyDown={onKeyDown}
				onBlur={() => setCursor(null)}
				data-testid={`${testId}-plot`}
			>
				<svg
					role="img"
					aria-label={`${label}: ${summary}`}
					viewBox={`0 0 ${plot.width} ${BOX.height}`}
					className="block h-auto w-full"
					onMouseMove={onMouseMove}
					onMouseLeave={() => setCursor(null)}
				>
					<rect
						x={plot.left}
						y={BOX.top}
						width={plot.plotWidth}
						height={PLOT_HEIGHT}
						className="fill-surface-raised"
					/>
					{yTicks.map((tick, index) => (
						<g key={tick}>
							<line
								x1={plot.left}
								x2={plot.left + plot.plotWidth}
								y1={valueY(tick, top)}
								y2={valueY(tick, top)}
								className="stroke-line"
								strokeWidth="1"
							/>
							<text
								x={plot.left - 6}
								y={valueY(tick, top)}
								textAnchor="end"
								dominantBaseline="middle"
								fontSize={AXIS_FONT}
								className="fill-ink-muted tabular-nums"
								data-axis="y"
							>
								{tickLabels[index]}
							</text>
						</g>
					))}
					{timeLabelPositions(frame, plot).map((tick) => (
						<text
							key={tick.index}
							x={tick.x}
							y={BOX.height - 8}
							textAnchor="middle"
							fontSize={AXIS_FONT}
							className="fill-ink-muted tabular-nums"
							data-axis="x"
						>
							{tick.text}
						</text>
					))}
					{children(cursor, plot)}
					{cursorX === null ? null : (
						<line
							x1={cursorX}
							x2={cursorX}
							y1={BOX.top}
							y2={BOX.top + PLOT_HEIGHT}
							className="stroke-ink"
							strokeWidth="1"
							data-testid={`${testId}-cursor`}
						/>
					)}
				</svg>
				{readout === null || cursorX === null ? null : (
					<div
						aria-hidden="true"
						className="pk-text-body pointer-events-none absolute top-0 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-sm border border-line bg-surface-raised px-2 py-1 text-[12px] shadow-md tabular-nums"
						style={{ left: `${(cursorX / plot.width) * 100}%` }}
						data-testid={`${testId}-readout`}
					>
						{readout}
					</div>
				)}
			</div>
			<p className="sr-only" aria-live="polite">
				{announcement}
			</p>
			{legend && legend.length > 1 ? <Legend entries={legend} /> : null}
			{/* Read through the plot's description, so not read twice. */}
			<p
				className="pk-text-body pk-muted m-0 mt-1 text-[12px]"
				aria-hidden="true"
				id={summaryId}
				data-testid={`${testId}-summary`}
			>
				{summary}
			</p>
			{keysHint ? (
				<p
					className="pk-text-body pk-muted m-0 mt-1 text-[12px]"
					aria-hidden="true"
					data-testid={`${testId}-keys`}
				>
					Keyboard: left and right arrows read values, {keysHint}.
				</p>
			) : null}
		</figure>
	);
}

function Legend({ entries }: { entries: readonly LegendEntry[] }) {
	return (
		<ul className="m-0 mt-2 flex list-none flex-wrap gap-4 p-0 text-[12px]">
			{entries.map((entry) => (
				<li key={entry.name} className="flex items-center gap-1.5">
					<svg width="24" height="10" aria-hidden="true">
						{entry.swatch === "box" ? (
							<rect
								x="7"
								y="0"
								width="10"
								height="10"
								className={entry.style.className}
							/>
						) : (
							<line
								x1="1"
								x2="23"
								y1="5"
								y2="5"
								strokeWidth="2"
								strokeLinecap="round"
								strokeDasharray={entry.style.dash}
								className={entry.style.className}
							/>
						)}
					</svg>
					{entry.name}
				</li>
			))}
		</ul>
	);
}
