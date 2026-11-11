import { Skeleton } from "@portikus/ui";
import "./editor.css";

// Widths of the placeholder lines, in characters: an uneven page of code.
const LINE_WIDTHS = [
	34, 12, 0, 22, 40, 0, 26, 52, 46, 0, 0, 30, 58, 44, 36, 20, 28, 0, 48, 38,
];

/**
 * What a file tab shows while its text or the editor is still on the way:
 * the file's name over a faint page of lines where the text will appear, so
 * the pane never sits blank (DESIGN.md section 5).
 */
export function FileOpening({
	name,
	overlay = false,
}: {
	name: string;
	overlay?: boolean;
}) {
	return (
		<div
			className={
				overlay ? "pk-file-opening pk-file-opening--overlay" : "pk-file-opening"
			}
		>
			<p className="pk-file-opening-label">
				<span className="pk-spin" aria-hidden="true" />
				<span className="pk-file-opening-name">Opening {name}…</span>
			</p>
			<ol className="pk-file-opening-lines" aria-hidden="true">
				{LINE_WIDTHS.map((width, line) => (
					// A fixed placeholder whose lines have no identity but position.
					// biome-ignore lint/suspicious/noArrayIndexKey: see above
					<li key={line}>{width > 0 ? <Skeleton width={`${width}ch`} /> : null}</li>
				))}
			</ol>
		</div>
	);
}
