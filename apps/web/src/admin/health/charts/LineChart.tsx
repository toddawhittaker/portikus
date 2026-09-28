import {
	AXIS_FONT,
	bucketCenterX,
	ChartShell,
	LINE_STYLES,
	type Plot,
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
	plot: Plot,
): string {
	const parts: string[] = [];
	let drawing = false;
	values.forEach((value, index) => {
		if (value === null) {
			drawing = false;
			return;
		}
		const x = Math.round(bucketCenterX(frame, index, plot) * 10) / 10;
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
 * A line chart of up to three series over the range (SPEC.md
 * section 25.6). `ticks` is the Y axis, from 0 to its last value, drawn as
 * bare numbers (or by `tickFormat`), so `label` names the unit. `format`
 * writes a value with its unit for the readout. Reference lines mark a
 * threshold or capacity in the warning colour, with a label. With no value
 * in any series there is no axis, only the summary.
 */
export function LineChart({
	testId,
	label,
	frame,
	series,
	ticks,
	format,
	tickFormat,
	summary,
	references = [],
}: {
	testId: string;
	label: string;
	frame: ChartFrame;
	series: readonly LineSeries[];
	ticks: readonly number[];
	format: (value: number) => string;
	tickFormat?: (value: number) => string;
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
			formatTick={tickFormat}
			summary={summary}
			empty={series.every((line) => line.values.every((value) => value === null))}
			describe={describe}
			legend={series.map((line, index) => ({
				name: line.name,
				style: styles[index] as SeriesStyle,
			}))}
		>
			{(_, plot) => (
				<>
					{references.map((reference) => (
						<g key={reference.label}>
							<line
								x1={plot.left}
								x2={plot.left + plot.plotWidth}
								y1={valueY(reference.value, top)}
								y2={valueY(reference.value, top)}
								className="stroke-status-warning"
								strokeWidth="1"
								strokeDasharray="4 3"
							/>
							<text
								x={plot.left + plot.plotWidth - 4}
								// Below the line when it sits at the top of the plot.
								y={
									valueY(reference.value, top) +
									(reference.value >= top * 0.9 ? 12 : -4)
								}
								textAnchor="end"
								fontSize={AXIS_FONT}
								className="fill-status-warning"
							>
								{reference.label}
							</text>
						</g>
					))}
					{series.map((line, index) => (
						<path
							key={line.name}
							d={linePath(frame, line.values, top, plot)}
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
