/**
 * The workspace page's first Tab stop (issue #357): a skip-link-style button
 * that turns screen-reader mode on or off, so a screen-reader user does not
 * have to find it in Settings first. Hidden until it has focus.
 */
import { EDITOR_SETTINGS_DEFAULTS } from "@portikus/contracts";
import { useState } from "react";
import {
	useEditorSettings,
	useUpdateEditorSettings,
} from "../editor/settingsQueries.js";

export function ScreenReaderToggle() {
	const settings = useEditorSettings();
	const update = useUpdateEditorSettings();
	const [announcement, setAnnouncement] = useState("");
	const on =
		settings.data?.screenReaderMode ?? EDITOR_SETTINGS_DEFAULTS.screenReaderMode;

	function toggle() {
		// Not disabled while saving: a disabled button would drop the focus.
		if (update.isPending) return;
		const next = !on;
		update.mutate(
			{ screenReaderMode: next },
			{
				onSuccess: () =>
					setAnnouncement(
						next ? "Screen-reader mode is on." : "Screen-reader mode is off.",
					),
				onError: () => setAnnouncement("Screen-reader mode could not be changed."),
			},
		);
	}

	return (
		<>
			<button
				type="button"
				className="pk-skip-link pk-focus-ring"
				data-testid="screen-reader-toggle"
				onClick={toggle}
			>
				{on ? "Turn off screen-reader mode" : "Turn on screen-reader mode"}
			</button>
			<p
				className="pk-visually-hidden"
				role="status"
				data-testid="screen-reader-status"
			>
				{announcement}
			</p>
		</>
	);
}
