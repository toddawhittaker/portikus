import { useState } from "react";
import { BOX, ChartShell, PLOT_WIDTH, type SeriesStyle, valueY } from "./readout.js";
import { bucketStart, type ChartFrame } from "./scales.js";

/** Bar tones from the existing tokens (docs/EPIC-19.md ruling 7). */
const TONES: Record<BarSeries["tone"], SeriesStyle> = {
	accent: { className: "fill-accent" },
	error: { className: "fill-status-error" },
	warning: { className: "fill-status-warning" },
};

export interface BarSeries {
	name: string;
	tone: "accent" | "error" | "warning";
	/** One count per bucket of the frame; null is a gap. */
	values: readonly (number | null)[];
}

/**
 * Stacked count bars, the first series at the bottom. The readout names each
 * series' count. With `onOpen`, Up and Down pick a series in the selected
 * bar and Enter calls `onOpen(bucketIndex, seriesIndex)`, so a bar can
 * follow a link without being its own tab stop (docs/EPIC-19.md ruling 8).
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
}: {
	testId: string;
	label: string;
	frame: ChartFrame;
	series: readonly BarSeries[];
	ticks: readonly number[];
	format: (value: number) => string;
	summary: string;
	onOpen?: (bucketIndex: number, seriesIndex: number) => void;
}) {
	const [picked, setPicked] = useState(0);
	const top = ticks[ticks.length - 1] ?? 1;
	const slot = PLOT_WIDTH / frame.count;
	const width = Math.max(1, slot * 0.7);

	function describe(index: number): string {
		const parts = series.map((bar, i) => {
			const value = bar.values[index];
			const text = `${bar.name} ${value === null || value === undefined ? "no data" : format(value)}`;
			return onOpen && series.length > 1 && i === picked ? `${text} (selected)` : text;
		});
		return parts.join(", ");
	}

	function onKey(key: string, index: number): boolean {
		if (!onOpen) return false;
		if (key === "Enter") {
			onOpen(index, picked);
			return true;
		}
		if (key === "ArrowUp") {
			setPicked((current) => Math.min(series.length - 1, current + 1));
			return true;
		}
		if (key === "ArrowDown") {
			setPicked((current) => Math.max(0, current - 1));
			return true;
		}
		return false;
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
			legend={series.map((bar) => ({
				name: bar.name,
				style: TONES[bar.tone],
				swatch: "box",
			}))}
		>
			{() =>
				Array.from({ length: frame.count }, (_, index) => {
					let base = 0;
					const x = BOX.left + index * slot + (slot - width) / 2;
					return series.map((bar, seriesIndex) => {
						const value = bar.values[index] ?? 0;
						if (value <= 0) return null;
						const y = valueY(base + value, top);
						const height = valueY(base, top) - y;
						base += value;
						return (
							// biome-ignore lint/a11y/noStaticElementInteractions: the keyboard opens a bar through the plot
							<rect
								key={`${bar.name}-${bucketStart(frame, index)}`}
								x={x}
								y={y}
								width={width}
								height={height}
								className={TONES[bar.tone].className}
								data-series={seriesIndex}
								onClick={onOpen ? () => onOpen(index, seriesIndex) : undefined}
								style={onOpen ? { cursor: "pointer" } : undefined}
							/>
						);
					});
				})
			}
		</ChartShell>
	);
}
