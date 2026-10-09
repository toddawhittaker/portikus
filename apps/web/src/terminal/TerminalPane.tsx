import { MAX_UPLOAD_BYTES, type Terminal as TerminalMeta } from "@portikus/contracts";
import { useToast } from "@portikus/ui";
import { useNavigate } from "@tanstack/react-router";
import type { Terminal as Xterm } from "@xterm/xterm";
import { type MutableRefObject, useCallback, useId, useRef, useState } from "react";
import { useScreenReaderMode } from "../editor/settingsQueries.js";
import { fileErrorToast, tooLargeToast } from "../files/errors.js";
import { savePastedImage } from "../files/queries.js";
import {
	canOpenInNewTab,
	FILE_LINE_PATTERN,
	fileRouteFor,
	previewRouteFor,
	type TerminalLink,
} from "../links.js";
import { useProjects } from "../projects/queries.js";
import {
	AGENT_UPGRADED_MESSAGE,
	firstNoticeOf,
	forgetAgentBuild,
	TERMINAL_GONE_NEXT_STEP,
	terminalGoneMessage,
	upgradedAgentNotice,
} from "./terminalFrames.js";
import { openTerminalSocket, type TerminalSocket } from "./terminalSocket.js";
import { useXterm, type XtermSession, type XtermTools } from "./useXterm.js";

// Kept importable from here, where the pane's tests and callers look for them.
export {
	decodeOsc52,
	MAX_CLIPBOARD_BYTES,
	pastedImageType,
	RESIZE_SETTLE_MS,
	sanitizePaste,
	terminalTheme,
} from "./useXterm.js";

export interface TerminalPaneProps {
	workspaceId: string;
	projectId: string;
	terminal: TerminalMeta;
	visible: boolean;
	/** The shell exited, or the socket will not come back (SPEC.md §9.7). */
	onExited: (terminalId: string) => void;
	/** The agent reported the terminal's current directory (SPEC.md §9.3). */
	onCwd: (path: string) => void;
	/** Take the keyboard when this pane first appears. Read at mount only. */
	focusOnMount: boolean;
	/** The user clicked or typed in this pane. */
	onFocus: (terminalId: string) => void;
	/** Alt+Shift+Q: move focus out of the terminal to the tab strip. */
	onLeave: () => void;
	/** Alt+Shift+M held (true) or released (false), for voice input. */
	onVoiceHold?: (held: boolean) => void;
	/** Filled with a function that types dictated text into this terminal. */
	dictation?: MutableRefObject<((text: string) => void) | null>;
}

/** How many names a paste tries before giving up, for pastes in one second. */
export const PASTE_NAME_TRIES = 5;

/**
 * Where a pasted picture is saved, relative to the project root. Attempt 2
 * and later add `-2`, `-3` before the extension.
 */
export function pastePath(now: Date, type: string, attempt = 1): string {
	// One path segment: no colons, no milliseconds, no zone letter.
	const stamp = now.toISOString().slice(0, 19).replaceAll(":", "-");
	const suffix = attempt > 1 ? `-${attempt}` : "";
	return `.portikus/pastes/${stamp}${suffix}.${type === "image/jpeg" ? "jpeg" : "png"}`;
}

/**
 * What the shell receives for a pasted picture: the absolute path, since the
 * shell may be in another directory, and a space instead of a newline so
 * nothing runs (SPEC.md §2.5, §4.4).
 */
export function pastedPathInput(slug: string, path: string): string {
	return `/home/student/projects/${slug}/${path} `;
}

/** Follow a link from the terminal's output into the app. */
function go(navigate: ReturnType<typeof useNavigate>, link: TerminalLink | null) {
	if (!link) return;
	if (link.kind === "preview") {
		void navigate({ to: link.to, params: link.params });
		return;
	}
	void navigate({ to: link.to, params: link.params, search: link.search });
}

/**
 * One xterm.js instance attached to one workspace terminal (SPEC.md §9.1,
 * §9.7). No output is replayed on reconnect.
 */
export function TerminalPane({
	workspaceId,
	projectId,
	terminal,
	visible,
	focusOnMount,
	onExited,
	onCwd,
	onFocus,
	onLeave,
	onVoiceHold,
	dictation,
}: TerminalPaneProps) {
	const host = useRef<HTMLDivElement | null>(null);
	const channel = useRef<TerminalSocket | null>(null);
	const [reconnecting, setReconnecting] = useState(false);
	const [lost, setLost] = useState(false);
	const [tooMany, setTooMany] = useState(false);
	const leaveHintId = useId();
	// Exposed on the pane element so tests can wait for the socket to be open.
	const [connected, setConnected] = useState(false);
	const navigate = useNavigate();
	const toast = useToast();
	const projects = useProjects(workspaceId, "active");
	const projectSlug = projects.data?.find((project) => project.id === projectId)?.slug;
	const screenReaderMode = useScreenReaderMode();
	const terminalId = terminal.id;

	// Callbacks the long-lived attach reads through a ref, so that a new
	// render does not tear down the terminal and its socket.
	const handlers = useRef({ onExited, onCwd, navigate, toast, projectSlug });
	handlers.current = { onExited, onCwd, navigate, toast, projectSlug };

	function sendInput(data: string) {
		if (data !== "") channel.current?.send({ type: "input", data });
	}

	function openUrl(uri: string) {
		const preview = previewRouteFor(uri, workspaceId, projectId);
		if (preview) {
			go(navigate, preview);
			return;
		}
		// Any other URL leaves the app in a new tab, unless it points at
		// the student's own machine or uses a scheme we do not open.
		if (canOpenInNewTab(uri)) {
			window.open(uri, "_blank", "noopener,noreferrer");
		}
	}

	/** Save a pasted picture in the project and type its path. */
	async function pasteImage(image: Blob, type: string) {
		if (image.size > MAX_UPLOAD_BYTES) {
			toast.show(tooLargeToast());
			return;
		}
		if (!projectSlug) {
			// The paste event was already cancelled, so say it failed.
			toast.show(fileErrorToast(null));
			return;
		}
		const now = new Date();
		const paths = Array.from({ length: PASTE_NAME_TRIES }, (_, index) =>
			pastePath(now, type, index + 1),
		);
		try {
			const path = await savePastedImage(workspaceId, projectId, paths, image);
			sendInput(pastedPathInput(projectSlug, path));
		} catch (error) {
			toast.show(fileErrorToast(error));
		}
	}

	const attach = useCallback(
		(term: Xterm, { container, fit }: XtermTools): XtermSession => {
			// `src/auth.ts:73` and friends open the file at that line.
			const fileLinks = term.registerLinkProvider({
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
								activate: () => go(handlers.current.navigate, route),
							});
						}
						found = pattern.exec(line);
					}
					callback(links.length > 0 ? links : undefined);
				},
			});

			function send(message: unknown) {
				channel.current?.send(message);
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
				const data = key.repeat(notches);
				if (data !== "") send({ type: "input", data });
			}
			// xterm.js 6 scrolls in its own scrollable element and never calls
			// `attachCustomWheelEventHandler`, so the event has to be caught on the
			// way down, before that element sees it.
			container.addEventListener("wheel", onWheel, { capture: true, passive: false });

			/** Measure the pane and tell the server the size xterm.js now has. */
			const sendSize = () => {
				fit();
				send({ type: "resize", cols: term.cols, rows: term.rows });
			};

			/** The pane is done with this terminal: stop showing it as live and close it. */
			function ended() {
				setReconnecting(false);
				setConnected(false);
				handlers.current.onExited(terminalId);
			}

			channel.current = openTerminalSocket(workspaceId, terminalId, {
				size: () => ({ cols: term.cols, rows: term.rows }),
				onOpen: () => {
					setReconnecting(false);
					setConnected(true);
				},
				onClose: () => setConnected(false),
				onReconnecting: () => setReconnecting(true),
				// Stop retrying and tell the user, rather than pretending to be live.
				onLost: () => {
					setReconnecting(false);
					setLost(true);
				},
				onTooMany: () => {
					setReconnecting(false);
					setTooMany(true);
				},
				onOutput: (bytes) => term.write(bytes),
				// The size in the connect URL is measured before the pane's box
				// has settled, and a correction sent in the meantime is lost:
				// this socket was not open yet, or the workspace agent had not
				// yet started the PTY. Output means both are ready, so say the
				// size again. Without this tmux keeps repainting a taller
				// screen than xterm.js has, which scrolls the shell prompt out
				// of view and leaves a blank pane (SPEC.md §9.7).
				onFirstOutput: sendSize,
				onExit: ended,
				// The session went with a terminals restart: close the pane
				// and say why, once per restart (SPEC.md §9.7).
				onGone: (frame) => {
					forgetAgentBuild(workspaceId);
					if (firstNoticeOf(frame.at ?? "")) {
						handlers.current.toast.show({
							tone: "warning",
							title: terminalGoneMessage(frame.reason),
							children: TERMINAL_GONE_NEXT_STEP,
						});
					}
					ended();
				},
				onError: (code) => term.writeln(`\r\n[portikus] terminal error: ${code}`),
				onCwd: (path) => handlers.current.onCwd(path),
				onScreen: (alternate) => {
					alternateScreen = alternate;
				},
				// Erase the saved lines only; tmux has already cleared the screen.
				onClear: () => term.write("\u001b[3J"),
				onAgent: (build) => {
					if (upgradedAgentNotice(workspaceId, build)) {
						handlers.current.toast.show({ title: AGENT_UPGRADED_MESSAGE });
					}
				},
			});

			const input = term.onData((data) => send({ type: "input", data }));

			return {
				resized: sendSize,
				dispose: () => {
					channel.current?.stop();
					channel.current = null;
					container.removeEventListener("wheel", onWheel, { capture: true });
					fileLinks.dispose();
					input.dispose();
				},
			};
		},
		[workspaceId, projectId, terminalId],
	);

	useXterm({
		host,
		name: terminal.name,
		theme: terminal.theme,
		screenReaderMode,
		visible,
		focusOnMount,
		describedBy: leaveHintId,
		onFocus: () => onFocus(terminalId),
		onLeave,
		openUrl,
		pasteImage,
		onVoiceHold,
		dictation,
		attach,
	});

	return (
		<div
			className="pk-term-screen"
			data-testid={`terminal-pane-${terminalId}`}
			data-connected={connected ? "true" : undefined}
		>
			<div className="pk-terminal-surface" ref={host} />
			<p id={leaveHintId} hidden>
				Tab goes to the shell. Press Alt+Shift+Q to leave the terminal.
			</p>
			<div role="status">
				{reconnecting && <div className="pk-term-flag">Reconnecting…</div>}
				{lost && (
					<div className="pk-term-flag">
						This terminal lost its connection. Reload the page to try again.
					</div>
				)}
				{tooMany && (
					<div className="pk-term-flag">
						You have too many terminals open across your browser tabs. Close some
						terminals or tabs, then reload the page.
					</div>
				)}
			</div>
		</div>
	);
}
