/**
 * The assistant's message box: text only. Enter sends, Shift+Enter starts
 * a new line. While a turn runs, Stop takes the place of Send.
 */
import { MAX_CHAT_TEXT_CHARS } from "@portikus/contracts";
import { Button } from "@portikus/ui";
import { useId, useLayoutEffect, useRef, useState } from "react";

export interface AssistantComposerProps {
	/** False when the message could not be sent; the text then stays. */
	onSend: (text: string) => boolean;
	onStop: () => void;
	running: boolean;
	disabled: boolean;
	/** Why sending is off, said under the box. */
	disabledReason?: string;
}

export function AssistantComposer({
	onSend,
	onStop,
	running,
	disabled,
	disabledReason,
}: AssistantComposerProps) {
	const boxId = useId();
	const noteId = useId();
	const [text, setText] = useState("");
	const [error, setError] = useState("");
	const ready = text.trim() !== "" && !disabled;
	const box = useRef<HTMLTextAreaElement>(null);
	const action = useRef<HTMLButtonElement>(null);

	// When a turn ends, Stop turns back into Send, which is off with an empty box; focus held
	// there would be dropped, so it goes to the box where the next message is typed. Checked
	// before paint, while the button still holds focus.
	useLayoutEffect(() => {
		if (!running && document.activeElement === action.current) box.current?.focus();
	}, [running]);

	function send() {
		if (!ready) return;
		if (!onSend(text.trim())) {
			setError(
				"Your message was not sent because the assistant is not connected. Try again in a moment.",
			);
			return;
		}
		setError("");
		setText("");
	}

	return (
		<form
			className="pk-assistant-composer"
			onSubmit={(event) => {
				event.preventDefault();
				send();
			}}
		>
			<label htmlFor={boxId} className="sr-only">
				Message the assistant
			</label>
			<textarea
				ref={box}
				id={boxId}
				className="pk-assistant-box pk-focus-ring"
				data-testid="assistant-input"
				rows={2}
				maxLength={MAX_CHAT_TEXT_CHARS}
				placeholder="Ask about users, workspaces, health or logs"
				value={text}
				aria-describedby={noteId}
				onChange={(event) => setText(event.target.value)}
				onKeyDown={(event) => {
					if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing)
						return;
					event.preventDefault();
					send();
				}}
			/>
			<div className="pk-assistant-composer-row">
				<p id={noteId} className="pk-assistant-muted" data-testid="assistant-note">
					{disabled && disabledReason ? `${disabledReason} ` : null}
					Conversations are kept 30 days and only you can see them.
				</p>
				{running ? (
					<Button
						ref={action}
						type="button"
						variant="secondary"
						data-testid="assistant-stop"
						onClick={onStop}
					>
						Stop
					</Button>
				) : (
					<Button
						ref={action}
						type="submit"
						variant="primary"
						disabled={!ready}
						data-testid="assistant-send"
					>
						Send
					</Button>
				)}
			</div>
			<p className="pk-assistant-card-error" role="alert">
				{error}
			</p>
		</form>
	);
}
