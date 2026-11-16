import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createTestDb, hasTestDb, insertTestUser, type TestDb } from "../testing.js";
import { down as stepDown } from "./0064_model_prices.js";

/** Prices carry sources and checked figures, and a run's proposals wait for an administrator (SPEC.md sections 10.8, 20.4). */

if (!hasTestDb()) {
	console.log("TEST_DATABASE_URL is not set — skipping migration 0064 tests.");
}

describe.skipIf(!hasTestDb())("migration 0064_model_prices", () => {
	let t: TestDb;

	beforeAll(async () => {
		t = await createTestDb();
	});
	afterAll(async () => {
		await t?.close();
	});
	beforeEach(async () => {
		await t.truncate();
		await t.db.deleteFrom("model_prices").execute();
		await t.db.deleteFrom("price_runs").execute();
	});

	const figures = {
		input_price_per_million: 5,
		cache_read_ratio: 0.05,
		cache_write_ratio: 1.25,
		cache_ttl_seconds: 300,
		source_url: "https://example.invalid/pricing",
		source_quote: "Opus input is $5 per million tokens",
	};

	function price(extra: Record<string, unknown> = {}) {
		return t.db
			.insertInto("model_prices")
			.values({ provider: "anthropic", model: "claude-opus-5-5", ...figures, ...extra })
			.returningAll()
			.executeTakeFirstOrThrow();
	}

	async function run(startedBy?: string): Promise<string> {
		const row = await t.db
			.insertInto("price_runs")
			.values({
				trigger: startedBy ? "manual" : "weekly",
				started_by: startedBy ?? null,
			})
			.returning("id")
			.executeTakeFirstOrThrow();
		return row.id;
	}

	function proposal(runId: string, extra: Record<string, unknown> = {}) {
		return t.db
			.insertInto("price_proposals")
			.values({
				run_id: runId,
				provider: "anthropic",
				model: "claude-opus-5-5",
				...figures,
				...extra,
			})
			.returningAll()
			.executeTakeFirstOrThrow();
	}

	test("a price row has no surcharge or one-hour write until given", async () => {
		const row = await price();
		expect(row.cache_write_one_hour_ratio).toBeNull();
		expect(row.surcharge_above_tokens).toBeNull();
		expect(row.surcharge_factor).toBeNull();
		expect(row.updated_by).toBeNull();
		expect(row.source_url).toBe("https://example.invalid/pricing");
		expect(row.checked_at).toBeInstanceOf(Date);
		const full = await price({
			model: "gpt-6.1",
			provider: "openai",
			cache_write_one_hour_ratio: 2,
			surcharge_above_tokens: 272000,
			surcharge_factor: 2,
		});
		expect(full.cache_write_one_hour_ratio).toBe("2");
		expect(full.surcharge_above_tokens).toBe(272000);
		expect(full.surcharge_factor).toBe("2");
	});

	test("a model has one row per provider", async () => {
		await price();
		await price({ provider: "openai" });
		await expect(price()).rejects.toThrow(/duplicate|unique/);
	});

	test("implausible figures are refused in both tables", async () => {
		const runId = await run();
		const bad: Record<string, unknown>[] = [
			{ provider: "google" },
			{ model: "" },
			{ input_price_per_million: 0 },
			{ input_price_per_million: 10001 },
			{ cache_read_ratio: 0 },
			{ cache_read_ratio: 1.5 },
			{ cache_write_ratio: 0 },
			{ cache_write_ratio: 11 },
			{ cache_write_one_hour_ratio: 0 },
			{ cache_write_one_hour_ratio: 11 },
			{ cache_ttl_seconds: 0 },
			{ cache_ttl_seconds: 86401 },
			{ surcharge_above_tokens: 100000 },
			{ surcharge_factor: 2 },
			{ surcharge_above_tokens: 0, surcharge_factor: 2 },
			{ surcharge_above_tokens: 100000, surcharge_factor: 1 },
			{ surcharge_above_tokens: 100000, surcharge_factor: 11 },
			{ source_url: "" },
			{ source_quote: "" },
			{ source_quote: "x".repeat(2001) },
		];
		for (const extra of bad) {
			await expect(price(extra), JSON.stringify(extra)).rejects.toThrow(/check/);
			await expect(proposal(runId, extra), JSON.stringify(extra)).rejects.toThrow(
				/check/,
			);
		}
	});

	test("a price row refuses a missing figure", async () => {
		await expect(
			sql`insert into model_prices (provider, model, input_price_per_million)
				values ('anthropic', 'm', 1)`.execute(t.db),
		).rejects.toThrow(/null/);
	});

	test("a run starts running with no end or error, and its trigger and status are checked", async () => {
		const id = await run();
		const row = await t.db
			.selectFrom("price_runs")
			.selectAll()
			.where("id", "=", id)
			.executeTakeFirstOrThrow();
		expect(row.status).toBe("running");
		expect(row.finished_at).toBeNull();
		expect(row.error_code).toBeNull();
		expect(row.trigger).toBe("weekly");
		expect(row.started_by).toBeNull();
		await expect(
			sql`update price_runs set status = 'succeeded'`.execute(t.db),
		).rejects.toThrow(/check/);
		await expect(
			sql`update price_runs set trigger = 'daily'`.execute(t.db),
		).rejects.toThrow(/check/);
		await sql`update price_runs set status = 'done', finished_at = now()`.execute(t.db);
		await sql`update price_runs set status = 'failed', error_code = 'x'`.execute(t.db);
	});

	test("a proposal starts pending, and deleting its run deletes it", async () => {
		const id = await run();
		const row = await proposal(id);
		expect(row.status).toBe("pending");
		expect(row.decided_by).toBeNull();
		expect(row.decided_at).toBeNull();
		await expect(proposal(id, { status: "maybe" })).rejects.toThrow(/check/);
		await proposal(id, { status: "accepted" });
		await t.db.deleteFrom("price_runs").where("id", "=", id).execute();
		expect(
			await t.db.selectFrom("price_proposals").select("id").execute(),
		).toHaveLength(0);
	});

	test("deleting a person clears who started a run, decided a proposal or edited a price", async () => {
		const person = await insertTestUser(t.db);
		const runId = await run(person);
		const p = await proposal(runId);
		await sql`update price_proposals set decided_by = ${person}, decided_at = now()
			where id = ${p.id}`.execute(t.db);
		const row = await price({ updated_by: person });
		await t.db.deleteFrom("users").where("id", "=", person).execute();
		const started = await t.db.selectFrom("price_runs").select("started_by").execute();
		expect(started[0]?.started_by).toBeNull();
		const decided = await t.db
			.selectFrom("price_proposals")
			.select("decided_by")
			.execute();
		expect(decided[0]?.decided_by).toBeNull();
		const edited = await t.db
			.selectFrom("model_prices")
			.select("updated_by")
			.where("id", "=", row.id)
			.executeTakeFirstOrThrow();
		expect(edited.updated_by).toBeNull();
	});

	test("down drops all three tables", async () => {
		await stepDown(t.db as unknown as Kysely<unknown>);
		for (const table of ["model_prices", "price_runs", "price_proposals"]) {
			await expect(sql.raw(`select 1 from ${table}`).execute(t.db)).rejects.toThrow(
				/does not exist/,
			);
		}
	});
});
