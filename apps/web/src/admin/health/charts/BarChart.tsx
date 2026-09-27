import { useState } from "react";
import {
	BOX,
	ChartShell,
	PLOT_HEIGHT,
	PLOT_WIDTH,
	type SeriesStyle,
	valueY,
} from "./readout.js";
import { bucketStart, type ChartFrame } from "./scales.js";

/** The warning hatch; one bar chart with warnings per page, like the strip's patterns. */
const WARNING_PATTERN = "health-bar-warning";

/**
 * Bar tones from the existing tokens (SPEC.md section 25.6). Warnings are
 * hatched, since error and warning colours are too close to tell apart.
 */
const TONES: Record<BarSeries["tone"], SeriesStyle> = {
	accent: { className: "fill-accent" },
	error: { className: "fill-status-error" },
	warning: { className: "fill-[url(#health-bar-warning)]" },
};

export interface BarSeries {
	name: string;
	tone: "accent" | "error" | "warning";
	/** One count per bucket of the frame; null is a gap. */
	values: readonly (number | null)[];
}

/** Which series a click at `value` on the Y scale lands in; above the stack is the first. */
export function seriesAt(stack: readonly number[], value: number): number {
	let base = 0;
	for (let index = 0; index < stack.length; index++) {
		base += stack[index] ?? 0;
		if (value <= base) return index;
	}
	return 0;
}

/**
 * Stacked count bars, the first series at the bottom. The readout names each
 * series' count. With `onOpen`, Up and Down pick a series in the selected
 * bar and Enter calls `onOpen(bucketIndex, seriesIndex)`, so a bar can
 * follow a link without being its own tab stop (SPEC.md section 25.6).
 * A click anywhere in a bucket's column opens the series under the pointer.
 */
export function BarChart({
	testId,
	label,
	frame,
	series,
	ticks,
	format,
	summary,
	onOpen,
	openHint,
}: {
	testId: string;
	label: string;
	frame: ChartFrame;
	series: readonly BarSeries[];
	ticks: readonly number[];
	format: (value: number) => string;
	summary: string;
	onOpen?: (bucketIndex: number, seriesIndex: number) => void;
	/** What Enter does, such as "open the logs". */
	openHint?: string;
}) {
	const [picked, setPicked] = useState(0);
	const top = ticks[ticks.length - 1] ?? 1;
	const slot = PLOT_WIDTH / frame.count;
	const width = Math.max(1, slot * 0.7);

	function valueText(bar: BarSeries | undefined, index: number): string {
		const value = bar?.values[index];
		return value === null || value === undefined ? "no data" : format(value);
	}

	function describe(index: number): string {
		const parts = series.map((bar, i) => {
			const text = `${bar.name} ${valueText(bar, index)}`;
			return onOpen && series.length > 1 && i === picked ? `${text} (selected)` : text;
		});
		return parts.join(", ");
	}

	function onKey(key: string, index: number): boolean | string {
		if (!onOpen) return false;
		if (key === "Enter") {
			onOpen(index, picked);
			return true;
		}
		const next =
			key === "ArrowUp"
				? Math.min(series.length - 1, picked + 1)
				: key === "ArrowDown"
					? Math.max(0, picked - 1)
					: null;
		if (next === null) return false;
		setPicked(next);
		const bar = series[next];
		return `${bar?.name ?? ""} ${valueText(bar, index)} selected`;
	}

	const names = series.map((bar) => bar.name.toLowerCase()).join(" or ");
	const keysHint =
		onOpen && series.length > 1
			? `up and down to choose ${names}, Enter to ${openHint ?? "open the bar"}`
			: onOpen
				? `Enter to ${openHint ?? "open the bar"}`
				: undefined;

	function onColumnClick(event: React.MouseEvent<SVGRectElement>, index: number) {
		if (!onOpen) return;
		const svg = event.currentTarget.ownerSVGElement;
		const rect = svg?.getBoundingClientRect();
		let value = 0;
		if (rect && rect.height > 0) {
			const y = ((event.clientY - rect.top) / rect.height) * BOX.height;
			value = ((BOX.top + PLOT_HEIGHT - y) / PLOT_HEIGHT) * top;
		}
		onOpen(
			index,
			seriesAt(
				series.map((bar) => bar.values[index] ?? 0),
				value,
			),
		);
	}

	return (
		<ChartShell
			testId={testId}
			label={label}
			frame={frame}
			yTicks={ticks}
			formatTick={format}
			summary={summary}
			describe={describe}
			onKey={onKey}
			keysHint={keysHint}
			legend={series.map((bar) => ({
				name: bar.name,
				style: TONES[bar.tone],
				swatch: "box",
			}))}
		>
			{() => (
				<>
					<defs>
						<pattern
							id={WARNING_PATTERN}
							width="4"
							height="4"
							patternUnits="userSpaceOnUse"
							patternTransform="rotate(45)"
						>
							<rect width="4" height="4" className="fill-status-warning" />
							<line
								x1="1"
								y1="0"
								x2="1"
								y2="4"
								strokeWidth="1.5"
								className="stroke-surface-raised"
							/>
						</pattern>
					</defs>
					{Array.from({ length: frame.count }, (_, index) => {
						const x = BOX.left + index * slot + (slot - width) / 2;
						// No data for this bucket: a dotted baseline, so the gap shows.
						if (series.every((bar) => bar.values[index] === null)) {
							return (
								<line
									key={`gap-${bucketStart(frame, index)}`}
									x1={BOX.left + index * slot}
									x2={BOX.left + (index + 1) * slot}
									y1={BOX.top + PLOT_HEIGHT - 1}
									y2={BOX.top + PLOT_HEIGHT - 1}
									strokeWidth="2"
									strokeDasharray="1 2"
									className="stroke-ink-muted"
									data-gap="true"
								/>
							);
						}
						let base = 0;
						return series.map((bar, seriesIndex) => {
							const value = bar.values[index] ?? 0;
							if (value <= 0) return null;
							const y = valueY(base + value, top);
							let height = valueY(base, top) - y;
							// A 1px gap from the segment below, so the two never merge.
							if (base > 0 && height > 1) height -= 1;
							base += value;
							return (
								<rect
									key={`${bar.name}-${bucketStart(frame, index)}`}
									x={x}
									y={y}
									width={width}
									height={height}
									className={TONES[bar.tone].className}
									data-series={seriesIndex}
								/>
							);
						});
					})}
					{onOpen
						? Array.from({ length: frame.count }, (_, index) => (
								// biome-ignore lint/a11y/noStaticElementInteractions: the keyboard opens a bar through the plot
								<rect
									key={`hit-${bucketStart(frame, index)}`}
									x={BOX.left + index * slot}
									y={BOX.top}
									width={slot}
									height={PLOT_HEIGHT}
									className="fill-transparent"
									style={{ cursor: "pointer" }}
									data-hit={index}
									onClick={(event) => onColumnClick(event, index)}
								/>
							))
						: null}
				</>
			)}
		</ChartShell>
	);
}
