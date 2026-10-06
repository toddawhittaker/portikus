/**
 * One root shell's terminal and socket (ADR 0051). A workspace terminal can
 * remount when its pane moves to another tab, because it reconnects to the
 * same tmux session; a root shell cannot, since closing its socket hangs up
 * the shell. So each session renders, through a portal, into a host element
 * of its own that stays put in the React tree, and the pane it shows in
 * only adopts that element (RootShellLeaf).
 */
import type { TerminalTheme } from "@portikus/contracts";
import { Button } from "@portikus/ui";
import type { Terminal as Xterm } from "@xterm/xterm";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { canOpenInNewTab } from "../../links.js";
import {
	useXterm,
	type XtermSession,
	type XtermTools,
} from "../../terminal/useXterm.js";
import { LOSS_TEXT } from "./lossText.js";
import { openRootShellSocket, type RootShellLoss } from "./rootShellSocket.js";

/** The element a session renders into, which its pane adopts. */
export function createSessionHost(): HTMLDivElement {
	const host = document.createElement("div");
	host.className = "pk-rootshell-host";
	return host;
}

interface ScreenProps {
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
function RootShellScreen(props: ScreenProps) {
	const { shellId } = props;
	const surface = useRef<HTMLDivElement | null>(null);
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
		host: surface,
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
			<div className="pk-terminal-surface" ref={surface} />
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

export interface RootShellSessionProps {
	shellId: string;
	/** From `createSessionHost`, the same element for the session's whole life. */
	host: HTMLDivElement;
	name: string;
	theme: TerminalTheme;
	screenReaderMode: boolean;
	visible: boolean;
	focused: boolean;
	onFocus: (shellId: string) => void;
	onLeave: () => void;
	/** The shell exited: its pane goes away. */
	onExited: (shellId: string) => void;
	/** The shell is gone without exiting, and why; null when back after Try again. */
	onLossChange: (shellId: string, loss: RootShellLoss | null) => void;
}

export function RootShellSession(props: RootShellSessionProps) {
	const { shellId } = props;
	const [loss, setLoss] = useState<RootShellLoss | null>(null);
	// A new attempt mounts a new screen, so a fresh terminal and socket.
	const [attempt, setAttempt] = useState(0);
	const retry = useRef<HTMLButtonElement | null>(null);
	// Set when the keyboard was in the shell as the host refused it, so it
	// moves to Try again rather than falling to the page.
	const focusRetry = useRef(false);

	useEffect(() => {
		if (loss !== "refused" || !focusRetry.current) return;
		focusRetry.current = false;
		retry.current?.focus();
	}, [loss]);

	function lost(reason: RootShellLoss) {
		focusRetry.current = props.host.contains(document.activeElement);
		setLoss(reason);
		props.onLossChange(shellId, reason);
	}

	return createPortal(
		loss === "refused" ? (
			<div className="pk-term-ended" data-testid={`root-shell-refused-${shellId}`}>
				<p className="pk-term-ended-text">{LOSS_TEXT.refused}</p>
				<Button
					ref={retry}
					variant="secondary"
					size="sm"
					onClick={() => {
						setLoss(null);
						setAttempt((count) => count + 1);
						props.onLossChange(shellId, null);
					}}
				>
					Try again
				</Button>
			</div>
		) : (
			<RootShellScreen
				key={attempt}
				shellId={shellId}
				name={props.name}
				theme={props.theme}
				screenReaderMode={props.screenReaderMode}
				visible={props.visible}
				focusOnMount={props.focused}
				loss={loss}
				onFocus={props.onFocus}
				onLeave={props.onLeave}
				onExited={props.onExited}
				onLost={lost}
			/>
		),
		props.host,
	);
}
