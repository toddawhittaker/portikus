/**
 * The instructor's view of one of the student's terminals during live help
 * (ADR 0063). It is deliberately smaller than the student's pane: output
 * from the student's workspace is untrusted in the instructor's browser, so
 * there are no OSC 52 clipboard writes, no title changes, no image paste, no
 * voice, and a link opens only when clicked, in a tab with no opener.
 */
import { SCROLLBACK_LINES } from "@portikus/contracts";
import { Button } from "@portikus/ui";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal as Xterm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import "../../terminal/terminal.css";
import { useEffect, useId, useRef, useState } from "react";
import { useScreenReaderMode } from "../../editor/settingsQueries.js";
import { canOpenInNewTab } from "../../links.js";
import { openTerminalSocket } from "../../terminal/terminalSocket.js";
import { sanitizePaste, terminalTheme } from "../../terminal/useXterm.js";
import { type HelperCloseAction, helperCloseAction } from "./helperClose.js";

/** The size used until the student's pane size arrives. */
const FIRST_SIZE = { cols: 80, rows: 24 };

/** OSC numbers a program could use to reach past the terminal: titles and the clipboard. */
const SWALLOWED_OSC = [0, 1, 2, 52];

/**
 * Make the terminal ignore title and clipboard sequences. Handlers added
 * later run first, and one that returns true stops the rest.
 */
export function swallowUnsafeSequences(term: Xterm): void {
	for (const osc of SWALLOWED_OSC) term.parser.registerOscHandler(osc, () => true);
}

/** Open a clicked link in a new tab with no opener, if it is one Portikus opens at all. */
export function openClickedLink(uri: string): void {
	if (canOpenInNewTab(uri)) window.open(uri, "_blank", "noopener,noreferrer");
}

type Problem = "reconnecting" | "lost" | "too-many" | "closed";

const PROBLEM_TEXT: Record<Problem, string> = {
	reconnecting: "Reconnecting to this terminal…",
	lost: "Portikus lost the connection to this terminal.",
	"too-many":
		"You have too many terminals open in Portikus. Close one in another tab, then reconnect.",
	closed: "This terminal was closed in the student's workspace.",
};

export interface HelperTerminalProps {
	/** The socket's path, without the size query. */
	path: string;
	/** The terminal's name, for its accessible label. */
	name: string;
	/** Whether the student lets the helper type. The server enforces it; this only stops sending. */
	typing: boolean;
	/** The API closed the socket with a live help close code. */
	onClosed: (action: HelperCloseAction) => void;
	/** The socket gave up or the terminal went away; the parent should look again. */
	onDropped: () => void;
	/** Reconnect pressed after the socket gave up. */
	onRetry: () => void;
	/** Alt+Shift+Q: move focus out of the terminal. */
	onLeave: () => void;
}

export function HelperTerminal({
	path,
	name,
	typing,
	onClosed,
	onDropped,
	onRetry,
	onLeave,
}: HelperTerminalProps) {
	const host = useRef<HTMLDivElement | null>(null);
	const [connected, setConnected] = useState(false);
	const [problem, setProblem] = useState<Problem | null>(null);
	const hintId = useId();
	const screenReaderMode = useScreenReaderMode();

	// Read through a ref so a parent render does not reopen the socket.
	const handlers = useRef({ onClosed, onDropped, onLeave });
	handlers.current = { onClosed, onDropped, onLeave };
	const nameRef = useRef(name);
	nameRef.current = name;
	const screenReaderRef = useRef(screenReaderMode);
	screenReaderRef.current = screenReaderMode;

	useEffect(() => {
		const container = host.current;
		if (!container) return;
		const term = new Xterm({
			fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
			fontSize: 13,
			// A terminal is always dark (design/system/README.md, "Colour").
			theme: terminalTheme("dark"),
			cols: FIRST_SIZE.cols,
			rows: FIRST_SIZE.rows,
			scrollback: SCROLLBACK_LINES,
			minimumContrastRatio: 4.5,
			screenReaderMode: screenReaderRef.current,
			disableStdin: !typing,
			// OSC 8 hyperlinks: the default asks with confirm() and opens with an opener.
			linkHandler: { activate: (_event, uri) => openClickedLink(uri) },
		});
		swallowUnsafeSequences(term);
		term.loadAddon(new WebLinksAddon((_event, uri) => openClickedLink(uri)));
		term.open(container);
		term.textarea?.setAttribute("aria-describedby", hintId);
		term.textarea?.setAttribute("aria-label", `Terminal ${nameRef.current}`);
		container.dataset.cols = String(term.cols);
		container.dataset.rows = String(term.rows);

		const socket = openTerminalSocket(path, {
			size: () => ({ cols: term.cols, rows: term.rows }),
			onOpen: () => {
				setConnected(true);
				setProblem(null);
			},
			onClose: () => setConnected(false),
			onReconnecting: () => setProblem("reconnecting"),
			onLost: () => {
				setProblem("lost");
				handlers.current.onDropped();
			},
			onTooMany: () => setProblem("too-many"),
			onOutput: (bytes) => term.write(bytes),
			onFirstOutput: () => {},
			onExit: () => {
				setProblem("closed");
				handlers.current.onDropped();
			},
			onGone: () => {
				setProblem("closed");
				handlers.current.onDropped();
			},
			onError: () => {},
			onCwd: () => {},
			onScreen: () => {},
			// Erase the saved lines only; tmux has already cleared the screen.
			onClear: () => term.write("\u001b[3J"),
			onAgent: () => {},
			// The student's pane decides the size; the helper never resizes it (ADR 0063).
			onSize: (cols, rows) => {
				term.resize(cols, rows);
				container.dataset.cols = String(cols);
				container.dataset.rows = String(rows);
			},
			onCloseCode: (code) => {
				const action = helperCloseAction(code);
				if (action) handlers.current.onClosed(action);
				return action !== null;
			},
		});

		const input = typing
			? term.onData((data) => socket.send({ type: "input", data }))
			: null;

		// Handled here rather than by xterm, so planted clipboard text cannot end
		// a bracketed paste early; a picture is never pasted.
		function onPaste(event: ClipboardEvent) {
			event.preventDefault();
			event.stopPropagation();
			const text = event.clipboardData?.getData("text/plain") ?? "";
			if (text !== "") term.paste(sanitizePaste(text));
		}
		container.addEventListener("paste", onPaste, { capture: true });

		term.attachCustomKeyEventHandler((event) => {
			if (
				event.type === "keydown" &&
				event.altKey &&
				event.shiftKey &&
				event.key.toLowerCase() === "q"
			) {
				event.preventDefault();
				handlers.current.onLeave();
				return false;
			}
			return true;
		});

		return () => {
			input?.dispose();
			socket.stop();
			container.removeEventListener("paste", onPaste, { capture: true });
			term.dispose();
		};
	}, [path, typing, hintId]);

	return (
		<div className="flex min-w-0 flex-col gap-2">
			<p className="sr-only" id={hintId}>
				{typing
					? "What you type goes to the student's shell."
					: "You can read this terminal but not type in it."}{" "}
				Press Alt+Shift+Q to leave the terminal.
			</p>
			{/* Fixed to the student's size, so it scrolls when the window is smaller. */}
			<div
				ref={host}
				className="pk-helper-term max-w-full overflow-auto bg-terminal-bg p-2"
				data-testid="helper-terminal"
				data-connected={connected ? "true" : "false"}
				data-mode={typing ? "type" : "view"}
			/>
			<div className="flex flex-wrap items-center gap-3">
				<p className="pk-muted m-0 text-[13px]" role="status">
					{problem ? PROBLEM_TEXT[problem] : ""}
				</p>
				{problem === "lost" || problem === "too-many" ? (
					<Button size="sm" onClick={onRetry}>
						Reconnect
					</Button>
				) : null}
			</div>
		</div>
	);
}
