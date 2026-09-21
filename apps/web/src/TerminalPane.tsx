import type { Terminal as TerminalMeta, TerminalTheme } from "@portikus/contracts";
import { useToast } from "@portikus/ui";
import { useNavigate } from "@tanstack/react-router";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal as Xterm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import "./terminal.css";
import { useEffect, useRef, useState } from "react";
import { wsUrl } from "./api/ws.js";
import {
	canOpenInNewTab,
	FILE_LINE_PATTERN,
	fileRouteFor,
	localPreviewTarget,
	MIN_PREVIEW_PORT,
	previewRouteFor,
	type TerminalLink,
	wrappedUrlsOnRow,
} from "./links.js";
import { decodeTerminalFrame } from "./terminalFrames.js";
import { currentPlatform, decide } from "./work/terminalClipboard.js";

const RECONNECT_MS = 3_000;
const MAX_RECONNECT_MS = 60_000;
/** The API closes with this code when the session is gone. */
const SESSION_ENDED_CODE = 4401;
/** Give up after this many consecutive failed connection attempts. */
const MAX_RECONNECT_ATTEMPTS = 5;
/**
 * Close codes that will not get better by retrying: a policy refusal, a frame
 * that was too large, and a server error.
 */
const FATAL_CLOSE_CODES = new Set([1008, 1009, 1011]);

/**
 * Lines the browser keeps above the visible screen, which is what the wheel
 * scrolls back through (SPEC.md §9.1). tmux keeps the same number.
 */
export const SCROLLBACK_LINES = 5_000;

/**
 * The two terminal colour schemes (issue #239). They match the
 * `--terminal-*` and `--ansi-*` tokens in packages/ui/src/theme.css, which
 * colour the chrome around the terminal; xterm.js needs the values directly.
 * The scrollbar thumb is the terminal's muted foreground, quiet until the
 * pointer is on it: xterm.js would otherwise derive it from the text colour,
 * which is far too loud.
 */
const DARK_THEME = {
	background: "#11100e",
	foreground: "#e4dfd4",
	cursor: "#e8c37a",
	selectionBackground: "#3a4a48",
	scrollbarSliderBackground: "#9a938666",
	scrollbarSliderHoverBackground: "#9a9386b3",
	scrollbarSliderActiveBackground: "#9a9386cc",
};

const LIGHT_THEME = {
	background: "#fdfcfa",
	foreground: "#23211d",
	cursor: "#8a5a00",
	selectionBackground: "#d9e8e5",
	scrollbarSliderBackground: "#5a554c40",
	scrollbarSliderHoverBackground: "#5a554c80",
	scrollbarSliderActiveBackground: "#5a554ca6",
	// The default ANSI palette is written for a dark ground, so a light
	// terminal needs its own or half the colours are unreadable.
	black: "#23211d",
	brightBlack: "#5a554c",
	red: "#a4342a",
	brightRed: "#c14437",
	green: "#2e6e34",
	brightGreen: "#3c8743",
	yellow: "#855b00",
	brightYellow: "#a27100",
	blue: "#3f5a8c",
	brightBlue: "#4f70ab",
	magenta: "#8a3ea0",
	brightMagenta: "#a44fbd",
	cyan: "#24605c",
	brightCyan: "#2c7a74",
	white: "#6e685d",
	brightWhite: "#23211d",
};

/** The xterm theme for one of the two schemes (contracts/settings.ts). */
export function terminalTheme(theme: TerminalTheme): Record<string, string> {
	return theme === "light" ? LIGHT_THEME : DARK_THEME;
}

export interface TerminalPaneProps {
	workspaceId: string;
	projectId: string;
	terminal: TerminalMeta;
	visible: boolean;
	/** The shell exited, or the socket will not come back (SPEC.md §9.7). */
	onExited: (terminalId: string) => void;
	onSessionEnded: () => void;
	/** The agent reported the terminal's current directory (SPEC.md §9.3). */
	onCwd: (path: string) => void;
	/** The user clicked or typed in this pane. */
	onFocus: (terminalId: string) => void;
	/** Alt+Shift+Q: move focus out of the terminal to the tab strip. */
	onLeave: () => void;
}

function socketUrl(
	workspaceId: string,
	terminalId: string,
	cols: number,
	rows: number,
): string {
	return wsUrl(
		`/workspaces/${workspaceId}/terminals/${terminalId}/ws?cols=${cols}&rows=${rows}`,
	);
}

/**
 * The most a program in a terminal may put on the system clipboard in one
 * OSC 52 request. Terminal output is untrusted, so a payload larger than this
 * is dropped rather than truncated (SPEC.md §24.2).
 */
export const MAX_CLIPBOARD_BYTES = 100 * 1024;

/** Firefox and older browsers may not expose clipboard reading at all. */
function canReadClipboard(): boolean {
	return typeof navigator.clipboard?.readText === "function";
}

/**
 * The text an OSC 52 copy request carries. The payload is base64, and the
 * bytes inside it are UTF-8, so a URL with an accented character survives.
 * Anything that is not valid base64 is treated as an empty copy.
 */
export function decodeOsc52(encoded: string): string {
	try {
		const binary = atob(encoded);
		const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
		return new TextDecoder().decode(bytes);
	} catch {
		return "";
	}
}

/** Copy to the system clipboard, ignoring a browser that refuses. */
async function writeClipboard(text: string): Promise<void> {
	if (text === "") return;
	try {
		await navigator.clipboard?.writeText(text);
	} catch {
		// Permission denied or no clipboard: nothing the student can act on.
	}
}

/**
 * One xterm.js instance attached to one terminal (SPEC.md §9.1, §9.7). The
 * element stays mounted while its tab exists and is hidden with CSS, so
 * scrollback survives a tab switch. No output is replayed on reconnect.
 */
export function TerminalPane({
	workspaceId,
	projectId,
	terminal,
	visible,
	onExited,
	onSessionEnded,
	onCwd,
	onFocus,
	onLeave,
}: TerminalPaneProps) {
	const host = useRef<HTMLDivElement | null>(null);
	const xterm = useRef<Xterm | null>(null);
	const fit = useRef<FitAddon | null>(null);
	const [reconnecting, setReconnecting] = useState(false);
	const [lost, setLost] = useState(false);
	// Exposed on the pane element so tests can wait for the socket to be open.
	const [connected, setConnected] = useState(false);
	const navigate = useNavigate();
	const toast = useToast();

	// Callbacks the long-lived effect reads through a ref, so that a new
	// render does not tear down the terminal and its socket.
	const handlers = useRef({
		onExited,
		onSessionEnded,
		onCwd,
		onFocus,
		onLeave,
		navigate,
		toast,
		terminalName: terminal.name,
	});
	handlers.current = {
		onExited,
		onSessionEnded,
		onCwd,
		onFocus,
		onLeave,
		navigate,
		toast,
		terminalName: terminal.name,
	};

	// The long-lived effect reads visibility through a ref, for the same reason.
	const visibleRef = useRef(visible);
	visibleRef.current = visible;

	// This terminal's own colour scheme (issue #268). It can change while the
	// terminal is open, so the theme is set on the live instance rather than
	// only at construction.
	const scheme: TerminalTheme = terminal.theme;
	const schemeRef = useRef(scheme);
	schemeRef.current = scheme;
	useEffect(() => {
		if (xterm.current) xterm.current.options.theme = terminalTheme(scheme);
	}, [scheme]);

	const terminalId = terminal.id;

	useEffect(() => {
		const container = host.current;
		if (!container) return;

		function go(link: TerminalLink | null) {
			if (!link) return;
			if (link.kind === "preview") {
				void handlers.current.navigate({ to: link.to, params: link.params });
				return;
			}
			void handlers.current.navigate({
				to: link.to,
				params: link.params,
				search: link.search,
			});
		}

		// True while the keyboard is in this pane; a copy nobody asked for is not
		// allowed to reach the system clipboard (SPEC.md §24.2).
		let focused = false;
		const onFocusIn = () => {
			focused = true;
		};
		const onFocusOut = () => {
			focused = false;
		};
		container.addEventListener("focusin", onFocusIn);
		container.addEventListener("focusout", onFocusOut);

		const term = new Xterm({
			fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
			fontSize: 13,
			theme: terminalTheme(schemeRef.current),
			convertEol: false,
			scrollback: SCROLLBACK_LINES,
		});
		function openUrl(uri: string) {
			const preview = previewRouteFor(uri, workspaceId, projectId);
			if (preview) {
				go(preview);
				return;
			}
			// A workspace URL on a port policy reserves opens nothing, so say
			// why rather than leaving the click with no effect (SPEC.md §14.7).
			const local = localPreviewTarget(uri);
			if (local) {
				handlers.current.toast.show({
					tone: "warning",
					title: `Port ${local.port} cannot be previewed`,
					children: `Previews are for ports ${MIN_PREVIEW_PORT} and above. Run your application on a higher port.`,
				});
				return;
			}
			// Any other URL leaves the app in a new tab, unless it points at
			// the student's own machine or uses a scheme we do not open.
			if (canOpenInNewTab(uri)) {
				window.open(uri, "_blank", "noopener,noreferrer");
			}
		}

		const fitAddon = new FitAddon();
		term.loadAddon(fitAddon);
		// Registered before the web-links addon: where two providers offer a
		// link over the same cells, xterm.js keeps the one registered first, and
		// a URL that wrapped should be one link rather than the fragment the
		// addon finds on this row (SPEC.md §14.9).
		term.registerLinkProvider({
			provideLinks(lineNumber, callback) {
				const links = wrappedUrlsOnRow(
					lineNumber,
					(y) => term.buffer.active.getLine(y - 1)?.translateToString(true) ?? null,
					term.cols,
				).map((link) => ({
					range: link.range,
					text: link.text,
					activate: () => openUrl(link.text),
				}));
				callback(links.length > 0 ? links : undefined);
			},
		});
		term.loadAddon(new WebLinksAddon((_event, uri) => openUrl(uri)));
		// A program in the pane copies by emitting OSC 52, which tmux passes
		// through (SPEC.md §9, §10). A read request ("?") is ignored: nothing in
		// the workspace needs to be handed the student's clipboard.
		term.parser.registerOscHandler(52, (data) => {
			const encoded = data.split(";")[1];
			if (encoded === undefined || encoded === "?") return true;
			// Only the pane the student is actually working in may copy, and only
			// a payload small enough to be a real copy (SPEC.md §24.2).
			if (!visibleRef.current || !focused) return true;
			const text = decodeOsc52(encoded);
			if (text === "") return true;
			// The workspace's own shim allows more than this, so a student can
			// ask for a copy that is refused here. Say so rather than letting
			// the paste come back empty for no visible reason.
			if (new TextEncoder().encode(text).length > MAX_CLIPBOARD_BYTES) {
				handlers.current.toast.show({
					title: `A program in ${handlers.current.terminalName} tried to copy more than 100 KB; nothing was copied.`,
				});
				return true;
			}
			void writeClipboard(text);
			handlers.current.toast.show({
				title: `Copied to your clipboard by a program in ${handlers.current.terminalName}`,
			});
			return true;
		});
		term.open(container);
		xterm.current = term;
		fit.current = fitAddon;
		fitAddon.fit();

		// `src/auth.ts:73` and friends open the file at that line.
		term.registerLinkProvider({
			provideLinks(lineNumber, callback) {
				const line = term.buffer.active
					.getLine(lineNumber - 1)
					?.translateToString(true);
				if (!line) {
					callback(undefined);
					return;
				}
				const pattern = new RegExp(FILE_LINE_PATTERN.source, "g");
				const links = [];
				let found = pattern.exec(line);
				while (found !== null) {
					const route = fileRouteFor(found[0], workspaceId, projectId);
					if (route) {
						const start = found.index + 1;
						links.push({
							range: {
								start: { x: start, y: lineNumber },
								end: { x: start + found[0].length - 1, y: lineNumber },
							},
							text: found[0],
							activate: () => go(route),
						});
					}
					found = pattern.exec(line);
				}
				callback(links.length > 0 ? links : undefined);
			},
		});

		let stopped = false;
		let socket: WebSocket | null = null;
		let retry: ReturnType<typeof setTimeout> | undefined;
		let backoffMs = RECONNECT_MS;
		let attempts = 0;

		function send(message: unknown) {
			if (socket && socket.readyState === WebSocket.OPEN) {
				socket.send(JSON.stringify(message));
			}
		}

		function sendInput(data: string) {
			if (data !== "") send({ type: "input", data });
		}

		/** Read the clipboard and type it into the shell. */
		async function paste(): Promise<boolean> {
			try {
				const text = await navigator.clipboard.readText();
				sendInput(text);
				return true;
			} catch {
				// Firefox may refuse readText; letting the event through means
				// xterm's textarea still receives the browser's own paste.
				return false;
			}
		}

		// True while a full-screen program such as nano or less holds the
		// terminal, as the agent reports it (SPEC.md §9.1).
		let alternateScreen = false;

		/** The height of one row on screen, for turning pixels into lines. */
		const rowHeight = (): number => {
			const row = container.querySelector(".xterm-rows")?.firstElementChild;
			const height = row instanceof HTMLElement ? row.offsetHeight : 0;
			return height > 0 ? height : 17;
		};

		/**
		 * A wheel turn over a full-screen program moves it a line at a time,
		 * the way it does in any terminal: there is nothing of that program's
		 * to scroll, so the notches become arrow keys. Everywhere else the
		 * wheel scrolls the terminal's own scrollback (SPEC.md §9.1).
		 */
		function onWheel(event: WheelEvent) {
			if (!alternateScreen) return;
			// A program that asked to be told about the mouse gets the event.
			if (term.modes.mouseTrackingMode !== "none") return;
			// Stop the terminal scrolling its own buffer instead.
			event.preventDefault();
			event.stopPropagation();
			// A wheel reports pixels, lines, or pages; turn them all into rows.
			let scrolled = Math.abs(event.deltaY);
			if (event.deltaMode === WheelEvent.DOM_DELTA_PIXEL) scrolled /= rowHeight();
			if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) scrolled *= term.rows;
			const notches = Math.min(term.rows, Math.max(1, Math.round(scrolled)));
			const key = term.modes.applicationCursorKeysMode
				? `\u001bO${event.deltaY < 0 ? "A" : "B"}`
				: `\u001b[${event.deltaY < 0 ? "A" : "B"}`;
			sendInput(key.repeat(notches));
		}
		// xterm.js 6 scrolls in its own scrollable element and never calls
		// `attachCustomWheelEventHandler`, so the event has to be caught on the
		// way down, before that element sees it.
		container.addEventListener("wheel", onWheel, { capture: true, passive: false });

		const platform = currentPlatform();
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
			const action = decide(event, term.hasSelection(), platform);
			if (action === "copy") {
				const selection = term.getSelection();
				void writeClipboard(selection);
				clearSelection();
				return false;
			}
			if (action === "paste") {
				// Firefox without readText: let the browser's own paste do the work.
				if (!canReadClipboard()) return true;
				// Returning false only stops xterm's key handling; without this the
				// browser still pastes into xterm's textarea and the text lands twice.
				event.preventDefault();
				void paste();
				return false;
			}
			return true;
		});

		// Selecting text copies it, as it does in a UNIX terminal.
		const selection = term.onSelectionChange(() => {
			if (term.hasSelection()) void writeClipboard(term.getSelection());
		});

		/** Let go of both the terminal's selection and the browser's. */
		function clearSelection() {
			term.clearSelection();
			// The browser settles its own drag selection after the event that
			// asked for the copy, so let go of it once that has happened.
			setTimeout(() => window.getSelection()?.removeAllRanges(), 0);
		}

		function onContextMenu(event: MouseEvent) {
			event.preventDefault();
			if (term.hasSelection()) {
				void writeClipboard(term.getSelection());
				clearSelection();
				return;
			}
			if (canReadClipboard()) void paste();
		}
		container.addEventListener("contextmenu", onContextMenu);

		function onPointerDown() {
			handlers.current.onFocus(terminalId);
		}
		container.addEventListener("pointerdown", onPointerDown);

		// Stop retrying and tell the user, rather than pretending to be live.
		function giveUp() {
			stopped = true;
			setReconnecting(false);
			setLost(true);
		}

		/** Measure the pane and tell the server the size xterm.js now has. */
		const sendSize = () => {
			// A pane with no box on screen cannot be measured; keep the last size.
			if (container.clientWidth !== 0 && container.clientHeight !== 0) {
				fitAddon.fit();
			}
			send({ type: "resize", cols: term.cols, rows: term.rows });
		};

		function connect() {
			if (stopped) return;
			// True once this socket has been told the size the pane really has.
			let sizeConfirmed = false;
			const next = new WebSocket(
				socketUrl(workspaceId, terminalId, term.cols, term.rows),
			);
			next.binaryType = "arraybuffer";
			socket = next;

			next.onopen = () => {
				backoffMs = RECONNECT_MS;
				attempts = 0;
				setReconnecting(false);
				setConnected(true);
			};

			next.onmessage = (event: MessageEvent) => {
				const frame = decodeTerminalFrame(event.data);
				if (frame.kind === "output") {
					term.write(frame.bytes);
					// The size in the connect URL is measured before the pane's box
					// has settled, and a correction sent in the meantime is lost:
					// this socket was not open yet, or the workspace agent had not
					// yet started the PTY. Output means both are ready, so say the
					// size again. Without this tmux keeps repainting a taller
					// screen than xterm.js has, which scrolls the shell prompt out
					// of view and leaves a blank pane (SPEC.md §9.7).
					if (!sizeConfirmed) {
						sizeConfirmed = true;
						sendSize();
					}
					return;
				}
				if (frame.kind === "exit") {
					stopped = true;
					setReconnecting(false);
					setConnected(false);
					handlers.current.onExited(terminalId);
					next.close();
					return;
				}
				if (frame.kind === "cwd") {
					handlers.current.onCwd(frame.path);
					return;
				}
				if (frame.kind === "screen") {
					alternateScreen = frame.alternate;
					return;
				}
				if (frame.kind === "error") {
					term.writeln(`\r\n[portikus] terminal error: ${frame.code}`);
				}
			};

			next.onclose = (event: CloseEvent) => {
				setConnected(false);
				if (stopped) return;
				if (event.code === SESSION_ENDED_CODE) {
					stopped = true;
					handlers.current.onSessionEnded();
					return;
				}
				if (FATAL_CLOSE_CODES.has(event.code)) {
					giveUp();
					return;
				}
				attempts++;
				if (attempts >= MAX_RECONNECT_ATTEMPTS) {
					giveUp();
					return;
				}
				setReconnecting(true);
				const wait = backoffMs;
				backoffMs = Math.min(backoffMs * 2, MAX_RECONNECT_MS);
				retry = setTimeout(connect, wait);
			};
		}

		const input = term.onData((data) => send({ type: "input", data }));

		const observer = new ResizeObserver(() => {
			if (container.clientWidth === 0 || container.clientHeight === 0) return;
			sendSize();
		});
		observer.observe(container);

		connect();

		return () => {
			stopped = true;
			if (retry !== undefined) clearTimeout(retry);
			observer.disconnect();
			container.removeEventListener("wheel", onWheel, { capture: true });
			container.removeEventListener("contextmenu", onContextMenu);
			container.removeEventListener("focusin", onFocusIn);
			container.removeEventListener("focusout", onFocusOut);
			container.removeEventListener("pointerdown", onPointerDown);
			selection.dispose();
			input.dispose();
			socket?.close();
			term.dispose();
			xterm.current = null;
			fit.current = null;
		};
	}, [workspaceId, projectId, terminalId]);

	// A hidden pane has no size, so re-fit when it comes back into view.
	useEffect(() => {
		if (visible) fit.current?.fit();
	}, [visible]);

	return (
		<div
			className="pk-term-screen"
			data-testid={`terminal-pane-${terminalId}`}
			data-connected={connected ? "true" : undefined}
		>
			<div className="pk-terminal-surface" ref={host} />
			{reconnecting && <div className="pk-term-flag">Reconnecting…</div>}
			{lost && (
				<div className="pk-term-flag">
					This terminal lost its connection. Reload the page to try again.
				</div>
			)}
		</div>
	);
}
