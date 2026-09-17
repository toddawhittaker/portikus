import type { Terminal as TerminalMeta } from "@portikus/contracts";
import { useNavigate } from "@tanstack/react-router";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal as Xterm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import {
	canOpenInNewTab,
	FILE_LINE_PATTERN,
	fileRouteFor,
	previewRouteFor,
	type TerminalLink,
} from "./links";
import { decodeTerminalFrame } from "./terminalFrames";

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

const THEME = {
	background: "#11100e",
	foreground: "#e4dfd4",
	cursor: "#e8c37a",
	selectionBackground: "#3a4a48",
};

export interface TerminalPaneProps {
	workspaceId: string;
	terminal: TerminalMeta;
	visible: boolean;
	onExit: (terminalId: string) => void;
	onSessionEnded: () => void;
}

function socketUrl(
	workspaceId: string,
	terminalId: string,
	cols: number,
	rows: number,
): string {
	const scheme = location.protocol === "https:" ? "wss" : "ws";
	return `${scheme}://${location.host}/workspaces/${workspaceId}/terminals/${terminalId}/ws?cols=${cols}&rows=${rows}`;
}

/**
 * One xterm.js instance attached to one terminal (SPEC.md §9.1, §9.7). The
 * element stays mounted while its tab exists and is hidden with CSS, so
 * scrollback survives a tab switch. No output is replayed on reconnect.
 */
export function TerminalPane({
	workspaceId,
	terminal,
	visible,
	onExit,
	onSessionEnded,
}: TerminalPaneProps) {
	const host = useRef<HTMLDivElement | null>(null);
	const xterm = useRef<Xterm | null>(null);
	const fit = useRef<FitAddon | null>(null);
	const [reconnecting, setReconnecting] = useState(false);
	// Exposed on the pane element so tests can wait for the socket to be open.
	const [connected, setConnected] = useState(false);
	const navigate = useNavigate();

	// Callbacks the long-lived effect reads through a ref, so that a new
	// render does not tear down the terminal and its socket.
	const handlers = useRef({ onExit, onSessionEnded, navigate });
	handlers.current = { onExit, onSessionEnded, navigate };

	const terminalId = terminal.id;
	const ended = terminal.endedAt !== null;

	useEffect(() => {
		const container = host.current;
		if (!container || ended) return;

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

		const term = new Xterm({
			fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
			fontSize: 13,
			theme: THEME,
			convertEol: false,
		});
		const fitAddon = new FitAddon();
		term.loadAddon(fitAddon);
		term.loadAddon(
			new WebLinksAddon((_event, uri) => {
				const preview = previewRouteFor(uri, workspaceId);
				if (preview) {
					go(preview);
					return;
				}
				// Any other URL leaves the app in a new tab, unless it points at
				// the student's own machine or uses a scheme we do not open.
				if (canOpenInNewTab(uri)) {
					window.open(uri, "_blank", "noopener,noreferrer");
				}
			}),
		);
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
					const route = fileRouteFor(found[0], workspaceId);
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

		// Stop retrying and show the tab as ended, with its "New terminal" action.
		function giveUp() {
			stopped = true;
			setReconnecting(false);
			handlers.current.onExit(terminalId);
		}

		function connect() {
			if (stopped) return;
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
					return;
				}
				if (frame.kind === "exit") {
					stopped = true;
					setReconnecting(false);
					setConnected(false);
					handlers.current.onExit(terminalId);
					next.close();
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
			fitAddon.fit();
			send({ type: "resize", cols: term.cols, rows: term.rows });
		});
		observer.observe(container);

		connect();

		return () => {
			stopped = true;
			if (retry !== undefined) clearTimeout(retry);
			observer.disconnect();
			input.dispose();
			socket?.close();
			term.dispose();
			xterm.current = null;
			fit.current = null;
		};
	}, [workspaceId, terminalId, ended]);

	// A hidden pane has no size, so re-fit when it comes back into view.
	useEffect(() => {
		if (visible) fit.current?.fit();
	}, [visible]);

	return (
		<div
			className="pk-terminal-pane"
			hidden={!visible}
			data-testid={`terminal-pane-${terminalId}`}
			data-connected={connected ? "true" : undefined}
		>
			{ended ? (
				<p className="pk-terminal-notice">
					This terminal has ended. Use “New terminal” on its tab to start another.
				</p>
			) : (
				<div className="pk-terminal-surface" ref={host} />
			)}
			{reconnecting && <div className="pk-terminal-overlay">Reconnecting…</div>}
		</div>
	);
}
