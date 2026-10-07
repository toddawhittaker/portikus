import type { Database } from "@portikus/db";
import { errorMessage, type Logger } from "@portikus/observability";
import type { FastifyInstance } from "fastify";
import { type Kysely, sql } from "kysely";

/**
 * Fixed-window counts of sign-in guesses kept in PostgreSQL, so a restart
 * of the API hands out no fresh guesses (SPEC.md section 24.13, ADR 0053).
 * Each hit is one atomic upsert, so parallel requests count exactly.
 */

/** Proof that one request's hit was counted: which count, whose, and in which window. */
export interface CounterReceipt {
	readonly scope: string;
	readonly key: string;
	readonly windowStart: Date;
	/** Set once given back, so one receipt returns one count at most. */
	spent: boolean;
}

export interface StoredDecision {
	allowed: boolean;
	/** True for the one request that saw this window's first refusal. */
	audit: boolean;
	/** Present only when allowed, so a refused hit can never be given back. */
	receipt: CounterReceipt | null;
}

/**
 * The counts could not be read or written. The request is refused with 503
 * and never let through (ADR 0053).
 */
export class CounterUnavailable extends Error {
	constructor(cause: unknown) {
		super("the sign-in counter store failed", { cause });
		this.name = "CounterUnavailable";
	}
}

export interface StoredCounter {
	readonly scope: string;
	readonly limit: number;
	/** Count one try for `key` and say whether it is within the limit. */
	attempt(key: string): Promise<StoredDecision>;
	/** Count one try without asking, for a failure whose check was skipped. */
	add(key: string): Promise<void>;
	/**
	 * Return a counted try. Only once per receipt, and only while its window
	 * lasts. A failure is logged and the count stays, which errs toward refusing.
	 */
	giveBack(receipt: CounterReceipt): Promise<void>;
}

interface Hit {
	count: number;
	windowStart: Date;
}

export function createStoredCounter(options: {
	db: Kysely<Database>;
	logger: Logger;
	scope: string;
	limit: number;
	windowMs: number;
	now?: () => number;
}): StoredCounter {
	const { db, logger, scope, limit, windowMs } = options;
	const now = options.now ?? (() => Date.now());

	async function hit(key: string): Promise<Hit> {
		const at = new Date(now());
		const ends = new Date(at.getTime() + windowMs);
		// Every SET expression reads the old row, so all four agree on whether
		// the window had ended. The row lock makes parallel hits count exactly.
		const result = await sql<{ count: number; window_started_at: Date }>`
			insert into signin_counters as c
				(scope, key, window_started_at, expires_at, count, reported)
			values (${scope}, ${key}, ${at}, ${ends}, 1, false)
			on conflict (scope, key) do update set
				window_started_at = case when c.expires_at <= ${at}
					then excluded.window_started_at else c.window_started_at end,
				expires_at = case when c.expires_at <= ${at}
					then excluded.expires_at else c.expires_at end,
				count = case when c.expires_at <= ${at} then 1 else c.count + 1 end,
				reported = case when c.expires_at <= ${at} then false else c.reported end
			returning count, window_started_at`.execute(db);
		const row = result.rows[0];
		if (!row) throw new Error("the counter upsert returned no row");
		return { count: row.count, windowStart: row.window_started_at };
	}

	/** True for exactly one caller per window, however many are refused at once. */
	async function firstRefusal(key: string, windowStart: Date): Promise<boolean> {
		const result = await sql`
			update signin_counters set reported = true
			where scope = ${scope} and key = ${key}
				and window_started_at = ${windowStart} and reported = false
			returning 1`.execute(db);
		return result.rows.length > 0;
	}

	return {
		scope,
		limit,
		async attempt(key) {
			try {
				const counted = await hit(key);
				if (counted.count <= limit) {
					const receipt = {
						scope,
						key,
						windowStart: counted.windowStart,
						spent: false,
					};
					return { allowed: true, audit: false, receipt };
				}
				const audit = await firstRefusal(key, counted.windowStart);
				return { allowed: false, audit, receipt: null };
			} catch (error) {
				throw new CounterUnavailable(error);
			}
		},
		async add(key) {
			try {
				await hit(key);
			} catch (error) {
				throw new CounterUnavailable(error);
			}
		},
		async giveBack(receipt) {
			if (receipt.spent || receipt.scope !== scope) return;
			receipt.spent = true;
			try {
				await sql`
					update signin_counters set count = count - 1
					where scope = ${scope} and key = ${receipt.key}
						and window_started_at = ${receipt.windowStart} and count > 0`.execute(db);
			} catch (error) {
				logger.warn({ err: error, scope }, "could not give a sign-in count back");
			}
		},
	};
}

/** How often the API deletes sign-in counts whose window has ended. */
export const PRUNE_EVERY_MS = 60 * 60_000;

/**
 * Delete sign-in counts whose window has ended. A live window is never
 * touched, and a hit restarts an ended one it meets first. Returns how many
 * rows went.
 */
export async function pruneEndedCounters(
	db: Kysely<Database>,
	now: Date,
): Promise<number> {
	const result = await db
		.deleteFrom("signin_counters")
		.where("expires_at", "<=", now)
		.executeTakeFirst();
	return Number(result.numDeletedRows);
}

/**
 * Prune every hour while the server runs. The API prunes its own table, so
 * the worker needs no right to delete counts (ADR 0053).
 */
export function registerCounterPrune(
	app: FastifyInstance,
	deps: { db: Kysely<Database>; logger: Logger },
): void {
	let timer: NodeJS.Timeout | undefined;
	const prune = async (): Promise<void> => {
		try {
			const deleted = await pruneEndedCounters(deps.db, new Date());
			if (deleted > 0) deps.logger.info({ deleted }, "pruned ended sign-in counts");
		} catch (e) {
			deps.logger.warn({ error: errorMessage(e) }, "sign-in count prune failed");
		}
	};
	app.addHook("onReady", async () => {
		timer = setInterval(() => void prune(), PRUNE_EVERY_MS);
		timer.unref();
	});
	app.addHook("onClose", async () => {
		if (timer) clearInterval(timer);
	});
}
