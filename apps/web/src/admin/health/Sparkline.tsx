const WIDTH = 240;
const HEIGHT = 40;

/**
 * SVG polyline points for `values` scaled into the chart box. The top of the
 * box is `max`, so percentages share one scale; a flat or empty series is
 * drawn along the bottom.
 */
export function sparklinePoints(values: readonly number[], max: number): string {
	if (values.length === 0) return "";
	const step = values.length > 1 ? WIDTH / (values.length - 1) : 0;
	return values
		.map((value, index) => {
			const ratio = max > 0 ? Math.min(value / max, 1) : 0;
			const x = index * step;
			const y = HEIGHT - ratio * HEIGHT;
			return `${round(x)},${round(y)}`;
		})
		.join(" ");
}

function round(value: number): string {
	return String(Math.round(value * 10) / 10);
}

/**
 * A small line chart. `summary` is the text alternative: screen readers read
 * it instead of the drawing, and it is shown beneath for everyone.
 */
export function Sparkline({
	label,
	values,
	max,
	summary,
	testId,
}: {
	label: string;
	values: readonly number[];
	max: number;
	summary: string;
	testId: string;
}) {
	return (
		<figure className="m-0" data-testid={testId}>
			<figcaption className="pk-text-label text-ink-muted">{label}</figcaption>
			<svg
				role="img"
				aria-label={`${label}: ${summary}`}
				viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
				width={WIDTH}
				height={HEIGHT}
				className="mt-1 text-accent"
				preserveAspectRatio="none"
			>
				<line
					x1="0"
					y1={HEIGHT}
					x2={WIDTH}
					y2={HEIGHT}
					className="stroke-line"
					strokeWidth="1"
				/>
				<polyline
					points={sparklinePoints(values, max)}
					fill="none"
					stroke="currentColor"
					strokeWidth="1.5"
					strokeLinejoin="round"
				/>
			</svg>
			<p className="pk-text-body pk-muted m-0 text-[12px]" aria-hidden="true">
				{summary}
			</p>
		</figure>
	);
}
