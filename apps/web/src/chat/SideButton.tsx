/**
 * The title bar's way into the side conversation (SPEC.md §10.2): what a
 * bare `/btw` does, for a student who does not know the command. It is drawn
 * into the chat pane's bar, and only while the host lists `btw`. Its label
 * folds away when the bar is narrow, leaving the icon and its name (SPEC.md §25.8).
 */
import { Button } from "@portikus/ui";
import { useContext } from "react";
import { createPortal } from "react-dom";
import { PaneBarSlot } from "../terminal/paneBarSlot.js";
import "./side.css";

export const SIDE_BUTTON_LABEL = "Side question";

export function SideButton({ onOpen }: { onOpen: () => void }) {
	const bar = useContext(PaneBarSlot);
	if (bar === null) return null;
	return createPortal(
		<Button
			variant="quiet"
			size="sm"
			iconStart="messages"
			className="pk-iconbtn pk-side-open"
			title="Ask a side question, as /btw does"
			data-testid="side-open"
			onClick={onOpen}
		>
			<span className="pk-side-open-label">{SIDE_BUTTON_LABEL}</span>
		</Button>,
		bar,
	);
}
