import { type ReactNode, useId, useState } from "react";
import {
	bucketStart,
	type ChartFrame,
	readoutTime,
	timeLabel,
	timeTickIndexes,
} from "./scales.js";

/** The SVG's drawing box. Plot height is about 160 px at 1:1. */
export const BOX = { width: 560, height: 200, left: 48, right: 12, top: 8, bottom: 26 };
export const PLOT_WIDTH = BOX.width - BOX.left - BOX.right;
export const PLOT_HEIGHT = BOX.height - BOX.top - BOX.bottom;

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

export function bucketCenterX(frame: ChartFrame, index: number): number {
	return BOX.left + ((index + 0.5) * PLOT_WIDTH) / frame.count;
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
 * The parts every Health chart shares (docs/EPIC-19.md ruling 8): a caption,
 * one focusable plot whose SVG is `role="img"` named by the summary, gridlines
 * and Y ticks, X time labels, the cursor with a hover and keyboard readout,
 * a polite live region, the visible summary, and a legend when there is more
 * than one series. `children` draws the data inside the plot box.
 *
 * `describe(index)` gives the readout's values for a bucket, such as "42%".
 * `onKey` lets a chart claim extra keys (a bar chart's Up, Down and Enter);
 * it returns true when it handled the key.
 */
export function ChartShell({
	testId,
	label,
	frame,
	yTicks,
	formatTick,
	summary,
	legend,
	describe,
	onKey,
	children,
}: {
	testId: string;
	label: string;
	frame: ChartFrame;
	yTicks: readonly number[];
	formatTick: (value: number) => string;
	summary: string;
	legend?: readonly LegendEntry[];
	describe: (index: number) => string;
	onKey?: (key: string, index: number) => boolean;
	children: (cursor: number | null) => ReactNode;
}) {
	const [cursor, setCursor] = useState<number | null>(null);
	const [announcement, setAnnouncement] = useState("");
	const summaryId = useId();
	const top = yTicks[yTicks.length - 1] ?? 1;

	const readout =
		cursor === null
			? null
			: `${readoutTime(bucketStart(frame, cursor), frame.range)}, ${describe(cursor)}`;

	function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
		if (cursor !== null && onKey?.(event.key, cursor)) {
			event.preventDefault();
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
		const x = ((event.clientX - rect.left) / rect.width) * BOX.width;
		const index = Math.floor(((x - BOX.left) / PLOT_WIDTH) * frame.count);
		setCursor(index >= 0 && index < frame.count ? index : null);
	}

	const cursorX = cursor === null ? null : bucketCenterX(frame, cursor);
	return (
		<figure className="m-0 min-w-0" data-testid={testId}>
			<figcaption className="pk-text-label text-ink-muted">{label}</figcaption>
			<div
				className="pk-focus-ring relative mt-2 rounded-sm"
				// "application" lets screen readers pass the arrow keys through.
				role="application"
				aria-roledescription="chart"
				// biome-ignore lint/a11y/noNoninteractiveTabindex: one tab stop per chart for the keyboard readout
				tabIndex={0}
				aria-label={`${label}, use the left and right arrow keys to read values`}
				aria-describedby={summaryId}
				onKeyDown={onKeyDown}
				onBlur={() => setCursor(null)}
				data-testid={`${testId}-plot`}
			>
				<svg
					role="img"
					aria-label={`${label}: ${summary}`}
					viewBox={`0 0 ${BOX.width} ${BOX.height}`}
					className="block h-auto w-full"
					onMouseMove={onMouseMove}
					onMouseLeave={() => setCursor(null)}
				>
					<rect
						x={BOX.left}
						y={BOX.top}
						width={PLOT_WIDTH}
						height={PLOT_HEIGHT}
						className="fill-surface-raised"
					/>
					{yTicks.map((tick) => (
						<g key={tick}>
							<line
								x1={BOX.left}
								x2={BOX.left + PLOT_WIDTH}
								y1={valueY(tick, top)}
								y2={valueY(tick, top)}
								className="stroke-line"
								strokeWidth="1"
							/>
							<text
								x={BOX.left - 6}
								y={valueY(tick, top)}
								textAnchor="end"
								dominantBaseline="middle"
								fontSize="11"
								className="fill-ink-muted tabular-nums"
							>
								{formatTick(tick)}
							</text>
						</g>
					))}
					{timeTickIndexes(frame)
						// A label at the very right edge would be cut off.
						.filter((index) => index / frame.count < 0.95)
						.map((index) => (
							<text
								key={index}
								x={BOX.left + (index * PLOT_WIDTH) / frame.count}
								y={BOX.height - 8}
								textAnchor="middle"
								fontSize="11"
								className="fill-ink-muted tabular-nums"
							>
								{timeLabel(bucketStart(frame, index), frame.range)}
							</text>
						))}
					{children(cursor)}
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
						style={{ left: `${(cursorX / BOX.width) * 100}%` }}
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
