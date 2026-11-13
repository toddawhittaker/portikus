/**
 * The editor's zoom buttons and percentage (SPEC.md §13.1), drawn in the bar
 * under a file's editor and under its diff, so both zoom the same way.
 */
import { DEFAULT_ZOOM, stepZoom } from "./zoom.js";

export function ZoomControls({
	zoom,
	onZoom,
	valueTestId,
}: {
	zoom: number;
	onZoom: (percent: number) => void;
	valueTestId: string;
}) {
	return (
		<>
			<button
				type="button"
				className="pk-zoom-button"
				aria-label="Zoom out"
				onClick={() => onZoom(stepZoom(zoom, -1))}
			>
				&minus;
			</button>
			<span className="pk-zoom-value" data-testid={valueTestId}>
				{zoom}%
			</span>
			<button
				type="button"
				className="pk-zoom-button"
				aria-label="Zoom in"
				onClick={() => onZoom(stepZoom(zoom, 1))}
			>
				+
			</button>
			<button
				type="button"
				className="pk-zoom-reset"
				onClick={() => onZoom(DEFAULT_ZOOM)}
			>
				Reset
			</button>
		</>
	);
}
