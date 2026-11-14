import { randomUUID } from "node:crypto";
import type { ChatClientMessage } from "@portikus/contracts";
import type { Logger } from "@portikus/observability";
import type { ChatEventBody, ContextFigures } from "./agent.js";
import { AutoHandoff, type Clock } from "./auto-handoff.js";
import type { FreshStart } from "./fresh-start.js";
import {
	type AutoHandoffRecord,
	readAutoHandoff,
	writeAutoHandoff,
} from "./session-record.js";

/**
 * The automatic handoff's notes and notices for one chat (SPEC.md §10.8):
 * the timer, the note it writes, the notices kept for replay, and starting
 * fresh from the newest. None of a note is ever logged (ADR 0012).
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
	startTokens(): number;
	broadcast(event: ChatEventBody): void;
}

export class AutoHandoffNotes {
	private timer: AutoHandoff | null = null;
	/** Notes written in this conversation, oldest first. */
	private notices: AutoHandoffRecord["notices"] = [];
	private saved: Promise<void> = Promise.resolve();

	constructor(private readonly host: AutoHandoffNotesHost) {}

	/** Take up what an earlier host saved and start the timer from its cache figures. */
	async load(): Promise<void> {
		const record = await readAutoHandoff(this.host.homeDir, this.host.terminalId);
		this.notices = record?.notices ?? [];
		this.timer = new AutoHandoff(
			{
				clock: this.host.clock,
				idle: () => this.host.idle(),
				startTokens: () => this.host.startTokens(),
				write: () => this.write(),
				save: () => void this.save(),
			},
			record,
		);
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

	/**
	 * The notices placed in replayed events, each after the turn of the
	 * message that asked for its note. A notice whose message is not in the
	 * events is left out.
	 */
	place(events: ChatEventBody[]): ChatEventBody[] {
		if (this.notices.length === 0) return events;
		const out = [...events];
		for (const { notice, after } of this.notices) {
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
				...notice,
			});
		}
		return out;
	}

	/** Start fresh from the newest note, then send the student's message if any. */
	async continue(
		message: Extract<ChatClientMessage, { type: "handoff.auto.continue" }>,
	): Promise<void> {
		const newest = this.notices.at(-1)?.notice;
		if (newest?.id !== message.id) throw new Error(NOTICE_GONE_MESSAGE);
		await this.host.fresh.continueFromNote(
			newest.path,
			message.text === undefined
				? null
				: { text: message.text, attachments: message.attachments ?? [] },
		);
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
		const notice = { id: randomUUID(), path: note.path, markdown: note.markdown };
		this.notices = [...this.notices, { notice, after: note.promptId }];
		await this.save();
		this.host.log.info("automatic handoff note saved");
		this.host.broadcast({ type: "handoff.auto", ...notice });
	}

	/** Save the state, one write after another so the last one wins. */
	private save(): Promise<void> {
		const written = this.timer?.written ?? false;
		const figures = this.timer?.figures ?? null;
		const record =
			written || figures || this.notices.length > 0
				? { written, figures, notices: this.notices }
				: null;
		this.saved = this.saved.then(() =>
			writeAutoHandoff(this.host.homeDir, this.host.terminalId, record).catch(() =>
				this.host.log.warn("could not record the automatic handoff"),
			),
		);
		return this.saved;
	}
}
