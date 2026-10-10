/**
 * The hold-to-talk microphone button shared by terminals and open files
 * (SPEC.md §25.10, ADR 0055).
 */
import { IconButton } from "@portikus/ui";
import { useEffect, useRef } from "react";
import { endsVoiceShortcut, isVoiceShortcut } from "./shortcut.js";
import type { SpeechInput } from "./useSpeechInput.js";

export interface VoiceButtonProps {
	testId: string;
	statusTestId: string;
	label: string;
	/** Said when a click with no pointer press behind it cannot be held. */
	hint: string;
	voice: SpeechInput;
	/** Where focus goes if the button vanishes under the keyboard. */
	focusTarget: () => void;
}

/**
 * Hold to talk: listening lasts while the pointer, Space/Enter, or
 * Alt+Shift+M is down (SPEC.md §25.10). The status region stays mounted,
 * even when voice turns out to be unsupported, so its changes are read.
 */
export function VoiceButton({
	testId,
	statusTestId,
	label,
	hint,
	voice,
	focusTarget,
}: VoiceButtonProps) {
	const listening = voice.state === "listening";
	const unsupported = voice.state === "unsupported";
	const button = useRef<HTMLButtonElement | null>(null);
	// The button is about to vanish under the keyboard; checked while it is
	// still in the document, so focus can go to the target, not the page.
	const refocus = useRef(false);
	if (unsupported && button.current && document.activeElement === button.current) {
		refocus.current = true;
	}
	useEffect(() => {
		if (!unsupported || !refocus.current) return;
		refocus.current = false;
		focusTarget();
	});
	return (
		<>
			{unsupported ? null : (
				<IconButton
					ref={button}
					icon="mic"
					label={label}
					shortcut={["Alt", "Shift", "M"]}
					size="sm"
					aria-pressed={listening}
					data-testid={testId}
					onPointerDown={(event) => {
						if (event.button !== 0) return;
						event.currentTarget.setPointerCapture?.(event.pointerId);
						voice.start();
					}}
					onPointerUp={voice.stop}
					onPointerCancel={voice.stop}
					onLostPointerCapture={voice.stop}
					onKeyDown={(event) => {
						const hold = event.key === " " || event.key === "Enter";
						if (!hold && !isVoiceShortcut(event.nativeEvent)) return;
						event.preventDefault();
						if (!event.repeat) voice.start();
					}}
					onKeyUp={(event) => {
						if (event.key === " " || event.key === "Enter") {
							// No click after a hold, so only a click from assistive
							// technology reaches onClick below.
							event.preventDefault();
							voice.stop();
						} else if (listening && endsVoiceShortcut(event.nativeEvent)) {
							voice.stop();
						}
					}}
					onClick={(event) => {
						// A click with no pointer press behind it cannot be held.
						if (event.detail === 0) voice.explain(hint);
					}}
					onBlur={voice.stop}
				/>
			)}
			<span
				role="status"
				aria-live="polite"
				className="sr-only"
				data-testid={statusTestId}
			>
				{voice.message}
			</span>
		</>
	);
}
