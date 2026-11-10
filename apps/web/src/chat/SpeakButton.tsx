/**
 * Reads one of Claude's replies aloud, and becomes Stop while it reads
 * (ADR 0071). It is not drawn where the browser cannot speak, and the name
 * changes with the state so a screen reader hears what the button does now
 * (SPEC.md §25.8).
 */
import { IconButton } from "@portikus/ui";
import { isSpeechSupported, speak, stop, useSpeechState } from "../voice/speak.js";
import "./messages.css";

export const READ_ALOUD = "Read aloud";
export const STOP_READING = "Stop reading aloud";

export function SpeakButton({ id, markdown }: { id: string; markdown: string }) {
	const reading = useSpeechState() === id;
	if (!isSpeechSupported()) return null;
	return (
		<span className="pk-chat-speak" data-active={reading ? "" : undefined}>
			<IconButton
				icon={reading ? "stop" : "speaker"}
				size="sm"
				label={reading ? STOP_READING : READ_ALOUD}
				data-testid="chat-speak"
				onClick={() => (reading ? stop() : speak(id, markdown))}
			/>
		</span>
	);
}
