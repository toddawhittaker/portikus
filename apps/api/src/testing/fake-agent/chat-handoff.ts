import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { WebSocket } from "@fastify/websocket";
import {
	type ChatClientMessage,
	HANDOFF_NOTES_DIR,
	handoffFirstMessage,
} from "@portikus/contracts";
import type { FakeChat } from "./chat.js";
import { addParents, type FakeNode, nodeKey } from "./fs-model.js";

/** The note the scripted agent writes when asked for a handoff. */
const FAKE_HANDOFF_NOTE =
	"## Goal\n\nFinish the parser.\n\n## Current state\n\nThe tokenizer works.\n\n## Next steps\n\nWrite the parser tests.";

type Send = (
	id: string,
	to: Iterable<WebSocket>,
	event: Record<string, unknown>,
) => void;

interface FakeHandoffDeps {
	chatOf: (id: string) => FakeChat;
	emit: Send;
	record: Send;
	/** The terminal's project directory, whose name is the project's slug. */
	cwdOf: (id: string) => string | undefined;
	filesForKey: (key: string) => Map<string, FakeNode>;
}

/** Starting fresh with a handoff, scripted as the host core runs it (SPEC.md §10.8). */
export function fakeHandoff(deps: FakeHandoffDeps) {
	/** Save a note in the project's tree, as the host saves it under `.portikus/handoffs/`. */
	function save(id: string, key: string, path: string, markdown: string): void {
		const cwd = deps.cwdOf(id);
		if (!cwd) return;
		const slug = basename(cwd);
		const tree = deps.filesForKey(key);
		addParents(tree, slug, path);
		tree.set(nodeKey(slug, path), { type: "file", content: Buffer.from(markdown) });
	}

	/** A scripted turn: the student's message and one reply. */
	function reply(id: string, user: string, answer: string): void {
		const chat = deps.chatOf(id);
		const to = chat.sockets;
		deps.record(id, to, { type: "turn.started", at: Date.now() });
		deps.record(id, to, {
			type: "message",
			id: `m-user-${chat.seq}`,
			role: "user",
			markdown: user,
		});
		deps.record(id, to, {
			type: "message",
			id: `m-reply-${chat.seq}`,
			role: "assistant",
			markdown: answer,
		});
		deps.record(id, to, { type: "turn.finished", at: Date.now(), status: "done" });
	}

	/** Continue: a new conversation, as /clear makes, then the divider and the note as its first message. */
	function continueFrom(id: string): void {
		const chat = deps.chatOf(id);
		const review = chat.review;
		if (!review) return;
		chat.review = null;
		deps.emit(id, chat.sockets, { type: "handoff.review", review: null });
		chat.history = [];
		chat.decisions.clear();
		deps.emit(id, chat.sockets, {
			type: "snapshot",
			cards: chat.openCards,
			turnRunning: false,
			truncated: false,
		});
		deps.emit(id, chat.sockets, {
			type: "settings",
			agent: chat.agent,
			...chat.settings,
		});
		deps.record(id, chat.sockets, {
			type: "handoff.fresh",
			id: randomUUID(),
			path: review.path,
		});
		reply(
			id,
			handoffFirstMessage(review.path, review.markdown),
			"I understand the task: finish the parser.",
		);
	}

	/** Run a handoff message, or a typed `/handoff`; false for any other message. */
	return function handoff(
		id: string,
		key: string,
		message: ChatClientMessage,
	): boolean {
		const chat = deps.chatOf(id);
		const typed = message.type === "send" && message.text.trim() === "/handoff";
		if (typed || message.type === "handoff.start") {
			const stamp = new Date()
				.toISOString()
				.replace(/\.\d{3}Z$/, "Z")
				.replaceAll(":", "-");
			const path = `${HANDOFF_NOTES_DIR}/${stamp}.md`;
			reply(
				id,
				"Write a handoff note so that a fresh conversation can pick up this work.",
				FAKE_HANDOFF_NOTE,
			);
			save(id, key, path, FAKE_HANDOFF_NOTE);
			chat.review = { id: randomUUID(), path, markdown: FAKE_HANDOFF_NOTE };
		} else if (
			message.type !== "handoff.edit" &&
			message.type !== "handoff.cancel" &&
			message.type !== "handoff.continue"
		) {
			return false;
		} else if (chat.review?.id !== message.id) {
			return true;
		} else if (message.type === "handoff.continue") {
			continueFrom(id);
			return true;
		} else if (message.type === "handoff.edit") {
			chat.review = { ...chat.review, markdown: message.markdown };
			save(id, key, chat.review.path, message.markdown);
		} else {
			chat.review = null;
		}
		deps.emit(id, chat.sockets, { type: "handoff.review", review: chat.review });
		return true;
	};
}
