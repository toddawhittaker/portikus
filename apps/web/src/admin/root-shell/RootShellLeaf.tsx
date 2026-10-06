/**
 * One root shell in a split: the shared pane frame around an xterm.js
 * terminal on its own socket (ADR 0051; SPEC.md §9.3). The socket opens
 * when the screen mounts and closes when it unmounts, which hangs up the shell.
 */
import type { TerminalTheme } from "@portikus/contracts";
import { Button } from "@portikus/ui";
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
	refused: "The root shell could not start on the host.",
	closed:
		"This root shell's connection closed. Close this pane and open a new root shell.",
};

interface RootShellScreenProps {
	shellId: string;
	name: string;
	theme: TerminalTheme;
	screenReaderMode: boolean;
	visible: boolean;
	focusOnMount: boolean;
	loss: RootShellLoss | null;
	onFocus: (shellId: string) => void;
	onLeave: () => void;
	onExited: (shellId: string) => void;
	onLost: (reason: RootShellLoss) => void;
}

/** The terminal and its socket: one shell, from mount to unmount. */
function RootShellScreen(props: RootShellScreenProps) {
	const { shellId } = props;
	const host = useRef<HTMLDivElement | null>(null);
	const leaveHintId = useId();
	const [connected, setConnected] = useState(false);

	// The long-lived attach reads these through a ref, so a new render does
	// not tear down the terminal and hang up the shell.
	const handlers = useRef({ onExited: props.onExited, onLost: props.onLost });
	handlers.current = { onExited: props.onExited, onLost: props.onLost };

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
						handlers.current.onExited(shellId);
					},
					onLost: (reason) => {
						setConnected(false);
						handlers.current.onLost(reason);
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
		name: props.name,
		theme: props.theme,
		screenReaderMode: props.screenReaderMode,
		visible: props.visible,
		focusOnMount: props.focusOnMount,
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
		<div
			className="pk-term-screen"
			data-testid={`terminal-pane-${shellId}`}
			data-connected={connected ? "true" : undefined}
		>
			<div className="pk-terminal-surface" ref={host} />
			<p id={leaveHintId} hidden>
				Tab goes to the shell. Press Alt+Shift+Q to leave the terminal.
			</p>
			{props.loss ? (
				<div className="pk-term-flag" data-testid={`root-shell-lost-${shellId}`}>
					{LOSS_TEXT[props.loss]}
				</div>
			) : null}
		</div>
	);
}

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
	const [loss, setLoss] = useState<RootShellLoss | null>(null);
	// A new attempt mounts a new screen, so a fresh terminal and socket.
	const [attempt, setAttempt] = useState(0);

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
			{loss === "refused" ? (
				<div className="pk-term-ended" data-testid={`root-shell-refused-${shellId}`}>
					<p className="pk-term-ended-text">{LOSS_TEXT.refused}</p>
					<Button
						variant="secondary"
						size="sm"
						onClick={() => {
							setLoss(null);
							setAttempt((count) => count + 1);
						}}
					>
						Try again
					</Button>
				</div>
			) : (
				<RootShellScreen
					key={attempt}
					shellId={shellId}
					name={name}
					theme={props.theme}
					screenReaderMode={props.screenReaderMode}
					visible={props.visible}
					focusOnMount={props.focused}
					loss={loss}
					onFocus={props.onFocus}
					onLeave={props.onLeave}
					onExited={props.onExited}
					onLost={setLoss}
				/>
			)}
			{/* Kept mounted, so the loss is announced whichever view shows it. */}
			<p role="status" className="sr-only">
				{loss ? LOSS_TEXT[loss] : ""}
			</p>
		</PaneFrame>
	);
}
