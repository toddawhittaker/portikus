import type { Database } from "@portikus/db";
import { type Kysely, sql } from "kysely";
import type { ModelPart } from "./model.js";

/** What one model step used, as the model module reports it on `finish`. */
export type StepUsage = Extract<ModelPart, { type: "finish" }>["usage"];

export type UsageEntry = {
	/** Null for a system call such as the weekly price check. */
	userId: string | null;
	purpose: "assistant" | "pricing";
	model: string;
	usage: StepUsage;
};

// The model column holds at most this many characters; a settings model name may be longer.
const MODEL_COLUMN_CHARS = 100;

function utcDay(now: Date): string {
	return now.toISOString().slice(0, 10);
}

/**
 * Add a step's tokens to today's row (UTC) for this person, purpose and
 * model. Counts only, never content (SPEC.md section 20.4).
 */
export async function recordUsage(
	db: Kysely<Database>,
	entry: UsageEntry,
	now: Date = new Date(),
): Promise<void> {
	const { usage } = entry;
	await db
		.insertInto("ai_usage_days")
		.values({
			day: utcDay(now),
			user_id: entry.userId,
			purpose: entry.purpose,
			model: entry.model.slice(0, MODEL_COLUMN_CHARS),
			input_tokens: usage.input,
			output_tokens: usage.output,
			cache_read_tokens: usage.cacheRead,
			cache_write_tokens: usage.cacheWrite,
		})
		.onConflict((oc) =>
			oc.columns(["day", "user_id", "purpose", "model"]).doUpdateSet({
				input_tokens: sql`ai_usage_days.input_tokens + excluded.input_tokens`,
				output_tokens: sql`ai_usage_days.output_tokens + excluded.output_tokens`,
				cache_read_tokens: sql`ai_usage_days.cache_read_tokens + excluded.cache_read_tokens`,
				cache_write_tokens: sql`ai_usage_days.cache_write_tokens + excluded.cache_write_tokens`,
			}),
		)
		.execute();
}

/**
 * Input and output tokens used so far in the calendar month (UTC), by
 * everyone and every purpose: the figure the monthly cap is checked against.
 */
export async function usedThisMonth(
	db: Kysely<Database>,
	now: Date = new Date(),
): Promise<number> {
	const first = `${utcDay(now).slice(0, 7)}-01`;
	const row = await db
		.selectFrom("ai_usage_days")
		.select(sql<string>`coalesce(sum(input_tokens + output_tokens), 0)`.as("total"))
		.where("day", ">=", sql<Date>`${first}::date`)
		.where("day", "<", sql<Date>`(${first}::date + interval '1 month')`)
		.executeTakeFirstOrThrow();
	return Number(row.total);
}
