import { type ReactNode, useEffect } from "react";
import type { SettingsControl } from "./sections.js";

/** Scroll the chosen control into view and move focus to it. */
export function useShowSetting(highlightId: string | null, ready: boolean) {
	useEffect(() => {
		if (!highlightId || !ready) return;
		const node = document.getElementById(`settings-control-${highlightId}`);
		if (!node) return;
		node.scrollIntoView({ block: "nearest" });
		const focusable = node.querySelector<HTMLElement>(
			"input:not([disabled]), button:not([disabled]), textarea, select",
		);
		(focusable ?? node).focus();
	}, [highlightId, ready]);
}

export function ControlFrame({
	control,
	highlighted,
	children,
}: {
	control: SettingsControl;
	highlighted: boolean;
	children: ReactNode;
}) {
	return (
		<div
			id={`settings-control-${control.id}`}
			tabIndex={-1}
			data-highlighted={highlighted ? "true" : "false"}
			className={`rounded-sm outline-none ${
				highlighted ? "bg-surface-selected px-2 py-2" : ""
			}`}
		>
			{children}
		</div>
	);
}
