import { randomUUID } from "node:crypto";
import {
	type ChatCommand,
	HANDOFF_COMMAND,
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
 * resets the conversation and sends the note as its first message. The
 * note is the student's conversation, so none of it is ever logged
 * (ADR 0012).
 */

/** The fixed request for the note. */
export const HANDOFF_PROMPT = `Write a handoff note so that a fresh conversation can pick up this work. Reply with the note only, in Markdown, in about 1,500 words at most. Use these level-2 headings, in this order:

## Goal
## Current state
## Decisions and why
## Files involved
## Tried and failed
## Open questions
## Next steps
## How to check the work

Do not run tools or write files for this. Portikus saves your reply as the note.`;

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
export const HANDOFF_SEND_FAILED_MESSAGE =
	"The handoff could not be sent to the new conversation. Your note is still saved; use Send the handoff again.";

/** A fresh start's divider, as the chat records and replays it. */
export type FreshDivider = Extract<ChatEventBody, { type: "handoff.fresh" }>;

/** What the handoff needs of the chat core. */
export interface FreshStartHost {
	projectDir: string;
	log: Logger;
	/** A reply, a card or a `!` command is running. */
	busy(): boolean;
	/** Send a message the student would have typed. */
	send(text: string): Promise<void>;
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
}

export class FreshStart {
	private stage: "idle" | "asking" | "review" | "continuing" = "idle";
	private review: HandoffReview | null = null;
	private turn: { reply: string; done: (turn: Turn) => void } | null = null;

	constructor(private readonly host: FreshStartHost) {}

	/** A note is being asked for or sent; a swap must wait. */
	get active(): boolean {
		return this.stage === "asking" || this.stage === "continuing";
	}

	/** The review event an attach needs; null when no note waits. */
	reviewEvent(): ChatEventBody | null {
		return this.review ? { type: "handoff.review", review: this.review } : null;
	}

	/** Each event the agent sends, so a turn the handoff started can be read. */
	observe(event: ChatEventBody): void {
		const turn = this.turn;
		if (!turn) return;
		if (event.type === "message" && event.role === "assistant") {
			if (event.markdown.trim() !== "") turn.reply = event.markdown;
		} else if (event.type === "turn.finished") {
			this.turn = null;
			turn.done({ reply: turn.reply, status: event.status });
		}
	}

	/** Ask the agent for the note, save its reply and show it for review. */
	async start(): Promise<void> {
		if (this.stage === "review") throw new Error(HANDOFF_WAITING_MESSAGE);
		if (this.stage !== "idle" || this.host.busy())
			throw new Error(HANDOFF_BUSY_MESSAGE);
		this.stage = "asking";
		try {
			const { reply, status } = await this.sendAndWait(HANDOFF_PROMPT);
			if (status !== "done") throw new Error(HANDOFF_NOT_FINISHED_MESSAGE);
			if (reply.trim() === "") throw new Error(HANDOFF_EMPTY_MESSAGE);
			if (reply.length > MAX_HANDOFF_NOTE_CHARS)
				throw new Error(HANDOFF_TOO_LONG_MESSAGE);
			const path = await writeHandoffNote(this.host.projectDir, reply).catch(() => {
				throw new Error(HANDOFF_SAVE_FAILED_MESSAGE);
			});
			this.host.log.info("handoff note saved");
			this.show({ id: randomUUID(), path, markdown: reply });
		} catch (error) {
			this.stage = "idle";
			throw error;
		}
	}

	/** Replace the note under review, rewriting its file. */
	async edit(id: string, markdown: string): Promise<void> {
		const review = this.waiting(id);
		await rewriteHandoffNote(this.host.projectDir, review.path, markdown).catch(() => {
			throw new Error("The edit could not be saved.");
		});
		this.show({ ...review, markdown });
	}

	/** Keep the conversation as it is; the saved note stays. */
	cancel(id: string): void {
		this.waiting(id);
		this.show(null);
	}

	/** Start the new conversation and send it the note. */
	async continue(id: string): Promise<void> {
		const review = this.waiting(id);
		if (this.host.busy()) throw new Error(HANDOFF_BUSY_MESSAGE);
		this.stage = "continuing";
		this.show(null);
		try {
			await this.host.reset();
		} catch {
			this.show(review);
			throw new Error(HANDOFF_RESET_FAILED_MESSAGE);
		}
		this.host.log.info("chat started fresh from a handoff");
		await this.sendFirst(
			{ type: "handoff.fresh", id: randomUUID(), path: review.path },
			review.markdown,
		);
	}

	/** Send a failed fresh start's first message again, from the note as saved now. */
	async resend(id: string): Promise<void> {
		const divider = this.host.divider(id);
		if (!divider?.failed) throw new Error("That handoff was already sent.");
		if (this.stage !== "idle" || this.host.busy())
			throw new Error(HANDOFF_BUSY_MESSAGE);
		this.stage = "continuing";
		let note: string;
		try {
			note = await readHandoffNote(this.host.projectDir, divider.path);
		} catch {
			this.stage = "idle";
			throw new Error(`The note at ${divider.path} could not be read.`);
		}
		await this.sendFirst(
			{ type: "handoff.fresh", id: divider.id, path: divider.path },
			note,
		);
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
			this.turn = { reply: "", done };
		});
		try {
			await this.host.send(text);
		} catch (error) {
			this.turn = null;
			throw error;
		}
		return finished;
	}

	private waiting(id: string): HandoffReview {
		if (this.stage !== "review" || this.review?.id !== id) {
			throw new Error(HANDOFF_GONE_MESSAGE);
		}
		return this.review;
	}

	private show(review: HandoffReview | null): void {
		this.review = review;
		if (review) this.stage = "review";
		else if (this.stage === "review") this.stage = "idle";
		this.host.broadcast({ type: "handoff.review", review });
	}
}
