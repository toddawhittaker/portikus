import { priceRowFor, usageDollars } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import { type Kysely, sql } from "kysely";
import { listPrices } from "../pricing/store.js";
import { windowDays } from "../usage-window.js";

const SEVEN = 7;

/** People, workspaces, coding agents and built-in AI over the last seven days, as plain lines. */
export async function usageLines(
	db: Kysely<Database>,
	now: Date,
	starts: number,
	from: Date,
): Promise<string[]> {
	const days = windowDays(SEVEN, now);
	const people = await db
		.selectFrom("audit_events")
		.select(sql<string>`count(distinct actor)`.as("n"))
		.where("action", "=", "auth.login")
		.where("result", "=", "ok")
		.where("at", ">=", from)
		.where("at", "<", now)
		.executeTakeFirstOrThrow();
	const agents = await db
		.selectFrom("agent_usage_days")
		.select([
			sql<string>`count(distinct user_id)`.as("people"),
			sql<string>`coalesce(sum(sessions), 0)`.as("sessions"),
		])
		.where(sql<boolean>`day >= ${days.from}::date and day <= ${days.to}::date`)
		.executeTakeFirstOrThrow();
	const ai = await db
		.selectFrom("ai_usage_days")
		.select([
			"model",
			sql<string>`sum(input_tokens)`.as("input"),
			sql<string>`sum(output_tokens)`.as("output"),
			sql<string>`sum(cache_read_tokens)`.as("cache_read"),
			sql<string>`sum(cache_write_tokens)`.as("cache_write"),
		])
		.where(sql<boolean>`day >= ${days.from}::date and day <= ${days.to}::date`)
		.groupBy("model")
		.execute();

	const lines = [
		`${people.n} people signed in. ${starts} workspace starts.`,
		`Coding agents: ${agents.sessions} sessions by ${agents.people} people.`,
	];
	if (ai.length === 0) {
		lines.push("Built-in AI: not used.");
		return lines;
	}
	const prices = await listPrices(db);
	let tokens = 0;
	let dollars = 0;
	let unpriced = 0;
	for (const row of ai) {
		const counts = {
			inputTokens: Number(row.input),
			outputTokens: Number(row.output),
			cacheReadTokens: Number(row.cache_read),
			cacheWriteTokens: Number(row.cache_write),
		};
		tokens += counts.inputTokens + counts.outputTokens;
		const price = priceRowFor(row.model, prices);
		const cost = price ? usageDollars(counts, price) : null;
		if (cost === null) unpriced += 1;
		else dollars += cost;
	}
	const priced = unpriced < ai.length;
	const estimate = !priced
		? "no price on file, so no dollar estimate"
		: `about $${dollars.toFixed(2)} estimate${unpriced > 0 ? ", partial because some models have no price" : ""}`;
	lines.push(`Built-in AI: ${tokens.toLocaleString("en-US")} tokens, ${estimate}.`);
	return lines;
}
