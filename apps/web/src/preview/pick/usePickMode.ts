/**
 * Pick mode on the Portikus side of the preview (SPEC.md §14.6, §24).
 *
 * The wrapper page runs on the preview origin beside the student's code, so
 * whatever it sends is untrusted. A message counts only when it comes from
 * the grant's preview origin, from the preview frame's own window, and fits
 * the message schema. A pick counts only while the student has pick mode on,
 * and only the first one per start. Nothing in a pick chooses the agent, the
 * file names or the port; the student and this page do.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentDropTarget } from "../../agents/agentDropTargets.js";
import type { PickedMessage } from "./messages.js";
import {
	type ParentMessage,
	PICK_PNG_MAX_BYTES,
	parseWrapperMessage,
} from "./messages.js";
import {
	buildPickFile,
	checkPng,
	PICK_MARKDOWN_FILE_NAME,
	PICK_PNG_FILE_NAME,
	type ScreenshotStatus,
} from "./pickFile.js";

type PickState = "idle" | "picking" | "delivering";

export interface UsePickModeOptions {
	frame: React.RefObject<HTMLIFrameElement | null>;
	/** The preview origin of the frame on show, or null when none is. */
	previewOrigin: string | null;
	/** Changes whenever the frame is pointed somewhere new. */
	frameKey: string | null;
	port: number;
	/** The wrapper said its page loaded. */
	onLoaded: () => void;
	/** The pick reached `target`. */
	onDelivered: (target: AgentDropTarget) => void;
	/** The pick could not be handed over. */
	onError: (error: unknown) => void;
}

export interface PickMode {
	state: PickState;
	/** The agent the current pick goes to. */
	targetId: string | null;
	/** The wrapper's label for the element under the pointer, while picking. */
	hoverLabel: string;
	start: (target: AgentDropTarget) => void;
	stop: () => void;
	/** The frame loaded a page; any pick in progress belongs to the old one. */
	frameLoaded: () => void;
}

function screenshotOf(pick: PickedMessage): ScreenshotStatus {
	if (!pick.png) return "not-sent";
	if (checkPng(pick.png, PICK_PNG_MAX_BYTES)) return "included";
	return pick.png.byteLength > PICK_PNG_MAX_BYTES ? "too-large" : "not-a-png";
}

/** The two files a pick becomes, with names and types set here. */
function pickFiles(pick: PickedMessage, port: number, capturedAt: Date): File[] {
	const screenshot = screenshotOf(pick);
	const files = [
		new File(
			[buildPickFile({ pick, port, capturedAt, screenshot })],
			PICK_MARKDOWN_FILE_NAME,
			{
				type: "text/markdown",
			},
		),
	];
	if (screenshot === "included" && pick.png) {
		files.push(new File([pick.png], PICK_PNG_FILE_NAME, { type: "image/png" }));
	}
	return files;
}

export function usePickMode({
	frame,
	previewOrigin,
	frameKey,
	port,
	onLoaded,
	onDelivered,
	onError,
}: UsePickModeOptions): PickMode {
	const [state, setState] = useState<PickState>("idle");
	const [targetId, setTargetId] = useState<string | null>(null);
	const [hoverLabel, setHoverLabel] = useState("");
	// The listener reads these at message time, so it never acts on a stale one.
	const stateRef = useRef<PickState>("idle");
	const target = useRef<AgentDropTarget | null>(null);
	const callbacks = useRef({ onLoaded, onDelivered, onError });
	callbacks.current = { onLoaded, onDelivered, onError };
	const portRef = useRef(port);
	portRef.current = port;

	const post = useCallback(
		(message: ParentMessage) => {
			const window = frame.current?.contentWindow;
			if (!window || !previewOrigin) return;
			window.postMessage(message, previewOrigin);
		},
		[frame, previewOrigin],
	);

	const enter = useCallback((next: PickState) => {
		stateRef.current = next;
		setState(next);
		if (next === "idle") {
			target.current = null;
			setTargetId(null);
		}
		if (next !== "picking") setHoverLabel("");
	}, []);

	const stop = useCallback(() => {
		if (stateRef.current !== "picking") return;
		post({ v: 1, type: "stop" });
		enter("idle");
	}, [post, enter]);

	const start = useCallback(
		(chosen: AgentDropTarget) => {
			if (
				stateRef.current !== "idle" ||
				!previewOrigin ||
				!frame.current?.contentWindow
			)
				return;
			target.current = chosen;
			setTargetId(chosen.terminalId);
			enter("picking");
			post({ v: 1, type: "start" });
		},
		[previewOrigin, frame, post, enter],
	);

	// Listen only while there is a frame to hear from.
	useEffect(() => {
		if (!previewOrigin) return;
		const origin = previewOrigin;
		function onMessage(event: MessageEvent) {
			if (event.origin !== origin) return;
			const own = frame.current?.contentWindow;
			if (!own || event.source !== own) return;
			const message = parseWrapperMessage(event.data);
			if (!message) return;
			if (message.type === "loaded") {
				callbacks.current.onLoaded();
				return;
			}
			if (stateRef.current !== "picking") return;
			if (message.type === "hover") {
				setHoverLabel(message.label);
				return;
			}
			if (message.type === "cancelled") {
				enter("idle");
				return;
			}
			const chosen = target.current;
			enter("delivering");
			if (!chosen) {
				enter("idle");
				return;
			}
			const capturedAt = new Date();
			let files: File[];
			try {
				files = pickFiles(message, portRef.current, capturedAt);
			} catch (error) {
				enter("idle");
				callbacks.current.onError(error);
				return;
			}
			chosen.deliver(files).then(
				() => {
					enter("idle");
					callbacks.current.onDelivered(chosen);
				},
				(error: unknown) => {
					enter("idle");
					callbacks.current.onError(error);
				},
			);
		}
		window.addEventListener("message", onMessage);
		return () => window.removeEventListener("message", onMessage);
	}, [previewOrigin, frame, enter]);

	// Escape anywhere in the Portikus page leaves pick mode.
	useEffect(() => {
		if (state !== "picking") return;
		function onKey(event: KeyboardEvent) {
			if (event.key === "Escape") stop();
		}
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [state, stop]);

	// A new grant, a new port, or the tab closing ends a pick in progress;
	// `stop` is the old frame's, so it tells the old page.
	// biome-ignore lint/correctness/useExhaustiveDependencies: frameKey and port are the triggers
	useEffect(() => () => stop(), [frameKey, port, stop]);

	const frameLoaded = useCallback(() => stop(), [stop]);

	return { state, targetId, hoverLabel, start, stop, frameLoaded };
}
