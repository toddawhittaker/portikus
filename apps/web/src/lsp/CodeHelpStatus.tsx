/**
 * The code-help state on the editor bar (SPEC.md §13.6). Idle, and code
 * help turned off, show nothing.
 */
import { useEffect, useId } from "react";
import { type ServerStatus, useCodeHelpStore } from "./store.js";

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

/**
 * Whether this bar is the one that announces its server's state. Editors side
 * by side show the same state, and one announcement is enough (SPEC.md §25.8).
 */
function useAnnounces(key: string): boolean {
	const viewer = useId();
	useEffect(() => {
		const { addViewer, removeViewer } = useCodeHelpStore.getState();
		addViewer(key, viewer);
		return () => removeViewer(key, viewer);
	}, [key, viewer]);
	return useCodeHelpStore((state) => state.viewers[key]?.[0] === viewer);
}

export function CodeHelpStatus({
	path,
	announceKey,
	status,
	tooLarge,
	onRestart,
}: {
	path: string;
	/** The project and server, shared by every bar that shows this state. */
	announceKey: string;
	status: ServerStatus | undefined;
	tooLarge: boolean;
	/** Also moves focus off the button, which goes away while the server starts. */
	onRestart: () => void;
}) {
	const view = statusView(status, tooLarge);
	const announces = useAnnounces(announceKey);
	// Only a state that asks for action is announced: a quiet reconnect after
	// idle or a dropped socket is not read out (SPEC.md §13.6, §25.8). Too large
	// belongs to this file alone, so its own bar announces it.
	const announced = view !== null && (tooLarge || (view.action !== null && announces));
	return (
		<>
			<span
				className="pk-code-help"
				data-testid={`editor-code-help-${path}`}
				data-shown={view !== null}
			>
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
