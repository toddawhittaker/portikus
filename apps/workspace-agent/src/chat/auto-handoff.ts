import { HANDOFF_TOKENS } from "@portikus/contracts";
import type { ContextFigures } from "./agent.js";

/**
 * The automatic handoff's timer (SPEC.md §10.8). While the student is away
 * from a long chat, it asks for a handoff note shortly before the prompt
 * cache goes cold, while reading the chat is still cheap. Claude's one-hour
 * cache and Codex's 30-minute one qualify; Claude's five-minute one does not.
 * It lives in the host, so it works with no browser attached.
 */

/** How long before the cache goes cold the note is written. */
export const AUTO_HANDOFF_LEAD_MS = 10 * 60 * 1000;
/** The shortest cache lifetime worth a note. */
const MIN_TTL_SECONDS = 1800;

/** Time, injectable so tests never sleep. */
export interface Clock {
	now(): number;
	/** Call `fire` after `ms`; the returned function cancels it. */
	after(ms: number, fire: () => void): () => void;
}

export const systemClock: Clock = {
	now: () => Date.now(),
	after(ms, fire) {
		const timer = setTimeout(fire, ms);
		timer.unref();
		return () => clearTimeout(timer);
	},
};

export interface AutoHandoffHost {
	clock: Clock;
	/** Nothing is running: no reply, card, `!` command, handoff or swap. */
	idle(): boolean;
	/** The conversation's first used-token figure, which a fresh chat starts near; 0 when unknown. */
	startTokens(): number;
	/** The context size when the first message finished; 0 until it has. */
	firstMessageTokens(): number;
	/** Write the note and post the notice. */
	write(): Promise<void>;
	/** Keep `written` and `figures`, so a restarted host takes up where this one was. */
	save(): void;
}

/** When the cache these figures describe goes cold; null when none long enough is reported. */
function cacheColdAt(figures: ContextFigures): number | null {
	const cache = figures.cache;
	if (!cache || cache.ttlSeconds < MIN_TTL_SECONDS) return null;
	return cache.at + cache.ttlSeconds * 1000;
}

/**
 * Whether a chat this size is worth a note: twice the size a fresh chat
 * reaches once it has repeated this chat's warm-up, its first message, as
 * the fresh-chat estimate assumes (SPEC.md §10.8). With no warm-up recorded
 * the fresh chat is its start; with no known start, as after a restart that
 * lost it, nothing is worth one.
 */
function bigEnough(
	usedTokens: number,
	startTokens: number,
	firstMessageTokens: number,
): boolean {
	if (startTokens <= 0) return false;
	const warmup = Math.max(0, firstMessageTokens - startTokens);
	return usedTokens >= 2 * (startTokens + HANDOFF_TOKENS + warmup);
}

export class AutoHandoff {
	private cancel: (() => void) | null = null;
	private latest: ContextFigures | null;
	private wroteThisIdle: boolean;

	/** Starts from what an earlier host saved: whether it wrote a note in this idle period, and its figures. */
	constructor(
		private readonly host: AutoHandoffHost,
		saved: { written: boolean; figures: ContextFigures | null } | null,
	) {
		this.wroteThisIdle = saved?.written ?? false;
		this.latest = saved?.figures ?? null;
		this.schedule();
	}

	/** The cache figures the timer aims at. */
	get figures(): ContextFigures | null {
		return this.latest;
	}

	/** A note was written in this idle period. */
	get written(): boolean {
		return this.wroteThisIdle;
	}

	/** New context figures: aim the timer at this cache's cold time. */
	update(figures: ContextFigures): void {
		this.latest = figures;
		this.host.save();
		this.schedule();
	}

	/** The student sent a message: the next idle period may have a note of its own. */
	studentSent(): void {
		this.setWritten(false);
	}

	/** A new conversation began: nothing to write until it has figures of its own. */
	reset(): void {
		this.stop();
		this.latest = null;
		this.wroteThisIdle = false;
		this.host.save();
	}

	stop(): void {
		this.cancel?.();
		this.cancel = null;
	}

	private schedule(): void {
		this.stop();
		// Writing the note refreshes the cache; one note per idle period.
		if (this.wroteThisIdle || !this.latest) return;
		const coldAt = cacheColdAt(this.latest);
		if (coldAt === null) return;
		const wait = Math.max(0, coldAt - AUTO_HANDOFF_LEAD_MS - this.host.clock.now());
		this.cancel = this.host.clock.after(wait, () => void this.fire(coldAt));
	}

	private async fire(coldAt: number): Promise<void> {
		this.cancel = null;
		const figures = this.latest;
		// A failed condition waits for the next idle period; nothing retries now.
		if (
			!figures ||
			this.wroteThisIdle ||
			this.host.clock.now() >= coldAt ||
			!this.host.idle() ||
			!bigEnough(
				figures.usedTokens,
				this.host.startTokens(),
				this.host.firstMessageTokens(),
			)
		) {
			return;
		}
		this.setWritten(true);
		await this.host.write().catch(() => undefined);
	}

	private setWritten(written: boolean): void {
		if (this.wroteThisIdle === written) return;
		this.wroteThisIdle = written;
		this.host.save();
	}
}
