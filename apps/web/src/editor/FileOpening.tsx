import "./editor.css";

/**
 * What a file tab shows while its text or the editor is still on the way:
 * the file's name and a spinner, centred where the text will appear, so the
 * pane never sits blank (DESIGN.md section 5).
 */
export function FileOpening({
	name,
	overlay = false,
}: {
	name: string;
	overlay?: boolean;
}) {
	return (
		<p
			className={
				overlay ? "pk-file-opening pk-file-opening--overlay" : "pk-file-opening"
			}
		>
			<span className="pk-spin" aria-hidden="true" />
			<span className="pk-file-opening-name">Opening {name}…</span>
		</p>
	);
}
