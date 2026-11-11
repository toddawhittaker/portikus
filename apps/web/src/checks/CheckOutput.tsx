import { Terminal as Xterm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import "../terminal/terminal.css";
import "./checks.css";
import { CloseCode, SCROLLBACK_LINES } from "@portikus/contracts";
import { FitAddon } from "@xterm/addon-fit";
import { useEffect, useRef } from "react";
import { wsUrl } from "../api/ws.js";
import { usePageTheme } from "../editor/pageTheme.js";
import { useScreenReaderMode } from "../editor/settingsQueries.js";
import { terminalTheme } from "../terminal/useXterm.js";
import { decodeCheckFrame } from "./checkFrames.js";

/**
 * The output takes the terminal palette of the page's own theme, so it sits
 * in the right pane as a card of the same family rather than a dark slab.
 * The cursor matches the ground: nothing is typed here.
 */
function outputTheme(theme: "light" | "dark"): Record<string, string> {
	const colours = terminalTheme(theme);
	return { ...colours, cursor: colours.background ?? "" };
}

export interface CheckOutputProps {
	workspaceId: string;
	projectId: string;
	checkId: string;
	/** The check's name, for the output's accessible name. */
	name: string;
	/** The run ended; the list refetches so the badge catches up. */
	onFinished: () => void;
}

/**
 * One check run's output, in a read-only xterm panel (SPEC.md §18.1). The
 * command and its real output are shown as they are, and nothing typed here
 * reaches the workspace: this is not a terminal.
 */
export function CheckOutput({
	workspaceId,
	projectId,
	checkId,
	name,
	onFinished,
}: CheckOutputProps) {
	const host = useRef<HTMLDivElement | null>(null);
	const finished = useRef(onFinished);
	finished.current = onFinished;
	const term = useRef<Xterm | null>(null);
	// Read at construction and applied live when the student changes it.
	const screenReaderMode = useScreenReaderMode();
	const screenReaderRef = useRef(screenReaderMode);
	screenReaderRef.current = screenReaderMode;
	useEffect(() => {
		if (term.current) term.current.options.screenReaderMode = screenReaderMode;
	}, [screenReaderMode]);
	const theme = usePageTheme();
	const themeRef = useRef(theme);
	themeRef.current = theme;
	useEffect(() => {
		if (term.current) term.current.options.theme = outputTheme(theme);
	}, [theme]);

	useEffect(() => {
		const container = host.current;
		if (!container) return;

		const xterm = new Xterm({
			fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
			fontSize: 13,
			lineHeight: 1.3,
			theme: outputTheme(themeRef.current),
			// The same floor as the terminals, so dim ANSI colours stay readable.
			minimumContrastRatio: 4.5,
			convertEol: false,
			scrollback: SCROLLBACK_LINES,
			// There is nothing to type into: the panel is output only.
			disableStdin: true,
			cursorStyle: "bar",
			cursorInactiveStyle: "none",
			screenReaderMode: screenReaderRef.current,
		});
		term.current = xterm;
		const fit = new FitAddon();
		xterm.loadAddon(fit);
		xterm.open(container);
		fit.fit();

		const socket = new WebSocket(
			wsUrl(
				`/workspaces/${workspaceId}/projects/${projectId}/checks/${checkId}/runs/current`,
			),
		);

		socket.onmessage = (event: MessageEvent) => {
			const frame = decodeCheckFrame(event.data);
			if (frame.kind === "output") {
				xterm.write(frame.bytes);
				return;
			}
			if (frame.kind === "exit") {
				xterm.writeln(
					frame.stopped
						? `\r\n[portikus] check stopped (exit code ${frame.exitCode})`
						: frame.exitCode === 0
							? "\r\n[portikus] check passed (exit code 0)"
							: `\r\n[portikus] check failed (exit code ${frame.exitCode})`,
				);
				finished.current();
				return;
			}
			if (frame.kind === "error") {
				xterm.writeln("\r\n[portikus] this check could not be started.");
				finished.current();
			}
		};

		socket.onclose = (event: CloseEvent) => {
			if (event.code === CloseCode.TOO_MANY_SOCKETS) {
				xterm.writeln(
					"\r\n[portikus] too many check panels are open across your tabs. Close some, then try again.",
				);
			}
		};

		const observer = new ResizeObserver(() => {
			if (container.clientWidth === 0 || container.clientHeight === 0) return;
			fit.fit();
		});
		observer.observe(container);

		return () => {
			observer.disconnect();
			socket.close();
			xterm.dispose();
			term.current = null;
		};
	}, [workspaceId, projectId, checkId]);

	return (
		<div
			className="pk-check-screen"
			data-terminal-theme={theme}
			data-testid={`check-output-${checkId}`}
			role="log"
			aria-label={name ? `Output of ${name}` : "Check output"}
		>
			<div className="pk-terminal-surface" ref={host} />
		</div>
	);
}
