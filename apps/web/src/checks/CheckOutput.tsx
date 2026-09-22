import { Terminal as Xterm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import "../terminal.css";
import "./checks.css";
import { FitAddon } from "@xterm/addon-fit";
import { useEffect, useRef } from "react";
import { wsUrl } from "../api/ws.js";
import { useScreenReaderMode } from "../editor/settingsQueries.js";
import { decodeCheckFrame } from "./checkFrames.js";

/** The check panel uses the terminal's colours, so output looks the same. */
const THEME = {
	background: "#11100e",
	foreground: "#e4dfd4",
	cursor: "#11100e",
	selectionBackground: "#3a4a48",
	scrollbarSliderBackground: "#9a938666",
	scrollbarSliderHoverBackground: "#9a9386b3",
	scrollbarSliderActiveBackground: "#9a9386cc",
};

/** Lines of output the panel keeps above the visible screen. */
const SCROLLBACK_LINES = 5_000;

export interface CheckOutputProps {
	workspaceId: string;
	projectId: string;
	checkId: string;
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
	onFinished,
}: CheckOutputProps) {
	const host = useRef<HTMLDivElement | null>(null);
	const finished = useRef(onFinished);
	finished.current = onFinished;
	const term = useRef<Xterm | null>(null);
	// Read at construction and applied live when the student changes it (issue #357).
	const screenReaderMode = useScreenReaderMode();
	const screenReaderRef = useRef(screenReaderMode);
	screenReaderRef.current = screenReaderMode;
	useEffect(() => {
		if (term.current) term.current.options.screenReaderMode = screenReaderMode;
	}, [screenReaderMode]);

	useEffect(() => {
		const container = host.current;
		if (!container) return;

		const xterm = new Xterm({
			fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
			fontSize: 13,
			theme: THEME,
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
					frame.exitCode === 0
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
			data-testid={`check-output-${checkId}`}
			role="log"
			aria-label="Check output"
		>
			<div className="pk-terminal-surface" ref={host} />
		</div>
	);
}
