import {
	BOX,
	bucketCenterX,
	ChartShell,
	LINE_STYLES,
	PLOT_WIDTH,
	type SeriesStyle,
	valueY,
} from "./readout.js";
import type { ChartFrame } from "./scales.js";

export interface LineSeries {
	name: string;
	/** One value per bucket of the frame; null is a gap. */
	values: readonly (number | null)[];
}

export interface ReferenceLine {
	value: number;
	label: string;
}

/** SVG path data for one series: a new `M` after every gap. */
export function linePath(
	frame: ChartFrame,
	values: readonly (number | null)[],
	top: number,
): string {
	const parts: string[] = [];
	let drawing = false;
	values.forEach((value, index) => {
		if (value === null) {
			drawing = false;
			return;
		}
		const x = Math.round(bucketCenterX(frame, index) * 10) / 10;
		const y = Math.round(valueY(value, top) * 10) / 10;
		// "l0 0" draws a lone point as a dot with the round line cap.
		const next = values[index + 1];
		parts.push(
			`${drawing ? "L" : "M"}${x} ${y}${!drawing && (next === null || next === undefined) ? " l0 0" : ""}`,
		);
		drawing = true;
	});
	return parts.join(" ");
}

/**
 * A line chart of up to three series over the range (docs/EPIC-19.md rulings
 * 6 to 8). `ticks` is the Y axis, from 0 to its last value; `format` writes a
 * value with its unit for the ticks and the readout. Reference lines mark a
 * threshold or capacity in the warning colour, with a label.
 */
export function LineChart({
	testId,
	label,
	frame,
	series,
	ticks,
	format,
	summary,
	references = [],
}: {
	testId: string;
	label: string;
	frame: ChartFrame;
	series: readonly LineSeries[];
	ticks: readonly number[];
	format: (value: number) => string;
	summary: string;
	references?: readonly ReferenceLine[];
}) {
	const top = ticks[ticks.length - 1] ?? 1;
	const styles = series.map(
		(_, index): SeriesStyle => LINE_STYLES[index] ?? { className: "stroke-accent" },
	);
	function describe(index: number): string {
		const values = series.map((line) => line.values[index] ?? null);
		if (values.every((value) => value === null)) return "no data";
		if (series.length === 1) return format(values[0] as number);
		return series
			.map((line, i) => {
				const value = values[i];
				return `${line.name} ${value === null || value === undefined ? "no data" : format(value)}`;
			})
			.join(", ");
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
			legend={series.map((line, index) => ({
				name: line.name,
				style: styles[index] as SeriesStyle,
			}))}
		>
			{() => (
				<>
					{references.map((reference) => (
						<g key={reference.label}>
							<line
								x1={BOX.left}
								x2={BOX.left + PLOT_WIDTH}
								y1={valueY(reference.value, top)}
								y2={valueY(reference.value, top)}
								className="stroke-status-warning"
								strokeWidth="1"
								strokeDasharray="4 3"
							/>
							<text
								x={BOX.left + PLOT_WIDTH - 4}
								// Below the line when it sits at the top of the plot.
								y={
									valueY(reference.value, top) +
									(reference.value >= top * 0.9 ? 12 : -4)
								}
								textAnchor="end"
								fontSize="11"
								className="fill-status-warning"
							>
								{reference.label}
							</text>
						</g>
					))}
					{series.map((line, index) => (
						<path
							key={line.name}
							d={linePath(frame, line.values, top)}
							fill="none"
							strokeWidth="2"
							strokeLinejoin="round"
							strokeLinecap="round"
							strokeDasharray={styles[index]?.dash}
							className={styles[index]?.className}
							data-testid={`${testId}-line`}
						/>
					))}
				</>
			)}
		</ChartShell>
	);
}
