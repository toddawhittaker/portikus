import type { Kysely } from "kysely";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createTestDb, hasTestDb, type TestDb } from "../testing.js";
import { down as stepDown, up as stepUp } from "./0065_model_output_price.js";

/** Prices and proposals carry an output price, empty on older rows (SPEC.md section 20.5). */

if (!hasTestDb()) {
	console.log("TEST_DATABASE_URL is not set — skipping migration 0065 tests.");
}

describe.skipIf(!hasTestDb())("migration 0065_model_output_price", () => {
	let t: TestDb;
	const up = () => stepUp(t.db as unknown as Kysely<unknown>);
	const down = () => stepDown(t.db as unknown as Kysely<unknown>);

	beforeAll(async () => {
		t = await createTestDb();
	});
	afterAll(async () => {
		await t?.close();
	});
	beforeEach(async () => {
		await t.db.deleteFrom("model_prices").execute();
		await t.db.deleteFrom("price_runs").execute();
	});

	const figures = {
		provider: "anthropic" as const,
		model: "claude-opus-5-5",
		input_price_per_million: 5,
		cache_read_ratio: 0.05,
		cache_write_ratio: 1.25,
		cache_ttl_seconds: 300,
		source_url: "https://example.invalid/pricing",
		source_quote: "Opus input is $5 per million tokens",
	};

	async function runId(): Promise<string> {
		const row = await t.db
			.insertInto("price_runs")
			.values({ trigger: "weekly" })
			.returning("id")
			.executeTakeFirstOrThrow();
		return row.id;
	}

	test("a row saved before the migration has no output price", async () => {
		await down();
		try {
			await sql`insert into model_prices
				(provider, model, input_price_per_million, cache_read_ratio, cache_write_ratio,
				 cache_ttl_seconds, source_url, source_quote)
				values ('anthropic', 'm', 5, 0.05, 1.25, 300, 'https://x.invalid', 'q')`.execute(
				t.db,
			);
		} finally {
			await up();
		}
		const row = await t.db
			.selectFrom("model_prices")
			.select("output_price_per_million")
			.executeTakeFirstOrThrow();
		expect(row.output_price_per_million).toBeNull();
	});

	test("both tables keep an output price and refuse an implausible one", async () => {
		const run = await runId();
		const price = await t.db
			.insertInto("model_prices")
			.values({ ...figures, output_price_per_million: 25 })
			.returningAll()
			.executeTakeFirstOrThrow();
		expect(price.output_price_per_million).toBe("25");
		const proposal = await t.db
			.insertInto("price_proposals")
			.values({ ...figures, run_id: run, output_price_per_million: 25 })
			.returningAll()
			.executeTakeFirstOrThrow();
		expect(proposal.output_price_per_million).toBe("25");
		for (const bad of [0, 10001]) {
			await expect(
				t.db
					.insertInto("model_prices")
					.values({ ...figures, model: "other", output_price_per_million: bad })
					.execute(),
			).rejects.toThrow(/check/);
			await expect(
				t.db
					.insertInto("price_proposals")
					.values({ ...figures, run_id: run, output_price_per_million: bad })
					.execute(),
			).rejects.toThrow(/check/);
		}
	});

	test("down drops the column from both tables", async () => {
		await down();
		try {
			for (const table of ["model_prices", "price_proposals"]) {
				await expect(
					sql.raw(`select output_price_per_million from ${table}`).execute(t.db),
				).rejects.toThrow(/does not exist/);
			}
		} finally {
			await up();
		}
	});
});
