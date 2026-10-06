/**
 * One root shell in a split: the shared pane frame around an xterm.js
 * terminal on its own socket (ADR 0051; SPEC.md §9.3). The socket opens
 * when the pane mounts and closes when it unmounts, which hangs up the shell.
 */
import type { TerminalTheme } from "@portikus/contracts";
import type { Terminal as Xterm } from "@xterm/xterm";
import { useCallback, useId, useRef, useState } from "react";
import type { DropEdge, SplitDirection } from "../../layout/tree.js";
import { canOpenInNewTab } from "../../links.js";
import { PaneFrame } from "../../terminal/PaneFrame.js";
import {
	useXterm,
	type XtermSession,
	type XtermTools,
} from "../../terminal/useXterm.js";
import { openRootShellSocket, type RootShellLoss } from "./rootShellSocket.js";

/** What the pane says once its shell is gone without exiting. */
export const LOSS_TEXT: Record<RootShellLoss, string> = {
	too_many:
		"You have too many terminals open across your browser tabs. Close some terminals or root shells, then open a new root shell.",
	server_stopped:
		"Portikus restarted on the server, so this root shell ended. Close this pane and open a new root shell.",
	closed:
		"This root shell's connection closed. Close this pane and open a new root shell.",
};

export interface RootShellLeafProps {
	shellId: string;
	name: string;
	theme: TerminalTheme;
	screenReaderMode: boolean;
	visible: boolean;
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
	/** The shell exited: its pane goes away. */
	onExited: (shellId: string) => void;
}

export function RootShellLeaf(props: RootShellLeafProps) {
	const { shellId, name } = props;
	const host = useRef<HTMLDivElement | null>(null);
	const leaveHintId = useId();
	const [connected, setConnected] = useState(false);
	const [loss, setLoss] = useState<RootShellLoss | null>(null);

	// The long-lived attach reads this through a ref, so a new render does
	// not tear down the terminal and hang up the shell.
	const onExited = useRef(props.onExited);
	onExited.current = props.onExited;

	const attach = useCallback(
		(term: Xterm, { fit }: XtermTools): XtermSession => {
			const sendSize = () => {
				fit();
				socket.send({ type: "resize", cols: term.cols, rows: term.rows });
			};
			const socket = openRootShellSocket(
				{ cols: term.cols, rows: term.rows },
				{
					onOpen: () => setConnected(true),
					onOutput: (bytes) => term.write(bytes),
					// The size in the connect URL was measured before the pane's
					// box settled, so say it again once the shell is talking.
					onFirstOutput: sendSize,
					onExit: () => {
						setConnected(false);
						onExited.current(shellId);
					},
					onLost: (reason) => {
						setConnected(false);
						setLoss(reason);
					},
					onError: (code) => term.writeln(`\r\n[portikus] root shell error: ${code}`),
				},
			);
			const input = term.onData((data) => socket.send({ type: "input", data }));
			return {
				resized: sendSize,
				dispose: () => {
					input.dispose();
					socket.stop();
				},
			};
		},
		[shellId],
	);

	useXterm({
		host,
		name,
		theme: props.theme,
		screenReaderMode: props.screenReaderMode,
		visible: props.visible,
		focusOnMount: props.focused,
		describedBy: leaveHintId,
		onFocus: () => props.onFocus(shellId),
		onLeave: props.onLeave,
		// Nothing in a root shell maps to a workspace route; any other link
		// opens in a new tab, as from a workspace terminal.
		openUrl: (uri) => {
			if (canOpenInNewTab(uri)) window.open(uri, "_blank", "noopener,noreferrer");
		},
		attach,
	});

	return (
		<PaneFrame
			terminalId={shellId}
			name={name}
			title={name}
			theme={props.theme}
			focused={props.focused}
			ended={loss !== null}
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
			<div
				className="pk-term-screen"
				data-testid={`terminal-pane-${shellId}`}
				data-connected={connected ? "true" : undefined}
			>
				<div className="pk-terminal-surface" ref={host} />
				<p id={leaveHintId} hidden>
					Tab goes to the shell. Press Alt+Shift+Q to leave the terminal.
				</p>
				<div role="status">
					{loss ? (
						<div className="pk-term-flag" data-testid={`root-shell-lost-${shellId}`}>
							{LOSS_TEXT[loss]}
						</div>
					) : null}
				</div>
			</div>
		</PaneFrame>
	);
}
