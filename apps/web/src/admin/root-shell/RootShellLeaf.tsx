/**
 * One root shell's pane in a split: the shared pane frame, adopting the
 * element its session renders into (RootShellSession; SPEC.md §9.3). The
 * pane may mount again when it moves to another tab; the shell does not.
 */
import type { TerminalTheme } from "@portikus/contracts";
import { useLayoutEffect, useRef } from "react";
import type { DropEdge, SplitDirection } from "../../layout/tree.js";
import { PaneFrame } from "../../terminal/PaneFrame.js";

export interface RootShellLeafProps {
	shellId: string;
	name: string;
	theme: TerminalTheme;
	/** The session's element, shown in this pane. */
	host: HTMLDivElement;
	/** The shell is gone without exiting: no splitting it. */
	ended: boolean;
	focused: boolean;
	alone: boolean;
	dropEdge: DropEdge | null;
	moveTargets: { tabId: string; label: string }[];
	onFocus: (shellId: string) => void;
	onSplit: (shellId: string, direction: SplitDirection) => void;
	onMoveToNewTab: (shellId: string) => void;
	onMoveInto: (shellId: string, tabId: string) => void;
	onResetSizes: () => void;
	onLeave: () => void;
	onClose: (shellId: string) => void;
}

export function RootShellLeaf(props: RootShellLeafProps) {
	const slot = useRef<HTMLDivElement | null>(null);

	// A layout effect, so the element is in the page before the session's
	// terminal opens in it and measures its cells.
	// Moving the element drops the keyboard if it was inside, as when a
	// closed neighbour collapses the split; the focused pane takes it back.
	const focused = useRef(props.focused);
	focused.current = props.focused;
	useLayoutEffect(() => {
		slot.current?.appendChild(props.host);
		const active = document.activeElement;
		if (focused.current && (active === null || active === document.body)) {
			props.host.querySelector<HTMLElement>(".xterm-helper-textarea")?.focus();
		}
	}, [props.host]);

	return (
		<PaneFrame
			terminalId={props.shellId}
			name={props.name}
			title={props.name}
			theme={props.theme}
			focused={props.focused}
			ended={props.ended}
			alone={props.alone}
			dropEdge={props.dropEdge}
			moveTargets={props.moveTargets}
			onFocus={props.onFocus}
			onSplit={props.onSplit}
			onMoveToNewTab={props.onMoveToNewTab}
			onMoveInto={props.onMoveInto}
			onResetSizes={props.onResetSizes}
			onLeave={props.onLeave}
			onClose={props.onClose}
		>
			<div className="pk-rootshell-slot" ref={slot} />
		</PaneFrame>
	);
}
