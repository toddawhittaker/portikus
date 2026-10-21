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
	/** Also moves focus off the button, which goes away while the server starts. */
	onRestart: () => void;
}) {
	const view = statusView(status, tooLarge);
	// Only a state that asks for action is announced: a quiet reconnect after
	// idle or a dropped socket is not read out (SPEC.md §13.6, §25.8).
	const announced = view !== null && (view.action !== null || tooLarge);
	return (
		<>
			<span className="pk-code-help" data-testid={`editor-code-help-${path}`}>
				{announced ? null : view?.text}
				{/* Always mounted, so a change of state is announced (SPEC.md §25.8). */}
				<span role="status">{announced ? view.text : ""}</span>
			</span>
			{view?.action ? (
				<button
					type="button"
					className="pk-zoom-reset"
					aria-label={view.action === "Restart" ? "Restart code help" : undefined}
					onClick={onRestart}
				>
					{view.action}
				</button>
			) : null}
		</>
	);
}
