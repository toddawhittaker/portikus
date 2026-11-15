import {
	createTestDb,
	hasTestDb,
	insertTestUser,
	type TestDb,
} from "@portikus/db/testing";
import { collectingLogger } from "@portikus/observability/testing";
import { sql } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import {
	API_KEY_REMINDER_SECONDS,
	remindExpiringApiKeys,
	startApiKeyReminders,
} from "./api-key-reminders.js";

// SPEC.md sections 24.8 and 24.13, docs/EPIC-68.md D5: a key's owner is told
// 7 days before it expires (1 day for a 7-day key), once per expiry.
const skip = !hasTestDb();
let tdb: TestDb;
const now = new Date("2026-11-15T12:00:00Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
let hashCounter = 0;

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

async function insertKey(
	userId: string,
	options: {
		name?: string;
		periodDays?: number | null;
		expiresAt: Date | null;
		revoked?: boolean;
	},
): Promise<string> {
	const row = await tdb.db
		.insertInto("api_keys")
		.values({
			user_id: userId,
			name: options.name ?? "ci key",
			token_hash: `hash-${++hashCounter}`,
			display_prefix: "pk_abcd",
			period_days: options.periodDays === undefined ? 30 : options.periodDays,
			expires_at: options.expiresAt,
			revoked_at: options.revoked ? now : null,
		})
		.returning("id")
		.executeTakeFirstOrThrow();
	return row.id;
}

async function remind(at: Date = now): Promise<number> {
	return remindExpiringApiKeys(tdb.db, at, collectingLogger().logger);
}

async function notices(userId: string) {
	return tdb.db
		.selectFrom("notifications")
		.selectAll()
		.where("user_id", "=", userId)
		.execute();
}

test.skipIf(skip)(
	"a 30-day key 6 days from expiry is reminded once, not again on the next run",
	async () => {
		const owner = await insertTestUser(tdb.db, { role: "instructor" });
		const expiresAt = new Date(now.getTime() + 6 * DAY);
		await insertKey(owner, { name: "grading bot", expiresAt });

		expect(await remind()).toBe(1);
		const [notice] = await notices(owner);
		expect(notice?.title).toBe("An API key expires soon");
		expect(notice?.body).toContain("grading bot");
		expect(notice?.body).toContain("pk_abcd");
		expect(notice?.body).toContain("2026-11-21");
		expect(notice?.body).toContain("renew");

		expect(await remind(new Date(now.getTime() + DAY))).toBe(0);
		expect(await notices(owner)).toHaveLength(1);
	},
);

test.skipIf(skip)(
	"a key more than 7 days from expiry is not reminded yet",
	async () => {
		const owner = await insertTestUser(tdb.db, { role: "instructor" });
		await insertKey(owner, { expiresAt: new Date(now.getTime() + 8 * DAY) });
		expect(await remind()).toBe(0);
		expect(await notices(owner)).toHaveLength(0);
	},
);

test.skipIf(skip)(
	"a 7-day key 3 days out is not reminded, and 20 hours out it is",
	async () => {
		const owner = await insertTestUser(tdb.db, { role: "instructor" });
		const expiresAt = new Date(now.getTime() + 3 * DAY);
		await insertKey(owner, { periodDays: 7, expiresAt });

		expect(await remind()).toBe(0);
		expect(await notices(owner)).toHaveLength(0);

		expect(await remind(new Date(expiresAt.getTime() - 20 * HOUR))).toBe(1);
		expect(await notices(owner)).toHaveLength(1);
	},
);

test.skipIf(skip)(
	"a revoked key and a never-expiring key are not reminded",
	async () => {
		const owner = await insertTestUser(tdb.db, { role: "administrator" });
		await insertKey(owner, {
			expiresAt: new Date(now.getTime() + 2 * DAY),
			revoked: true,
		});
		await insertKey(owner, { periodDays: null, expiresAt: null });
		expect(await remind()).toBe(0);
		expect(await notices(owner)).toHaveLength(0);
	},
);

test.skipIf(skip)("an already expired key is not reminded", async () => {
	const owner = await insertTestUser(tdb.db, { role: "instructor" });
	await insertKey(owner, { expiresAt: new Date(now.getTime() - HOUR) });
	expect(await remind()).toBe(0);
	expect(await notices(owner)).toHaveLength(0);
});

test.skipIf(skip)(
	"a renewal that moves the expiry arms the reminder again",
	async () => {
		const owner = await insertTestUser(tdb.db, { role: "instructor" });
		const id = await insertKey(owner, { expiresAt: new Date(now.getTime() + 5 * DAY) });
		expect(await remind()).toBe(1);

		// Renewed for another 30 days, then nearly expired again.
		const renewed = new Date(now.getTime() + 30 * DAY);
		await tdb.db
			.updateTable("api_keys")
			.set({ expires_at: renewed })
			.where("id", "=", id)
			.execute();
		expect(await remind(new Date(now.getTime() + 10 * DAY))).toBe(0);
		expect(await remind(new Date(renewed.getTime() - 6 * DAY))).toBe(1);
		expect(await notices(owner)).toHaveLength(2);
	},
);

test.skipIf(skip)("each owner is told about their own keys only", async () => {
	const first = await insertTestUser(tdb.db, { role: "instructor" });
	const second = await insertTestUser(tdb.db, { role: "instructor" });
	await insertKey(first, { name: "one", expiresAt: new Date(now.getTime() + 2 * DAY) });
	await insertKey(second, {
		name: "two",
		expiresAt: new Date(now.getTime() + 3 * DAY),
	});
	expect(await remind()).toBe(2);
	expect((await notices(first))[0]?.body).toContain("one");
	expect((await notices(second))[0]?.body).toContain("two");
});

test.skipIf(skip)(
	"a failure for one key is logged and the others still go out",
	async () => {
		const owner = await insertTestUser(tdb.db, { role: "instructor" });
		await insertKey(owner, {
			name: "bad",
			expiresAt: new Date(now.getTime() + 2 * DAY),
		});
		await insertKey(owner, {
			name: "good",
			expiresAt: new Date(now.getTime() + 3 * DAY),
		});
		// The database refuses the notification for the key named "bad".
		await sql`create function refuse_bad_key() returns trigger language plpgsql as $$
		begin
			if new.body like '%"bad"%' then raise exception 'refused'; end if;
			return new;
		end $$`.execute(tdb.db);
		await sql`create trigger refuse_bad_key before insert on notifications
		for each row execute function refuse_bad_key()`.execute(tdb.db);
		const { logger, lines } = collectingLogger();
		expect(await remindExpiringApiKeys(tdb.db, now, logger)).toBe(1);
		expect(lines.some((l) => l.msg === "api key reminder error")).toBe(true);
		expect(await notices(owner)).toHaveLength(1);
		await sql`drop trigger refuse_bad_key on notifications`.execute(tdb.db);
		// The failed key is retried on the next run.
		expect(await remind()).toBe(1);
		expect(await notices(owner)).toHaveLength(2);
	},
);

test("the sweep runs daily", () => {
	expect(API_KEY_REMINDER_SECONDS).toBe(86_400);
});

test("the sweep runs once at start, then once every 24 hours until stopped", async () => {
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
	let calls = 0;
	const tick = async () => {
		calls++;
	};
	const { logger } = collectingLogger();
	const stop = startApiKeyReminders({ db: {} as TestDb["db"], logger }, tick);
	expect(calls).toBe(1);
	await vi.advanceTimersByTimeAsync(API_KEY_REMINDER_SECONDS * 1000);
	expect(calls).toBe(2);
	stop();
	await vi.advanceTimersByTimeAsync(API_KEY_REMINDER_SECONDS * 5000);
	expect(calls).toBe(2);
});

test("a failing sweep is logged and does not throw", async () => {
	const { logger, lines } = collectingLogger();
	const stop = startApiKeyReminders({ db: {} as TestDb["db"], logger });
	await vi.waitFor(() =>
		expect(lines.some((l) => l.msg === "api key reminders error")).toBe(true),
	);
	stop();
});
