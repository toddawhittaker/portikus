/** Built-in AI token counts (SPEC.md section 20.4): per UTC day, and the monthly total the cap reads. */
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { recordUsage, usedThisMonth } from "./usage.js";

const skip = !hasTestDb();
let testDb: TestDb;

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
	await testDb.db.deleteFrom("ai_usage_days").execute();
});

const USAGE = { input: 100, output: 20, cacheRead: 5, cacheWrite: 7 };
const NOON = new Date("2026-11-15T12:00:00Z");

async function rows() {
	return testDb.db
		.selectFrom("ai_usage_days")
		.selectAll()
		.orderBy("day")
		.orderBy("model")
		.execute();
}

describe.skipIf(skip)("recordUsage", () => {
	test("adds to the same day, person, purpose and model", async () => {
		const entry = {
			userId: null,
			purpose: "assistant" as const,
			model: "m1",
			usage: USAGE,
		};
		await recordUsage(testDb.db, entry, NOON);
		await recordUsage(testDb.db, entry, NOON);
		const [row, ...rest] = await rows();
		expect(rest).toEqual([]);
		expect(row).toMatchObject({
			user_id: null,
			purpose: "assistant",
			model: "m1",
			input_tokens: "200",
			output_tokens: "40",
			cache_read_tokens: "10",
			cache_write_tokens: "14",
		});
	});

	test("keeps another day, purpose or model apart", async () => {
		const base = {
			userId: null,
			purpose: "assistant" as const,
			model: "m1",
			usage: USAGE,
		};
		await recordUsage(testDb.db, base, NOON);
		await recordUsage(testDb.db, base, new Date("2026-11-16T00:00:00Z"));
		await recordUsage(testDb.db, { ...base, purpose: "pricing" }, NOON);
		await recordUsage(testDb.db, { ...base, model: "m2" }, NOON);
		expect(await rows()).toHaveLength(4);
	});

	test("counts the UTC day, not the server's", async () => {
		await recordUsage(
			testDb.db,
			{ userId: null, purpose: "assistant", model: "m", usage: USAGE },
			new Date("2026-11-15T23:59:59Z"),
		);
		const [row] = await rows();
		expect(new Date(row?.day ?? 0).toISOString().slice(0, 10)).toBe("2026-11-15");
	});

	test("a model name past the column's limit is cut, not refused", async () => {
		await recordUsage(
			testDb.db,
			{ userId: null, purpose: "assistant", model: "x".repeat(150), usage: USAGE },
			NOON,
		);
		expect((await rows())[0]?.model).toHaveLength(100);
	});
});

describe.skipIf(skip)("usedThisMonth", () => {
	test("sums input and output tokens of this calendar month only, for everyone", async () => {
		const at = (day: string) => new Date(`${day}T10:00:00Z`);
		const entry = {
			userId: null,
			purpose: "assistant" as const,
			model: "m",
			usage: USAGE,
		};
		await recordUsage(testDb.db, entry, at("2026-10-31"));
		await recordUsage(testDb.db, entry, at("2026-11-01"));
		await recordUsage(testDb.db, { ...entry, purpose: "pricing" }, at("2026-11-15"));
		expect(await usedThisMonth(testDb.db, NOON)).toBe(240);
		expect(await usedThisMonth(testDb.db, at("2026-10-31"))).toBe(120);
	});

	test("is zero when nothing was used", async () => {
		expect(await usedThisMonth(testDb.db, NOON)).toBe(0);
	});
});
