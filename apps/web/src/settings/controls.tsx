import { type ReactNode, useEffect } from "react";
import type { SettingsControl } from "./sections.js";

/** Scroll the chosen control into view and move focus to it. */
export function useShowSetting(highlightId: string | null, ready: boolean) {
	useEffect(() => {
		if (!highlightId || !ready) return;
		const node = document.getElementById(`settings-control-${highlightId}`);
		if (!node) return;
		node.scrollIntoView({ block: "nearest" });
		// The field itself, not the help button that sits before it beside the label.
		const focusable =
			node.querySelector<HTMLElement>("input:not([disabled]), textarea, select") ??
			node.querySelector<HTMLElement>("button:not([disabled])");
		(focusable ?? node).focus();
	}, [highlightId, ready]);
}

export function ControlFrame({
	control,
	highlighted,
	className = "",
	children,
}: {
	control: SettingsControl;
	highlighted: boolean;
	className?: string;
	children: ReactNode;
}) {
	return (
		<div
			id={`settings-control-${control.id}`}
			tabIndex={-1}
			data-highlighted={highlighted ? "true" : "false"}
			className={`rounded-sm outline-none ${className} ${
				highlighted ? "bg-surface-selected px-2 py-2" : ""
			}`}
		>
			{children}
		</div>
	);
}
