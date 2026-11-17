import { createSession } from "@portikus/auth";
import { AiUsageResponse } from "@portikus/contracts";
import {
	createTestDb,
	hasTestDb,
	insertTestUser,
	type TestDb,
} from "@portikus/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { recordUsage } from "../ai/usage.js";
import { buildTestServer } from "../testing/test-support.js";

/** The built-in AI usage view for administrators (SPEC.md section 20.4). */

const skip = !hasTestDb();
let testDb: TestDb;
let app: FastifyInstance;

beforeAll(async () => {
	if (skip) return;
	testDb = await createTestDb();
});

afterAll(async () => {
	if (skip) return;
	await testDb.close();
});

beforeEach(async () => {
	if (skip) return;
	await testDb.truncate();
	await testDb.db.deleteFrom("ai_usage_days").execute();
	await testDb.db.updateTable("ai_settings").set({ monthly_token_cap: 1000 }).execute();
	app = buildTestServer(testDb.db, "http://127.0.0.1:1/unused");
	await app.ready();
	return () => app.close();
});

async function get(url: string, userId: string) {
	const session = await createSession(testDb.db, userId, 3600, {
		method: "oidc",
		courseUserId: null,
	});
	return app.inject({ url, headers: { cookie: `portikus_session=${session.token}` } });
}

const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000);

function step(input: number, output = 5, cacheRead = 7, cacheWrite = 3) {
	return { input, output, cacheRead, cacheWrite };
}

test.skipIf(skip)("only an administrator may read it", async () => {
	const student = await insertTestUser(testDb.db);
	const admin = await insertTestUser(testDb.db, { role: "administrator" });
	expect((await get("/admin/ai-usage", student)).statusCode).toBe(403);
	expect((await get("/admin/ai-usage", admin)).statusCode).toBe(200);
});

test.skipIf(skip)("rejects a window that is not 7, 30 or 90", async () => {
	const admin = await insertTestUser(testDb.db, { role: "administrator" });
	expect((await get("/admin/ai-usage?days=5", admin)).statusCode).toBe(400);
});

test.skipIf(skip)(
	"sums by person, purpose and model, names the price check, and totals the window",
	async () => {
		const admin = await insertTestUser(testDb.db, { role: "administrator" });
		const sam = await insertTestUser(testDb.db, { display_name: "Sam" });
		const now = new Date();
		await recordUsage(
			testDb.db,
			{ userId: sam, purpose: "assistant", model: "m1", usage: step(100) },
			now,
		);
		await recordUsage(
			testDb.db,
			{ userId: sam, purpose: "assistant", model: "m1", usage: step(50) },
			daysAgo(1),
		);
		await recordUsage(
			testDb.db,
			{ userId: null, purpose: "pricing", model: "m1", usage: step(10) },
			now,
		);
		// Outside the 7 day window, inside 30.
		await recordUsage(
			testDb.db,
			{ userId: sam, purpose: "assistant", model: "m1", usage: step(1000) },
			daysAgo(20),
		);

		const week = AiUsageResponse.parse((await get("/admin/ai-usage", admin)).json());
		expect(week.days).toBe(7);
		expect(week.users).toEqual([
			{
				userId: sam,
				displayName: "Sam",
				purpose: "assistant",
				model: "m1",
				inputTokens: 150,
				outputTokens: 10,
				cacheReadTokens: 14,
				cacheWriteTokens: 6,
				dollars: null,
			},
			{
				userId: null,
				displayName: "Weekly price check",
				purpose: "pricing",
				model: "m1",
				inputTokens: 10,
				outputTokens: 5,
				cacheReadTokens: 7,
				cacheWriteTokens: 3,
				dollars: null,
			},
		]);
		expect(week.dollars).toBeNull();
		expect(week.dollarsPartial).toBe(true);
		expect(week.totals).toEqual({
			inputTokens: 160,
			outputTokens: 15,
			cacheReadTokens: 21,
			cacheWriteTokens: 9,
		});
		expect(week.daily.map((d) => [d.day, d.purpose, d.inputTokens])).toEqual([
			[daysAgo(1).toISOString().slice(0, 10), "assistant", 50],
			[now.toISOString().slice(0, 10), "assistant", 100],
			[now.toISOString().slice(0, 10), "pricing", 10],
		]);

		const month = AiUsageResponse.parse(
			(await get("/admin/ai-usage?days=30", admin)).json(),
		);
		expect(month.totals.inputTokens).toBe(1160);
	},
);

test.skipIf(skip)(
	"reports this month's use against the cap, over every purpose",
	async () => {
		const admin = await insertTestUser(testDb.db, { role: "administrator" });
		await recordUsage(testDb.db, {
			userId: admin,
			purpose: "assistant",
			model: "m",
			usage: step(300, 100),
		});
		await recordUsage(testDb.db, {
			userId: null,
			purpose: "pricing",
			model: "m",
			usage: step(50, 20),
		});
		const body = AiUsageResponse.parse((await get("/admin/ai-usage", admin)).json());
		expect(body.month).toEqual({ usedTokens: 470, capTokens: 1000 });
	},
);

test.skipIf(skip)("a deleted person's rows stay, named as such", async () => {
	const admin = await insertTestUser(testDb.db, { role: "administrator" });
	const gone = await insertTestUser(testDb.db, { display_name: "Gone" });
	await recordUsage(testDb.db, {
		userId: gone,
		purpose: "assistant",
		model: "m",
		usage: step(5),
	});
	await testDb.db.deleteFrom("users").where("id", "=", gone).execute();
	const body = AiUsageResponse.parse((await get("/admin/ai-usage", admin)).json());
	expect(body.users.map((u) => [u.userId, u.displayName])).toEqual([
		[null, "Deleted user"],
	]);
});

async function addPrice(model: string, output: number | null) {
	await testDb.db
		.insertInto("model_prices")
		.values({
			provider: "anthropic",
			model,
			input_price_per_million: 3,
			output_price_per_million: output,
			cache_read_ratio: 0.1,
			cache_write_ratio: 1.25,
			cache_ttl_seconds: 300,
			source_url: "https://docs.claude.com/pricing",
			source_quote: "quote",
		})
		.execute();
}

test.skipIf(skip)(
	"prices each model's row at its table price and totals only what could be priced",
	async () => {
		const admin = await insertTestUser(testDb.db, { role: "administrator" });
		await addPrice("claude-opus-5-5", 15);
		await addPrice("claude-old-1", null);
		const use = (model: string) =>
			recordUsage(testDb.db, {
				userId: admin,
				purpose: "assistant",
				model,
				usage: { input: 1_000_000, output: 100_000, cacheRead: 600_000, cacheWrite: 0 },
			});
		const get1 = async () =>
			AiUsageResponse.parse((await get("/admin/ai-usage", admin)).json());

		await use("Claude Opus 5.5");
		let body = await get1();
		// 400k fresh input at $3, 600k cache reads at $0.30, 100k output at $15.
		const expected = 0.4 * 3 + 0.6 * 0.3 + 0.1 * 15;
		expect(body.users[0]?.dollars).toBeCloseTo(expected);
		expect(body.dollars).toBeCloseTo(expected);
		expect(body.dollarsPartial).toBe(false);

		await use("claude-old-1");
		await use("no-such-model");
		body = await get1();
		const byModel = Object.fromEntries(body.users.map((u) => [u.model, u.dollars]));
		expect(byModel["claude-old-1"]).toBeNull();
		expect(byModel["no-such-model"]).toBeNull();
		expect(body.dollars).toBeCloseTo(expected);
		expect(body.dollarsPartial).toBe(true);
	},
);

test.skipIf(skip)(
	"with nothing used there is no estimate and nothing missing",
	async () => {
		const admin = await insertTestUser(testDb.db, { role: "administrator" });
		const body = AiUsageResponse.parse((await get("/admin/ai-usage", admin)).json());
		expect(body.dollars).toBeNull();
		expect(body.dollarsPartial).toBe(false);
	},
);
