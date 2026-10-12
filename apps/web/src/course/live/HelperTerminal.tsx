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

/**
 * Whether a key press leaves the terminal instead of reaching it. Tab leaves
 * only in view mode, where it would type nothing, and is left to the browser
 * so focus moves on as it does anywhere else.
 */
export function leaveKey(
	event: Pick<
		KeyboardEvent,
		"type" | "key" | "altKey" | "shiftKey" | "ctrlKey" | "metaKey"
	>,
	typing: boolean,
): "shortcut" | "tab" | null {
	if (event.type !== "keydown") return null;
	if (event.altKey && event.shiftKey && event.key.toLowerCase() === "q")
		return "shortcut";
	if (
		!typing &&
		event.key === "Tab" &&
		!event.altKey &&
		!event.ctrlKey &&
		!event.metaKey
	) {
		return "tab";
	}
	return null;
}

type Problem = "reconnecting" | "lost" | "too-many" | "closed" | "replaced";

const PROBLEM_TEXT: Record<Problem, string> = {
	reconnecting: "Reconnecting to this terminal…",
	lost: "Portikus lost the connection to this terminal.",
	"too-many":
		"You have too many terminals open in Portikus. Close one in another tab, then reconnect.",
	closed: "This terminal was closed in the student's workspace.",
	replaced: "This terminal was opened in another tab.",
};

export interface HelperTerminalProps {
	/** The socket's path, without the size query. */
	path: string;
	/** The terminal's name, for its accessible label. */
	name: string;
	/** Whether the student lets the helper type. The server enforces it; this only stops sending. */
	typing: boolean;
	/** Changes to open the socket again, as after Reconnect. */
	attach: number;
	/** The API closed the socket with a live help close code other than another tab's takeover. */
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
	attach,
	onClosed,
	onDropped,
	onRetry,
	onLeave,
}: HelperTerminalProps) {
	const host = useRef<HTMLElement | null>(null);
	const terminal = useRef<Xterm | null>(null);
	const [connected, setConnected] = useState(false);
	const [problem, setProblem] = useState<Problem | null>(null);
	const modeHintId = useId();
	const leaveHintId = useId();
	const screenReaderMode = useScreenReaderMode();

	// Read through a ref so a parent render does not reopen the socket.
	const handlers = useRef({ onClosed, onDropped, onLeave });
	handlers.current = { onClosed, onDropped, onLeave };
	const nameRef = useRef(name);
	nameRef.current = name;
	const typingRef = useRef(typing);
	typingRef.current = typing;
	const screenReaderRef = useRef(screenReaderMode);
	screenReaderRef.current = screenReaderMode;

	// One xterm for the life of the pane, so a mode change or a reconnect
	// leaves the keyboard where it was.
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
			disableStdin: !typingRef.current,
			// OSC 8 hyperlinks: the default asks with confirm() and opens with an opener.
			linkHandler: { activate: (_event, uri) => openClickedLink(uri) },
		});
		swallowUnsafeSequences(term);
		term.loadAddon(new WebLinksAddon((_event, uri) => openClickedLink(uri)));
		term.open(container);
		term.textarea?.setAttribute("aria-describedby", `${modeHintId} ${leaveHintId}`);
		term.textarea?.setAttribute("aria-label", `Terminal ${nameRef.current}`);
		container.dataset.cols = String(term.cols);
		container.dataset.rows = String(term.rows);

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
			const leave = leaveKey(event, typingRef.current);
			if (leave === "shortcut") {
				event.preventDefault();
				handlers.current.onLeave();
			}
			return leave === null;
		});
		terminal.current = term;

		return () => {
			terminal.current = null;
			container.removeEventListener("paste", onPaste, { capture: true });
			term.dispose();
		};
	}, [modeHintId, leaveHintId]);

	// One socket per attach, under the same xterm. A helper's attach gets no
	// history, only tmux's repaint of the screen, so the lines already seen stay.
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new `attach` value is what opens the socket again.
	useEffect(() => {
		const term = terminal.current;
		const container = host.current;
		if (!term || !container) return;
		term.options.disableStdin = !typing;
		setProblem(null);

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
				// Reattaching on its own would take the terminal back from the other tab.
				if (action === "replaced") setProblem("replaced");
				else if (action) handlers.current.onClosed(action);
				return action !== null;
			},
		});

		const input = typing
			? term.onData((data) => socket.send({ type: "input", data }))
			: null;

		return () => {
			input?.dispose();
			socket.stop();
		};
	}, [path, typing, attach]);

	function reconnect() {
		// The button goes away with the problem, so the keyboard goes back to the terminal.
		terminal.current?.focus();
		onRetry();
	}

	return (
		<div className="flex min-w-0 flex-col gap-2">
			<p className="sr-only" id={modeHintId}>
				{typing
					? "What you type goes to the student's shell."
					: "You can read this terminal but not type in it. Tab also leaves it."}
			</p>
			{/* Fixed to the student's size, so it scrolls when the window is smaller. */}
			<section
				ref={host}
				className="pk-helper-term pk-focus-ring max-w-full overflow-auto bg-terminal-bg p-2"
				data-testid="helper-terminal"
				data-connected={connected ? "true" : "false"}
				data-mode={typing ? "type" : "view"}
				aria-label={`Terminal ${name}, scrollable`}
				// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region the keyboard must reach (WCAG 2.1.1)
				tabIndex={0}
			/>
			<div className="flex flex-wrap items-center gap-x-3 gap-y-1">
				<p className="pk-muted m-0 text-[13px]" id={leaveHintId}>
					<kbd className="pk-mono-body">Alt+Shift+Q</kbd> leaves the terminal.
				</p>
				<p className="pk-muted m-0 text-[13px]" role="status">
					{problem ? PROBLEM_TEXT[problem] : ""}
				</p>
				{problem === "lost" || problem === "too-many" ? (
					<Button size="sm" onClick={reconnect}>
						Reconnect
					</Button>
				) : null}
				{problem === "replaced" ? (
					<Button size="sm" onClick={reconnect}>
						Open here
					</Button>
				) : null}
			</div>
		</div>
	);
}
