import { Button } from "@portikus/ui";
import { useState } from "react";
import {
	useEditorSettings,
	useUpdateEditorSettings,
} from "../editor/settingsQueries.js";
import {
	askDesktopPermission,
	desktopPermission,
	desktopSupported,
} from "./desktopSupport.js";

/**
 * The two actions of the first-alert toast. Nothing renders unless the
 * student has not chosen yet and the browser has not been asked.
 */
export function PermissionOffer() {
	const settings = useEditorSettings();
	const update = useUpdateEditorSettings();
	const [answered, setAnswered] = useState(false);
	if (
		answered ||
		!desktopSupported() ||
		desktopPermission() !== "default" ||
		settings.data?.agentNotifications !== "ask"
	) {
		return null;
	}
	function save(agentNotifications: "on" | "off") {
		setAnswered(true);
		update.mutate({ agentNotifications });
	}
	return (
		<>
			<Button size="sm" onClick={() => void askDesktopPermission().then(save)}>
				Turn on desktop notifications
			</Button>
			<Button size="sm" variant="quiet" onClick={() => save("off")}>
				No thanks
			</Button>
		</>
	);
}
