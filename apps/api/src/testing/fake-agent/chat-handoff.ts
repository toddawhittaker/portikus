import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { WebSocket } from "@fastify/websocket";
import {
	type ChatClientMessage,
	HANDOFF_NOTES_DIR,
	HANDOFF_PROMPT,
	type HandoffNotice,
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
	/** Each chat's caller key, from its last message, for a note written with no message. */
	const keys = new Map<string, string>();
	/** Each chat's newest automatic note, with the text it was saved with. */
	const notices = new Map<string, HandoffNotice & { saved: string }>();
	/** A student's message held while a changed note is under review. */
	const held = new Map<string, string | undefined>();
	/** Chats whose next fresh start fails, as a test set it. */
	const failing = new Set<string>();

	function newPath(): string {
		const stamp = new Date()
			.toISOString()
			.replace(/\.\d{3}Z$/, "Z")
			.replaceAll(":", "-");
		return `${HANDOFF_NOTES_DIR}/${stamp}.md`;
	}

	/** Save a note in the project's tree, as the host saves it under `.portikus/handoffs/`. */
	function save(id: string, key: string, path: string, markdown: string): void {
		const cwd = deps.cwdOf(id);
		if (!cwd) return;
		const slug = basename(cwd);
		const tree = deps.filesForKey(key);
		addParents(tree, slug, path);
		tree.set(nodeKey(slug, path), { type: "file", content: Buffer.from(markdown) });
	}

	/** A note's text as saved in the project's tree now; null when it is gone. */
	function read(id: string, path: string): string | null {
		const cwd = deps.cwdOf(id);
		if (!cwd) return null;
		const node = deps.filesForKey(keys.get(id) ?? "").get(nodeKey(basename(cwd), path));
		return node?.type === "file" ? node.content.toString("utf8") : null;
	}

	/**
	 * The host's check before an unreviewed note is used: unchanged, it is
	 * used; changed, the review card shows the file's text and nothing else
	 * happens. False when the note is not to be used now.
	 */
	function unchanged(
		id: string,
		notice: { path: string; saved: string },
		then?: string,
	): boolean {
		const text = read(id, notice.path);
		if (text === notice.saved) return true;
		const chat = deps.chatOf(id);
		if (text === null) {
			deps.record(id, chat.sockets, {
				type: "error",
				message: `The note at ${notice.path} could not be read.`,
			});
			return false;
		}
		held.set(id, then);
		chat.review = { id: randomUUID(), path: notice.path, markdown: text };
		deps.emit(id, chat.sockets, { type: "handoff.review", review: chat.review });
		return false;
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
	function continueFrom(
		id: string,
		review: { path: string; markdown: string } | null,
		then?: string,
	): void {
		const chat = deps.chatOf(id);
		if (!review) return;
		if (failing.delete(id)) {
			deps.record(id, chat.sockets, {
				type: "error",
				message:
					"A fresh conversation could not be started. Your note is still saved, and the conversation is unchanged.",
			});
			return;
		}
		if (chat.review) {
			chat.review = null;
			deps.emit(id, chat.sockets, { type: "handoff.review", review: null });
		}
		notices.delete(id);
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
		if (then) reply(id, then, "On it.");
	}

	/**
	 * The host's automatic handoff, as if the student had been away until
	 * shortly before the cache went cold: the note's turn, then its notice.
	 */
	function auto(id: string): void {
		const chat = deps.chatOf(id);
		const path = newPath();
		reply(id, HANDOFF_PROMPT, FAKE_HANDOFF_NOTE);
		save(id, keys.get(id) ?? "", path, FAKE_HANDOFF_NOTE);
		const notice = { id: randomUUID(), path };
		notices.set(id, { ...notice, saved: FAKE_HANDOFF_NOTE });
		deps.record(id, chat.sockets, { type: "handoff.auto", ...notice });
	}

	/** Change the newest automatic note's file, as an agent or the editor might. */
	function editNote(id: string, markdown: string): void {
		const notice = notices.get(id);
		if (notice) save(id, keys.get(id) ?? "", notice.path, markdown);
	}

	/** Make the chat's next fresh start fail. */
	function failNext(id: string): void {
		failing.add(id);
	}

	/** Run a handoff message, or a typed `/handoff`; false for any other message. */
	function handoff(
		id: string,
		key: string,
		message: ChatClientMessage,
		from: WebSocket,
	): boolean {
		keys.set(id, key);
		const chat = deps.chatOf(id);
		const typed = message.type === "send" && message.text.trim() === "/handoff";
		if (message.type === "handoff.auto.continue") {
			const notice = notices.get(id);
			if (notice?.id === message.id && unchanged(id, notice, message.text))
				continueFrom(id, { path: notice.path, markdown: notice.saved }, message.text);
			return true;
		}
		if (message.type === "handoff.auto.copy") {
			const notice = notices.get(id);
			if (notice?.id === message.id && unchanged(id, notice)) {
				// To the asker alone, with no seq, as the host sends it.
				from.send(
					JSON.stringify({
						type: "handoff.prompt",
						id: notice.id,
						text: handoffFirstMessage(notice.path, notice.saved),
					}),
				);
			}
			return true;
		}
		if (typed || message.type === "handoff.start") {
			const path = newPath();
			reply(id, HANDOFF_PROMPT, FAKE_HANDOFF_NOTE);
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
			const then = held.get(id);
			held.delete(id);
			continueFrom(id, chat.review, then);
			return true;
		} else if (message.type === "handoff.edit") {
			chat.review = { ...chat.review, markdown: message.markdown };
			save(id, key, chat.review.path, message.markdown);
		} else {
			chat.review = null;
			if (held.get(id) !== undefined) {
				deps.record(id, chat.sockets, {
					type: "error",
					message: "The handoff was cancelled, so your message was not sent.",
				});
			}
			held.delete(id);
		}
		deps.emit(id, chat.sockets, { type: "handoff.review", review: chat.review });
		return true;
	}

	return { handoff, auto, editNote, failNext };
}
