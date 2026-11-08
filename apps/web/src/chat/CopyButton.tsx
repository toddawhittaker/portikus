/**
 * Copies a message, a code block or a tool's output as the raw text it holds
 * (SPEC.md §10.8). The button shows on hover and on keyboard focus, and a
 * short, polite status says what happened (SPEC.md §25.8).
 */
import { IconButton } from "@portikus/ui";
import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import "./messages.css";

/** How long "Copied" stays; a failure stays longer, as it asks something of the reader. */
export const COPIED_FOR_MS = 2000;
const NOT_COPIED_FOR_MS = 6000;
export const COPIED = "Copied";
export const NOT_COPIED = "Could not copy. Select the text instead.";

export function CopyButton({
	label,
	text,
}: {
	/** The button's name, saying what it copies: "Copy code". */
	label: string;
	/** The text, or a function that reads it at the moment of copying. */
	text: string | (() => string);
}) {
	const [said, setSaid] = useState("");
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(() => () => clearTimeout(timer.current), []);

	async function copy() {
		clearTimeout(timer.current);
		// Emptied first, so a second copy is announced again.
		flushSync(() => setSaid(""));
		let result = COPIED;
		try {
			await navigator.clipboard.writeText(typeof text === "function" ? text() : text);
		} catch {
			result = NOT_COPIED;
		}
		setSaid(result);
		timer.current = setTimeout(
			() => setSaid(""),
			result === COPIED ? COPIED_FOR_MS : NOT_COPIED_FOR_MS,
		);
	}

	return (
		<span className="pk-chat-copy" data-said={said ? "" : undefined}>
			<IconButton
				icon={said === COPIED ? "check" : "copy"}
				size="sm"
				label={label}
				onClick={() => void copy()}
			/>
			<span className="pk-chat-copy-said" role="status">
				{said}
			</span>
		</span>
	);
}
