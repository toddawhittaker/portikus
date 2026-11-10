/**
 * Reading Claude's replies aloud in a chat tab (ADR 0071): the per-project
 * "Read replies aloud" setting, reading each reply when its turn finishes,
 * and stopping the speech when the student sends, presses Escape or leaves.
 * The reply text goes only to the browser's speech (ADR 0012).
 */
import { ChatLastSettings } from "@portikus/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { request, sendJson } from "../api/request.js";
import { isSpeechSupported, speak, speakingId, stop } from "../voice/speak.js";
import type { ChatMessageItem, ChatState, ChatStore } from "./chatStore.js";
import { chatSettingsUrl } from "./useChatSession.js";

/**
 * The reply to read when a turn has just finished well: the turn's last
 * written message. Tool calls, narration between them and a turn that was
 * stopped or failed are never read.
 */
export function replyToRead(
	previous: Pick<ChatState, "currentTurnId">,
	state: Pick<ChatState, "currentTurnId" | "turns" | "items">,
): ChatMessageItem | null {
	const turnId = previous.currentTurnId;
	if (turnId === null || state.currentTurnId !== null) return null;
	if (state.turns[turnId]?.status !== "done") return null;
	const replies = state.items.filter(
		(item): item is ChatMessageItem =>
			item.kind === "message" &&
			item.role === "assistant" &&
			item.turnId === turnId &&
			item.markdown.trim() !== "",
	);
	return replies.at(-1) ?? null;
}

export interface ReadAloud {
	/** Whether each new reply is read when its turn finishes. */
	on: boolean;
	set: (on: boolean) => void;
}

/** The project's "Read replies aloud" setting, kept on the server beside the pickers. */
export function useReadAloud(workspaceId: string, projectId: string): ReadAloud {
	const [on, setOn] = useState(false);
	const chosen = useRef(false);

	useEffect(() => {
		chosen.current = false;
		let stopped = false;
		request(ChatLastSettings.optional(), chatSettingsUrl(workspaceId, projectId))
			.then((stored) => {
				// A choice made while this loaded is the newer one.
				if (!stopped && !chosen.current) setOn(stored?.readAloud === true);
			})
			// Without the stored value the switch simply starts off.
			.catch(() => {});
		return () => {
			stopped = true;
		};
	}, [workspaceId, projectId]);

	const set = useCallback(
		(next: boolean) => {
			chosen.current = true;
			setOn(next);
			// A save that fails leaves the earlier value; the next change tries again.
			void sendJson(
				z.unknown(),
				chatSettingsUrl(workspaceId, projectId),
				{ readAloud: next },
				"PUT",
			).catch(() => {});
		},
		[workspaceId, projectId],
	);

	return { on, set };
}

/** Reads each reply as its turn finishes, while the chat is showing and the switch is on. */
export function useReadNewReplies(
	store: ChatStore,
	on: boolean,
	visible: boolean,
): void {
	const showing = useRef(visible);
	showing.current = visible;
	useEffect(() => {
		if (!on || !isSpeechSupported()) return;
		return store.subscribe((state, previous) => {
			if (!showing.current) return;
			const reply = replyToRead(previous, state);
			if (reply) speak(reply.id, reply.markdown);
		});
	}, [store, on]);
}

/** Stops what this chat is reading; speech from another chat is left alone. */
function stopIfMine(store: ChatStore): void {
	const reading = speakingId();
	if (reading === null) return;
	const mine = store
		.getState()
		.items.some((item) => item.kind === "message" && item.id === reading);
	if (mine) stop();
}

/** Speech ends when the chat is hidden, closed, or the page is left. */
export function useStopWhenLeaving(store: ChatStore, visible: boolean): void {
	useEffect(() => {
		if (!visible) stopIfMine(store);
	}, [store, visible]);
	useEffect(() => {
		const leaving = () => stop();
		window.addEventListener("pagehide", leaving);
		return () => {
			window.removeEventListener("pagehide", leaving);
			stopIfMine(store);
		};
	}, [store]);
}

/** A menu or dialog is open, and Escape is its to close. */
export function overlayOpen(): boolean {
	return (
		document.querySelector(
			'[role="menu"], [role="dialog"], [role="alertdialog"], [role="listbox"], [aria-haspopup][aria-expanded="true"]',
		) !== null
	);
}
