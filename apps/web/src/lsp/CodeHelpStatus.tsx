/**
 * The code-help state on the editor bar (SPEC.md §13.6). Idle, and code
 * help turned off, show nothing.
 */
import type { ServerStatus } from "./store.js";

export const TOO_LARGE_MESSAGE = "Code help is off for files over 512 KB";
const REPLACED_MESSAGE = "Code help is on in another window";

/** The words and the button for a state, or null for nothing shown. */
export function statusView(
	status: ServerStatus | undefined,
	tooLarge: boolean,
): { text: string; action: "Restart" | "Use here" | null } | null {
	if (status === undefined || status.state === "quiet") return null;
	if (tooLarge) return { text: TOO_LARGE_MESSAGE, action: null };
	switch (status.state) {
		case "starting":
			return { text: "Code help starting…", action: null };
		case "ready":
			return { text: "Code help ready", action: null };
		case "unavailable":
			return { text: "Code help unavailable", action: "Restart" };
		case "crashed":
			return {
				text: status.detail
					? `Code help stopped. ${status.detail}`
					: "Code help stopped",
				action: "Restart",
			};
		case "replaced":
			return { text: REPLACED_MESSAGE, action: "Use here" };
	}
}

export function CodeHelpStatus({
	path,
	status,
	tooLarge,
	onRestart,
}: {
	path: string;
	status: ServerStatus | undefined;
	tooLarge: boolean;
	onRestart: () => void;
}) {
	const view = statusView(status, tooLarge);
	return (
		<>
			{/* Always mounted, so a change of state is announced (SPEC.md §25.8). */}
			<span
				className="pk-code-help"
				role="status"
				data-testid={`editor-code-help-${path}`}
			>
				{view?.text ?? ""}
			</span>
			{view?.action ? (
				<button type="button" className="pk-zoom-reset" onClick={onRestart}>
					{view.action}
				</button>
			) : null}
		</>
	);
}
