/**
 * A plain text box and Send button, so the chat can be used and tested
 * until the real composer replaces it.
 */
import { Button } from "@portikus/ui";
import { type FormEvent, useId, useState } from "react";
import type { ChatStore } from "./chatStore.js";

export function PlaceholderComposer({ store }: { store: ChatStore }) {
	const id = useId();
	const [text, setText] = useState("");
	const [error, setError] = useState("");

	function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (text.trim() === "") return;
		if (!store.getState().send(text, [])) {
			setError("Your message was not sent because the chat is not connected.");
			return;
		}
		setError("");
		setText("");
	}

	return (
		<form className="pk-chat-placeholder" onSubmit={submit}>
			<label htmlFor={id} className="sr-only">
				Message Claude Code
			</label>
			<textarea
				id={id}
				className="pk-chat-input pk-focus-ring"
				rows={2}
				value={text}
				placeholder="Message Claude Code"
				data-testid="chat-placeholder-input"
				onChange={(event) => setText(event.target.value)}
				onKeyDown={(event) => {
					if (
						event.key === "Enter" &&
						!event.shiftKey &&
						!event.nativeEvent.isComposing
					) {
						event.preventDefault();
						event.currentTarget.form?.requestSubmit();
					}
				}}
			/>
			<Button type="submit" variant="primary" data-testid="chat-placeholder-send">
				Send
			</Button>
			<p className="pk-chat-card-error" role="alert">
				{error}
			</p>
		</form>
	);
}
