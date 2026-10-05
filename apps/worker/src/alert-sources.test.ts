import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordAudit } from "@portikus/db";
import {
	createTestDb,
	hasTestDb,
	insertTestUser,
	type TestDb,
} from "@portikus/db/testing";
import { collectingLogger } from "@portikus/observability/testing";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import {
	countSignInFailures,
	createAlertSources,
	ROOT_FS_ALERT_PERCENT,
	rootFsUsedPercent,
	SIGNIN_FAILURE_THRESHOLD,
	SIGNIN_WINDOW_MINUTES,
} from "./alert-sources.js";

const skip = !hasTestDb();
let tdb: TestDb;
let admin: string;
const flag = join(tmpdir(), `portikus-reboot-required-${process.pid}`);

beforeAll(async () => {
	if (skip) return;
	tdb = await createTestDb();
});

afterAll(async () => {
	if (skip) return;
	await rm(flag, { force: true });
	await tdb.close();
});

beforeEach(async () => {
	if (skip) return;
	await tdb.truncate();
	await rm(flag, { force: true });
	admin = await insertTestUser(tdb.db, { role: "administrator" });
});

async function titles(): Promise<string[]> {
	const rows = await tdb.db
		.selectFrom("notifications")
		.select("title")
		.where("user_id", "=", admin)
		.orderBy("created_at")
		.execute();
	return rows.map((r) => r.title);
}

async function failures(n: number, action: string, result: string): Promise<void> {
	for (let i = 0; i < n; i++)
		await recordAudit(tdb.db, { actor: "anonymous", target: "x", action, result });
}

test.skipIf(skip)("the reboot flag raises one notice until it clears", async () => {
	const { logger } = collectingLogger();
	const tick = createAlertSources({
		db: tdb.db,
		logger,
		rebootFile: flag,
		rootFsPercent: async () => 10,
	});
	await tick();
	expect(await titles()).toEqual([]);
	await writeFile(flag, "");
	await tick();
	await tick();
	expect(await titles()).toEqual([
		"The server needs a reboot to finish a security update",
	]);
	await rm(flag);
	await tick();
	await writeFile(flag, "");
	await tick();
	expect(await titles()).toHaveLength(2);
});

test.skipIf(skip)(
	"failed sign-ins count password and second-factor failures, throttling and refused logins only",
	async () => {
		await failures(2, "auth.password_failed", "failed");
		await failures(1, "auth.login", "denied");
		await failures(1, "auth.login", "failed");
		await failures(5, "auth.login", "ok");
		await failures(2, "auth.second_factor_failed", "failed");
		await failures(1, "auth.throttled", "denied");
		await failures(3, "preview.denied", "denied");
		expect(await countSignInFailures(tdb.db, new Date())).toBe(7);
		const later = new Date(Date.now() + (SIGNIN_WINDOW_MINUTES + 1) * 60_000);
		expect(await countSignInFailures(tdb.db, later)).toBe(0);
	},
);

test.skipIf(skip)(
	"a sign-in failure spike raises one notice until it clears",
	async () => {
		const { logger } = collectingLogger();
		let clock = new Date();
		const tick = createAlertSources({
			db: tdb.db,
			logger,
			now: () => clock,
			rebootFile: flag,
			rootFsPercent: async () => 10,
		});
		await failures(SIGNIN_FAILURE_THRESHOLD - 1, "auth.password_failed", "failed");
		await tick();
		expect(await titles()).toEqual([]);
		await failures(1, "auth.login", "denied");
		await tick();
		await tick();
		expect(await titles()).toEqual([
			`${SIGNIN_FAILURE_THRESHOLD} failed sign-ins in the last ${SIGNIN_WINDOW_MINUTES} minutes`,
		]);
		clock = new Date(Date.now() + (SIGNIN_WINDOW_MINUTES + 1) * 60_000);
		await tick();
		expect(await titles()).toHaveLength(1);
	},
);

test.skipIf(skip)(
	"a nearly full root filesystem raises one danger notice until it clears",
	async () => {
		const { logger } = collectingLogger();
		let fill = ROOT_FS_ALERT_PERCENT - 1;
		const tick = createAlertSources({
			db: tdb.db,
			logger,
			rebootFile: flag,
			rootFsPercent: async () => fill,
		});
		await tick();
		expect(await titles()).toEqual([]);
		fill = ROOT_FS_ALERT_PERCENT + 2.5;
		await tick();
		await tick();
		expect(await titles()).toEqual([
			`The server's system disk is ${ROOT_FS_ALERT_PERCENT + 2}% full`,
		]);
		const tone = await tdb.db
			.selectFrom("notifications")
			.select("tone")
			.executeTakeFirstOrThrow();
		expect(tone.tone).toBe("danger");
		fill = 50;
		await tick();
		fill = ROOT_FS_ALERT_PERCENT;
		await tick();
		expect(await titles()).toHaveLength(2);
	},
);

test("the root filesystem reading is a percentage", async () => {
	const pct = await rootFsUsedPercent();
	expect(pct).toBeGreaterThanOrEqual(0);
	expect(pct).toBeLessThanOrEqual(100);
});
