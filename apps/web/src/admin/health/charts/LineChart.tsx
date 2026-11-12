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

/**
 * The runs of a series to draw as one line each. A single missing bucket
 * between two values is bridged: samples taken less often than the bucket
 * width land on every other bucket, and that is not an outage (the
 * availability strip shows real gaps).
 */
function runs(
	values: readonly (number | null)[],
): { index: number; value: number }[][] {
	const out: { index: number; value: number }[][] = [];
	let current: { index: number; value: number }[] = [];
	values.forEach((value, index) => {
		if (value !== null) {
			current.push({ index, value });
			return;
		}
		const before = values[index - 1];
		const after = values[index + 1];
		const bridged =
			before !== null && before !== undefined && after !== null && after !== undefined;
		if (!bridged && current.length > 0) {
			out.push(current);
			current = [];
		}
	});
	if (current.length > 0) out.push(current);
	return out;
}

function point(
	frame: ChartFrame,
	index: number,
	value: number,
	top: number,
	plot: Plot,
) {
	return {
		x: Math.round(bucketCenterX(frame, index, plot) * 10) / 10,
		y: Math.round(valueY(value, top) * 10) / 10,
	};
}

/** SVG path data for one series: a new `M` after every gap. */
export function linePath(
	frame: ChartFrame,
	values: readonly (number | null)[],
	top: number,
	plot: Plot,
): string {
	return runs(values)
		.map((run) =>
			run
				.map(({ index, value }, i) => {
					const { x, y } = point(frame, index, value, top, plot);
					// "l0 0" draws a lone point as a dot with the round line cap.
					return `${i === 0 ? "M" : "L"}${x} ${y}${run.length === 1 ? " l0 0" : ""}`;
				})
				.join(" "),
		)
		.join(" ");
}

/** The area under each run of a series, closed along the zero line. */
export function areaPath(
	frame: ChartFrame,
	values: readonly (number | null)[],
	top: number,
	plot: Plot,
): string {
	const base = valueY(0, top);
	return runs(values)
		.filter((run) => run.length > 1)
		.map((run) => {
			const points = run.map(({ index, value }) =>
				point(frame, index, value, top, plot),
			);
			const first = points[0] as { x: number };
			const last = points[points.length - 1] as { x: number };
			return `M${first.x} ${base} ${points.map((p) => `L${p.x} ${p.y}`).join(" ")} L${last.x} ${base} Z`;
		})
		.join(" ");
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
					{series[0] ? (
						<path
							d={areaPath(frame, series[0].values, top, plot)}
							className="fill-accent"
							fillOpacity="0.1"
							stroke="none"
						/>
					) : null}
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
