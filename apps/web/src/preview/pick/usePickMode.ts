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
import {
	type AgentDropTarget,
	getAgentDropTargets,
	useAgentDropTargets,
} from "../../agents/agentDropTargets.js";
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

/** The preview pane around `frame`, which holds the pick button. */
function paneOf(frame: HTMLIFrameElement | null): HTMLElement | null {
	return frame?.closest<HTMLElement>(".pk-preview") ?? null;
}

export interface UsePickModeOptions {
	frame: React.RefObject<HTMLIFrameElement | null>;
	/** The preview origin of the frame on show, or null when none is. */
	previewOrigin: string | null;
	/** Changes whenever the frame is pointed somewhere new. */
	frameKey: string | null;
	port: number;
	/** The pick reached `target`, which the menu called `label`. */
	onDelivered: (target: AgentDropTarget, label: string) => void;
	/** The pick could not be handed over. */
	onError: (error: unknown) => void;
}

export interface PickMode {
	state: PickState;
	/** The wrapper's label for the element under the pointer, while picking. */
	hoverLabel: string;
	/** `label` is how the menu named the agent, which the confirmation repeats. */
	start: (target: AgentDropTarget, label: string) => void;
	/** Leave pick mode; also called when the frame loads a page, since a pick belongs to the old one. */
	stop: () => void;
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

/**
 * Escape in the frame would leave the keyboard on the wrapper's empty page,
 * so it moves to the pick button; focus elsewhere stays where it is.
 */
function leaveFrame(own: HTMLIFrameElement | null) {
	if (!own || document.activeElement !== own) return;
	paneOf(own)?.querySelector<HTMLElement>('[data-testid="preview-pick"]')?.focus();
}

export function usePickMode({
	frame,
	previewOrigin,
	frameKey,
	port,
	onDelivered,
	onError,
}: UsePickModeOptions): PickMode {
	const [state, setState] = useState<PickState>("idle");
	const [hoverLabel, setHoverLabel] = useState("");
	// The listener reads these at message time, so it never acts on a stale one.
	const stateRef = useRef<PickState>("idle");
	// The agent is held by id: a pane that registers again under the same id,
	// as a renamed tab or a switched agent does, is still the agent chosen.
	const chosenId = useRef<string | null>(null);
	const chosenLabel = useRef("");
	const callbacks = useRef({ onDelivered, onError });
	callbacks.current = { onDelivered, onError };
	const targets = useAgentDropTargets();
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
		if (next === "idle") chosenId.current = null;
		if (next !== "picking") setHoverLabel("");
	}, []);

	const stop = useCallback(() => {
		if (stateRef.current !== "picking") return;
		post({ v: 1, type: "stop" });
		enter("idle");
	}, [post, enter]);

	const start = useCallback(
		(chosen: AgentDropTarget, label: string) => {
			if (
				stateRef.current !== "idle" ||
				!previewOrigin ||
				!frame.current?.contentWindow
			)
				return;
			chosenId.current = chosen.terminalId;
			chosenLabel.current = label;
			enter("picking");
			// The frame takes the keyboard, so the wrapper's layer can have it.
			frame.current.focus();
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
			if (stateRef.current !== "picking") return;
			if (message.type === "hover") {
				setHoverLabel(message.label);
				return;
			}
			if (message.type === "cancelled") {
				enter("idle");
				if (!message.focusInApp) leaveFrame(frame.current);
				return;
			}
			// The agent's pane may have closed since the pick started.
			const chosen = getAgentDropTargets().find(
				(listed) => listed.terminalId === chosenId.current,
			);
			if (!chosen) {
				enter("idle");
				return;
			}
			enter("delivering");
			const capturedAt = new Date();
			let files: File[];
			try {
				files = pickFiles(message, portRef.current, capturedAt);
			} catch (error) {
				enter("idle");
				callbacks.current.onError(error);
				return;
			}
			const label = chosenLabel.current;
			chosen.deliver(files).then(
				(arrived) => {
					enter("idle");
					// On failure the pane has shown its own toast; the view stays here.
					if (arrived) callbacks.current.onDelivered(chosen, label);
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

	// Escape in the preview pane, or with nothing focused, leaves pick mode.
	// Elsewhere it belongs to what has focus, such as an agent's running turn.
	useEffect(() => {
		if (state !== "picking") return;
		function onKey(event: KeyboardEvent) {
			if (event.key !== "Escape" || event.defaultPrevented) return;
			const active = document.activeElement;
			const inPane =
				active === null ||
				active === document.body ||
				(paneOf(frame.current)?.contains(active) ?? false);
			if (inPane) stop();
		}
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [state, stop, frame]);

	// A new grant, a new port, or the tab closing ends a pick in progress;
	// `stop` is the old frame's, so it tells the old page.
	// biome-ignore lint/correctness/useExhaustiveDependencies: frameKey and port are the triggers
	useEffect(() => () => stop(), [frameKey, port, stop]);

	// Picking for an agent whose pane has closed would send the pick nowhere.
	useEffect(() => {
		if (
			state === "picking" &&
			chosenId.current &&
			!targets.some((listed) => listed.terminalId === chosenId.current)
		)
			stop();
	}, [state, targets, stop]);

	return { state, hoverLabel, start, stop };
}
