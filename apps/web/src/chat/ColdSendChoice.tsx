/**
 * The choice a send into a cold chat offers when an automatic handoff note
 * is waiting (SPEC.md §10.8): the next message here would re-read the whole
 * chat at the cache-write price, so sending it to a fresh chat started from
 * the note is the default. Escape closes the choice and keeps the draft.
 */
import { Button } from "@portikus/ui";
import { useEffect, useRef } from "react";
import { useStore } from "zustand";
import { useCacheCold } from "./cacheCold.js";
import type { ChatStore } from "./chatStore.js";
import { type ChatAutoHandoffItem, selectSendableNote } from "./freshStart.js";
import "./handoff.css";

const COLD_SEND_TEXT =
	"The cache has expired, so sending here re-reads this whole chat. Portikus saved a handoff note while you were away.";
export const SEND_FRESH = "Send in a fresh chat from the saved note";
export const SEND_HERE = "Send here anyway";

/** The automatic note a send now should offer to start fresh from; null when none should. */
export function useColdSendNote(store: ChatStore): ChatAutoHandoffItem | null {
	const cold = useCacheCold(store);
	const note = useStore(store, selectSendableNote);
	return cold ? note : null;
}

export function ColdSendChoice({
	onFresh,
	onHere,
	onClose,
}: {
	onFresh: () => void;
	onHere: () => void;
	/** Escape: close the choice and keep the draft. */
	onClose: () => void;
}) {
	const fresh = useRef<HTMLButtonElement | null>(null);
	useEffect(() => {
		fresh.current?.focus();
	}, []);
	return (
		<fieldset
			className="pk-cold-send"
			aria-label="Where to send"
			data-testid="chat-cold-send"
			onKeyDown={(event) => {
				if (event.key !== "Escape") return;
				event.preventDefault();
				event.stopPropagation();
				onClose();
			}}
		>
			<p className="pk-text-caption pk-cold-send-text">{COLD_SEND_TEXT}</p>
			<Button
				ref={fresh}
				size="sm"
				data-testid="chat-cold-send-fresh"
				onClick={onFresh}
			>
				{SEND_FRESH}
			</Button>
			<Button
				size="sm"
				variant="secondary"
				data-testid="chat-cold-send-here"
				onClick={onHere}
			>
				{SEND_HERE}
			</Button>
		</fieldset>
	);
}
