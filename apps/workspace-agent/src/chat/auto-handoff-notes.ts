import { randomUUID } from "node:crypto";
import type { ChatClientMessage } from "@portikus/contracts";
import type { Logger } from "@portikus/observability";
import type { ChatEventBody, ContextFigures } from "./agent.js";
import { AutoHandoff, type Clock } from "./auto-handoff.js";
import type { FreshStart } from "./fresh-start.js";
import {
	type AutoHandoffRecord,
	MAX_AUTO_NOTICES,
	readAutoHandoff,
	writeAutoHandoff,
} from "./session-record.js";

/** How the conversation has grown, which the core counts and this keeps across a restart. */
export type ChatGrowth = NonNullable<AutoHandoffRecord["growth"]>;

/** A conversation that has not started. */
export const NO_GROWTH: ChatGrowth = {
	startTokens: 0,
	messages: 0,
	requests: 0,
	firstMessageTokens: 0,
	firstMessageRequests: 0,
	doneMessages: 0,
	doneTokens: 0,
	doneRequests: 0,
};

/**
 * The automatic handoff's notes and notices for one chat (SPEC.md §10.8):
 * the timer, the note it writes, the notices kept for replay, and starting
 * fresh from the newest. A notice keeps its note's path and hash, never its
 * text. None of a note is ever logged (ADR 0012).
 */

const NOTICE_GONE_MESSAGE = "That handoff note is no longer offered.";

export interface AutoHandoffNotesHost {
	homeDir: string;
	terminalId: string;
	log: Logger;
	clock: Clock;
	fresh: FreshStart;
	/** Nothing is running: no reply, card, `!` command, handoff or swap. */
	idle(): boolean;
	/** The conversation's growth, kept so a restarted host knows its start size. */
	growth(): ChatGrowth;
	broadcast(event: ChatEventBody): void;
}

export class AutoHandoffNotes {
	private timer: AutoHandoff | null = null;
	/** Notes written in this conversation, oldest first. */
	private notices: AutoHandoffRecord["notices"] = [];
	private saved: Promise<void> = Promise.resolve();
	/** The state as last written, so an unchanged one is not written again. */
	private written: string | undefined;

	constructor(private readonly host: AutoHandoffNotesHost) {}

	/**
	 * Take up what an earlier host saved and start the timer from its cache
	 * figures. Returns the saved growth, for the core to take up; null when
	 * none was kept.
	 */
	async load(): Promise<ChatGrowth | null> {
		const record = await readAutoHandoff(this.host.homeDir, this.host.terminalId);
		this.notices = record?.notices ?? [];
		this.written = record ? JSON.stringify(record) : JSON.stringify(null);
		this.timer = new AutoHandoff(
			{
				clock: this.host.clock,
				idle: () => this.host.idle(),
				startTokens: () => this.host.growth().startTokens,
				firstMessageTokens: () => this.host.growth().firstMessageTokens,
				write: () => this.write(),
				save: () => void this.save(),
			},
			record,
		);
		return record?.growth ?? null;
	}

	/** The core's growth changed; kept if it differs from what is saved. */
	growthChanged(): void {
		if (this.timer) void this.save();
	}

	update(figures: ContextFigures): void {
		this.timer?.update(figures);
	}

	studentSent(): void {
		this.timer?.studentSent();
	}

	/** A new conversation: its notices and timer start over. */
	reset(): void {
		this.notices = [];
		this.timer?.reset();
	}

	stop(): void {
		this.timer?.stop();
	}

	/** Resolves once every queued save has finished, so a stopped core leaves no write behind. */
	settled(): Promise<void> {
		return this.saved;
	}

	/**
	 * The notices placed in replayed events, each after the turn of the
	 * message that asked for its note. A notice whose message is not in the
	 * events is left out.
	 */
	place(events: ChatEventBody[]): ChatEventBody[] {
		if (this.notices.length === 0) return events;
		const out = [...events];
		for (const { id, path, after } of this.notices) {
			const at = out.findIndex(
				(event) =>
					event.type === "message" && event.role === "user" && event.id === after,
			);
			if (at === -1) continue;
			const next = out.findIndex(
				(event, index) =>
					index > at && event.type === "message" && event.role === "user",
			);
			out.splice(next === -1 ? out.length : next, 0, {
				type: "handoff.auto",
				id,
				path,
			});
		}
		return out;
	}

	/** Start fresh from the newest note, then send the student's message if any. */
	async continue(
		message: Extract<ChatClientMessage, { type: "handoff.auto.continue" }>,
	): Promise<void> {
		const newest = this.newest(message.id);
		await this.host.fresh.continueFromNote(
			newest.path,
			newest.hash,
			message.text === undefined
				? null
				: { text: message.text, attachments: message.attachments ?? [] },
		);
	}

	/** The newest note's first message to copy; null when its file changed and the review card shows it. */
	copy(id: string): Promise<string | null> {
		const newest = this.newest(id);
		return this.host.fresh.promptFromNote(newest.path, newest.hash);
	}

	private newest(id: string): AutoHandoffRecord["notices"][number] {
		const newest = this.notices.at(-1);
		if (newest?.id !== id) throw new Error(NOTICE_GONE_MESSAGE);
		return newest;
	}

	/** Write a note with no review and post its notice; the student is away, so a failure is only logged. */
	private async write(): Promise<void> {
		let note: Awaited<ReturnType<FreshStart["writeUnreviewed"]>>;
		try {
			note = await this.host.fresh.writeUnreviewed();
		} catch {
			this.host.log.warn("automatic handoff note not written");
			return;
		}
		const notice = { id: randomUUID(), path: note.path };
		this.notices = [
			...this.notices,
			{ ...notice, hash: note.hash, after: note.promptId },
		].slice(-MAX_AUTO_NOTICES);
		await this.save();
		this.host.log.info("automatic handoff note saved");
		this.host.broadcast({ type: "handoff.auto", ...notice });
	}

	/** Save the state if it changed, one write after another so the last one wins. */
	private save(): Promise<void> {
		const written = this.timer?.written ?? false;
		const figures = this.timer?.figures ?? null;
		const growth = this.host.growth();
		const record =
			written || figures || growth.startTokens > 0 || this.notices.length > 0
				? { written, figures, growth: { ...growth }, notices: this.notices }
				: null;
		const text = JSON.stringify(record);
		if (text === this.written) return this.saved;
		this.written = text;
		this.saved = this.saved.then(() =>
			writeAutoHandoff(this.host.homeDir, this.host.terminalId, record).catch(() =>
				this.host.log.warn("could not record the automatic handoff"),
			),
		);
		return this.saved;
	}
}
