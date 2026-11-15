import { createHash, randomUUID } from "node:crypto";
import {
	type ChatAttachment,
	type ChatCommand,
	HANDOFF_COMMAND,
	HANDOFF_PROMPT,
	HandoffNotePath,
	type HandoffReview,
	handoffFirstMessage,
	MAX_HANDOFF_NOTE_CHARS,
} from "@portikus/contracts";
import type { Logger } from "@portikus/observability";
import {
	readHandoffNote,
	rewriteHandoffNote,
	writeHandoffNote,
} from "../project-files.js";
import type { ChatEventBody } from "./agent.js";

/**
 * Starting fresh with a handoff note (SPEC.md §10.8), the same for every
 * agent. The agent is asked for the note as its reply; the host saves the
 * reply under `.portikus/handoffs/`, the student reviews it, and Continue
 * resets the conversation and sends the note as its first message. A note
 * sent with no review is checked against the hash recorded when it was
 * saved; if its file changed since, the student sees the review card with
 * the file's text first, so nothing they never saw is sent as theirs. The
 * note is the student's conversation, so none of it is ever logged
 * (ADR 0012).
 */

export const HANDOFF_COMMAND_INFO: ChatCommand = {
	name: HANDOFF_COMMAND,
	description: "Start fresh with a handoff note",
	terminalOnly: false,
};

export const HANDOFF_BUSY_MESSAGE =
	"Wait for the reply to finish before starting a handoff.";
export const HANDOFF_WAITING_MESSAGE =
	"A handoff note is already waiting for you to review.";
const HANDOFF_GONE_MESSAGE = "That handoff note is no longer waiting.";
export const HANDOFF_NOT_FINISHED_MESSAGE =
	"The handoff note was not finished, so nothing was saved and the conversation is unchanged.";
export const HANDOFF_EMPTY_MESSAGE =
	"The reply had no handoff note, so nothing was saved and the conversation is unchanged.";
const HANDOFF_TOO_LONG_MESSAGE =
	"The handoff note was too long to save, so the conversation is unchanged.";
const HANDOFF_SAVE_FAILED_MESSAGE =
	"The handoff note could not be saved, so the conversation is unchanged.";
export const HANDOFF_RESET_FAILED_MESSAGE =
	"A fresh conversation could not be started. Your note is still saved, and the conversation is unchanged.";
export const HELD_MESSAGE_KEPT =
	"The handoff was cancelled, so your message was not sent.";
export const HANDOFF_SEND_FAILED_MESSAGE =
	"The handoff could not be sent to the new conversation. Your note is still saved; use Send the handoff again.";

/** A fresh start's divider, as the chat records and replays it. */
export type FreshDivider = Extract<ChatEventBody, { type: "handoff.fresh" }>;

/** The SHA-256 of a note's text, recorded so a later change to its file shows. */
export function noteHash(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/** What the handoff needs of the chat core. */
export interface FreshStartHost {
	projectDir: string;
	log: Logger;
	/** A reply, a card or a `!` command is running. */
	busy(): boolean;
	/** Send a message the student would have typed. */
	send(text: string, attachments?: ChatAttachment[]): Promise<void>;
	/** Move the agent to a new conversation, as /clear does, and wait until it is idle. */
	reset(): Promise<void>;
	broadcast(event: ChatEventBody): void;
	/** Record a divider so a reattach replays it; one with the same id is replaced. */
	recordDivider(divider: FreshDivider): Promise<void>;
	/** A recorded divider by id. */
	divider(id: string): FreshDivider | null;
}

interface Turn {
	reply: string;
	status: "done" | "interrupted" | "error";
	/** The id of the message that started the turn, as the chat shows it. */
	promptId: string | null;
}

/** A note the agent wrote and the host saved, and the message that asked for it. */
export interface SavedNote {
	path: string;
	markdown: string;
	hash: string;
	promptId: string | null;
}

/** The student's message held back to send after the note, from the cold-send choice. */
export interface HeldMessage {
	text: string;
	attachments: ChatAttachment[];
}

/** The note under review, and what Continue does with it. */
interface Waiting {
	shown: HandoffReview;
	/** Sent after the note, as the second message. */
	held: HeldMessage | null;
	/** A failed fresh start to send again, with no new conversation. */
	resendOf: FreshDivider | null;
}

export class FreshStart {
	private stage: "idle" | "asking" | "review" | "continuing" = "idle";
	private review: Waiting | null = null;
	private turn: {
		reply: string;
		promptId: string | null;
		done: (turn: Turn) => void;
	} | null = null;

	constructor(private readonly host: FreshStartHost) {}

	/** A note is being asked for or sent; a swap must wait. */
	get active(): boolean {
		return this.stage === "asking" || this.stage === "continuing";
	}

	/** The review event an attach needs; null when no note waits. */
	reviewEvent(): ChatEventBody | null {
		return this.review ? { type: "handoff.review", review: this.review.shown } : null;
	}

	/** No note is being asked for, waits for review, or is being sent. */
	get idle(): boolean {
		return this.stage === "idle";
	}

	/** Each event the agent sends, so a turn the handoff started can be read. */
	observe(event: ChatEventBody): void {
		const turn = this.turn;
		if (!turn) return;
		if (event.type === "message" && event.role === "assistant") {
			if (event.markdown.trim() !== "") turn.reply = event.markdown;
		} else if (event.type === "message" && turn.promptId === null) {
			turn.promptId = event.id;
		} else if (event.type === "turn.finished") {
			this.turn = null;
			turn.done({ reply: turn.reply, status: event.status, promptId: turn.promptId });
		}
	}

	/** Ask the agent for the note, save its reply and show it for review. */
	async start(): Promise<void> {
		if (this.stage === "review") throw new Error(HANDOFF_WAITING_MESSAGE);
		const note = await this.writeNote();
		this.show({
			shown: { id: randomUUID(), path: note.path, markdown: note.markdown },
			held: null,
			resendOf: null,
		});
	}

	/**
	 * Ask for the note and save it with no review, for the automatic
	 * handoff; the core shows it as a notice.
	 */
	async writeUnreviewed(): Promise<SavedNote> {
		if (this.stage !== "idle") throw new Error(HANDOFF_BUSY_MESSAGE);
		const note = await this.writeNote();
		this.stage = "idle";
		return note;
	}

	/** The note step both handoffs share: ask, check the reply, save it. */
	private async writeNote(): Promise<SavedNote> {
		if (this.stage !== "idle" || this.host.busy())
			throw new Error(HANDOFF_BUSY_MESSAGE);
		this.stage = "asking";
		try {
			const { reply, status, promptId } = await this.sendAndWait(HANDOFF_PROMPT);
			if (status !== "done") throw new Error(HANDOFF_NOT_FINISHED_MESSAGE);
			if (reply.trim() === "") throw new Error(HANDOFF_EMPTY_MESSAGE);
			if (reply.length > MAX_HANDOFF_NOTE_CHARS)
				throw new Error(HANDOFF_TOO_LONG_MESSAGE);
			const path = await writeHandoffNote(this.host.projectDir, reply).catch(() => {
				throw new Error(HANDOFF_SAVE_FAILED_MESSAGE);
			});
			this.host.log.info("handoff note saved");
			return { path, markdown: reply, hash: noteHash(reply), promptId };
		} catch (error) {
			this.stage = "idle";
			throw error;
		}
	}

	/** Replace the note under review, rewriting its file. */
	async edit(id: string, markdown: string): Promise<void> {
		const review = this.waiting(id);
		await rewriteHandoffNote(this.host.projectDir, review.shown.path, markdown).catch(
			() => {
				throw new Error("The edit could not be saved.");
			},
		);
		this.show({ ...review, shown: { ...review.shown, markdown } });
	}

	/** Keep the conversation as it is; the saved note stays, and a held message goes back. */
	cancel(id: string): void {
		const review = this.waiting(id);
		this.show(null);
		if (review.held) throw new Error(HELD_MESSAGE_KEPT);
	}

	/**
	 * Start the new conversation and send it the note as the card shows it,
	 * then any held message; the divider records that text's hash.
	 */
	async continue(id: string): Promise<void> {
		const review = this.waiting(id);
		if (this.host.busy()) throw new Error(HANDOFF_BUSY_MESSAGE);
		const { shown, held, resendOf } = review;
		this.stage = "continuing";
		this.show(null);
		if (!resendOf) {
			try {
				await this.host.reset();
			} catch {
				this.show(review);
				throw new Error(HANDOFF_RESET_FAILED_MESSAGE);
			}
			this.host.log.info("chat started fresh from a handoff");
		}
		await this.sendFirst(
			{
				type: "handoff.fresh",
				id: resendOf?.id ?? randomUUID(),
				path: shown.path,
				hash: noteHash(shown.markdown),
			},
			shown.markdown,
		);
		if (held) await this.host.send(held.text, held.attachments);
	}

	/**
	 * Start the new conversation from a saved note with no review, as
	 * Continue does, then send `then` as its second message. If the file
	 * no longer matches `hash`, nothing is sent: the review card shows the
	 * file's text, and its Continue sends that and then `then`.
	 */
	async continueFromNote(
		path: string,
		hash: string,
		then: HeldMessage | null,
	): Promise<void> {
		this.ready();
		this.stage = "continuing";
		const note = await this.check(path, hash);
		if (!note.same) {
			this.show({
				shown: { id: randomUUID(), path, markdown: note.text },
				held: then,
				resendOf: null,
			});
			return;
		}
		try {
			await this.host.reset();
		} catch {
			this.stage = "idle";
			throw new Error(HANDOFF_RESET_FAILED_MESSAGE);
		}
		this.host.log.info("chat started fresh from a handoff");
		await this.sendFirst(
			{ type: "handoff.fresh", id: randomUUID(), path, hash },
			note.text,
		);
		if (then) await this.host.send(then.text, then.attachments);
	}

	/**
	 * The new conversation's first message from a saved note, to copy; null
	 * when the file changed, and the review card shows it instead.
	 */
	async promptFromNote(path: string, hash: string): Promise<string | null> {
		this.ready();
		this.stage = "continuing";
		const note = await this.check(path, hash);
		if (!note.same) {
			this.show({
				shown: { id: randomUUID(), path, markdown: note.text },
				held: null,
				resendOf: null,
			});
			return null;
		}
		this.stage = "idle";
		return handoffFirstMessage(path, note.text);
	}

	/**
	 * Send a failed fresh start's first message again, from the note as
	 * saved now if it still matches the divider's hash, else through the
	 * review card.
	 */
	async resend(id: string): Promise<void> {
		const divider = this.host.divider(id);
		if (!divider?.failed) throw new Error("That handoff was already sent.");
		const path = HandoffNotePath.safeParse(divider.path);
		if (!path.success) throw new Error("That handoff note could not be read.");
		this.ready();
		this.stage = "continuing";
		// A divider recorded before hashes were kept has none to match.
		const note = await this.check(path.data, divider.hash ?? "");
		if (!note.same) {
			this.show({
				shown: { id: randomUUID(), path: path.data, markdown: note.text },
				held: null,
				resendOf: divider,
			});
			return;
		}
		await this.sendFirst(
			{ type: "handoff.fresh", id: divider.id, path: path.data, hash: divider.hash },
			note.text,
		);
	}

	/** Nothing else is under way, so a note can be sent. */
	private ready(): void {
		if (this.stage === "review") throw new Error(HANDOFF_WAITING_MESSAGE);
		if (this.stage !== "idle" || this.host.busy())
			throw new Error(HANDOFF_BUSY_MESSAGE);
	}

	/** Read a saved note and say whether it is still the text `hash` names. */
	private async check(
		path: string,
		hash: string,
	): Promise<{ text: string; same: boolean }> {
		let text: string;
		try {
			text = await readHandoffNote(this.host.projectDir, path);
		} catch {
			this.stage = "idle";
			throw new Error(`The note at ${path} could not be read.`);
		}
		const same = noteHash(text) === hash;
		if (!same && text.length > MAX_HANDOFF_NOTE_CHARS) {
			this.stage = "idle";
			throw new Error(HANDOFF_TOO_LONG_MESSAGE);
		}
		return { text, same };
	}

	private async sendFirst(divider: FreshDivider, note: string): Promise<void> {
		try {
			await this.recordDivider(divider);
			let status: Turn["status"] = "error";
			try {
				({ status } = await this.sendAndWait(handoffFirstMessage(divider.path, note)));
			} catch {
				// Told below, as a failed turn is.
			}
			if (status === "error") {
				await this.recordDivider({ ...divider, failed: true });
				throw new Error(HANDOFF_SEND_FAILED_MESSAGE);
			}
		} finally {
			this.stage = "idle";
		}
	}

	private async recordDivider(divider: FreshDivider): Promise<void> {
		await this.host.recordDivider(divider);
		this.host.broadcast(divider);
	}

	/** Send, and resolve once the turn it starts has finished. */
	private async sendAndWait(text: string): Promise<Turn> {
		const finished = new Promise<Turn>((done) => {
			this.turn = { reply: "", promptId: null, done };
		});
		try {
			await this.host.send(text);
		} catch (error) {
			this.turn = null;
			throw error;
		}
		return finished;
	}

	private waiting(id: string): Waiting {
		if (this.stage !== "review" || this.review?.shown.id !== id) {
			throw new Error(HANDOFF_GONE_MESSAGE);
		}
		return this.review;
	}

	private show(review: Waiting | null): void {
		this.review = review;
		if (review) this.stage = "review";
		else if (this.stage === "review") this.stage = "idle";
		this.host.broadcast({ type: "handoff.review", review: review?.shown ?? null });
	}
}
