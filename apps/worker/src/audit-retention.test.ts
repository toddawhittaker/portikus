import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import { collectingLogger } from "@portikus/observability/testing";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import {
	AUDIT_PRUNE_BATCH,
	AUDIT_PRUNE_SECONDS,
	AUDIT_RETENTION_DAYS,
	pruneAuditEvents,
	startAuditRetention,
} from "./audit-retention.js";

// SPEC.md 25.10: audit rows older than 365 days go, whatever their action.
const skip = !hasTestDb();
let tdb: TestDb;
const now = new Date("2026-10-22T12:00:00Z");
const DAY = 86_400_000;

beforeAll(async () => {
	if (skip) return;
	tdb = await createTestDb();
});

afterAll(async () => {
	if (skip) return;
	await tdb.close();
});

beforeEach(async () => {
	if (skip) return;
	await tdb.truncate();
});

afterEach(() => {
	vi.useRealTimers();
});

async function addEvent(action: string, daysAgo: number, actor = "user-1") {
	await tdb.db
		.insertInto("audit_events")
		.values({
			actor,
			target: "target-1",
			action,
			result: "ok",
			at: new Date(now.getTime() - daysAgo * DAY).toISOString(),
		})
		.execute();
}

async function remaining(): Promise<number[]> {
	const rows = await tdb.db.selectFrom("audit_events").select("id").execute();
	return rows.map((r) => r.id);
}

test("the window is 365 days, swept once a day, in batches of 5000", () => {
	expect(AUDIT_RETENTION_DAYS).toBe(365);
	expect(AUDIT_PRUNE_SECONDS).toBe(86_400);
	expect(AUDIT_PRUNE_BATCH).toBe(5000);
});

test.skipIf(skip)(
	"deletes a row 366 days old and keeps one 364 days old, for any action",
	async () => {
		await addEvent("auth.login", 366);
		await addEvent("preview.denied", 366);
		await addEvent("user.role_changed", 400);
		await addEvent("auth.login", 364);
		await addEvent("preview.denied", 364);
		await addEvent("workspace.start", 0);

		expect(await pruneAuditEvents(tdb.db, now)).toBe(3);

		const rows = await tdb.db
			.selectFrom("audit_events")
			.select(["action", "at"])
			.execute();
		expect(rows).toHaveLength(3);
		for (const r of rows) {
			expect(r.at.getTime()).toBeGreaterThan(
				now.getTime() - AUDIT_RETENTION_DAYS * DAY,
			);
		}
	},
);

test.skipIf(skip)("a run with nothing old deletes nothing", async () => {
	await addEvent("auth.login", 10);
	expect(await pruneAuditEvents(tdb.db, now)).toBe(0);
	expect(await remaining()).toHaveLength(1);
});

test.skipIf(skip)(
	"deletes every old row when there are more than one batch",
	async () => {
		for (let n = 0; n < 7; n++) await addEvent("auth.login", 400 + n);
		await addEvent("auth.login", 1);
		await addEvent("auth.login", 2);

		expect(await pruneAuditEvents(tdb.db, now, 3)).toBe(7);
		expect(await remaining()).toHaveLength(2);
	},
);

test.skipIf(skip)(
	"deletes old rows when they fill a whole number of batches",
	async () => {
		for (let n = 0; n < 6; n++) await addEvent("auth.login", 400 + n);
		await addEvent("auth.login", 1);

		expect(await pruneAuditEvents(tdb.db, now, 3)).toBe(6);
		expect(await remaining()).toHaveLength(1);
	},
);

test.skipIf(skip)(
	"the daily sweep logs the count and nothing from the rows",
	async () => {
		const realNow = Date.now();
		await tdb.db
			.insertInto("audit_events")
			.values({
				actor: "secret-actor",
				target: "secret-target",
				action: "auth.login",
				result: "ok",
				metadata: JSON.stringify({ note: "secret-metadata" }),
				at: new Date(realNow - 366 * DAY).toISOString(),
			})
			.execute();
		const { logger, lines } = collectingLogger();

		const stop = startAuditRetention({ db: tdb.db, logger });
		await vi.waitFor(() => expect(lines.some((l) => l.deleted === 1)).toBe(true));
		stop();

		expect(JSON.stringify(lines)).not.toMatch(/secret/);
		expect(await remaining()).toHaveLength(0);
	},
);

test("a failing sweep is logged and does not throw", async () => {
	const { logger, lines } = collectingLogger();
	const stop = startAuditRetention({ db: {} as TestDb["db"], logger });
	await vi.waitFor(() =>
		expect(lines.some((l) => l.msg === "audit retention error")).toBe(true),
	);
	stop();
});

test("the sweep runs once at start, then once every 24 hours until stopped", async () => {
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
	let calls = 0;
	const tick = async () => {
		calls++;
	};
	const { logger } = collectingLogger();
	const stop = startAuditRetention({ db: {} as TestDb["db"], logger }, tick);
	expect(calls).toBe(1);
	await vi.advanceTimersByTimeAsync(AUDIT_PRUNE_SECONDS * 1000 - 1);
	expect(calls).toBe(1);
	await vi.advanceTimersByTimeAsync(1);
	expect(calls).toBe(2);
	await vi.advanceTimersByTimeAsync(AUDIT_PRUNE_SECONDS * 1000);
	expect(calls).toBe(3);
	stop();
	await vi.advanceTimersByTimeAsync(AUDIT_PRUNE_SECONDS * 5000);
	expect(calls).toBe(3);
});
