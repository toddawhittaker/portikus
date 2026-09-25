import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
	createTestDb,
	hasTestDb,
	insertTestUser,
	type TestDb,
} from "@portikus/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
	claimSetupCode,
	generateSetupCode,
	hasEnabledAdministrator,
	issueSetupCode,
	normalizeSetupCode,
} from "./setup-code.js";

/** The setup code (docs/archive/epics/EPIC-14.md rulings 16 and 17; ADR 0028). */

const CODE_SHAPE = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/;

describe("the code itself", () => {
	test("is four groups of four Crockford base-32 characters, and differs each time", () => {
		const codes = new Set(Array.from({ length: 50 }, generateSetupCode));
		expect(codes.size).toBe(50);
		for (const code of codes) expect(code).toMatch(CODE_SHAPE);
	});

	test("reads case, spaces, hyphens and the look-alike letters the same", () => {
		expect(normalizeSetupCode("abcd-efgh-jkmn-pqrs")).toBe("ABCDEFGHJKMNPQRS");
		expect(normalizeSetupCode(" O1LI 2345 6789 ABCD ")).toBe("011123456789ABCD");
	});

	test("is refused when it is the wrong length or holds a letter outside the alphabet", () => {
		expect(normalizeSetupCode("ABCD-EFGH-JKMN")).toBeNull();
		expect(normalizeSetupCode("ABCD-EFGH-JKMN-PQRSX")).toBeNull();
		expect(normalizeSetupCode("ABCD-EFGH-JKMN-PQRU")).toBeNull();
		expect(normalizeSetupCode("")).toBeNull();
	});
});

const main = fileURLToPath(new URL("./setup-code-main.ts", import.meta.url));

function run(args: string[], env: Record<string, string | undefined> = {}) {
	return spawnSync(process.execPath, ["--import", "tsx", main, ...args], {
		encoding: "utf8",
		env: { ...process.env, DATABASE_URL: undefined, ...env },
	});
}

describe("the setup-code command", () => {
	test("refuses to run without DATABASE_URL", () => {
		const r = run([]);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("DATABASE_URL is not set");
	});

	test("refuses an argument", () => {
		const r = run(["--force"]);
		expect(r.status).toBe(2);
		expect(r.stderr).toContain("unknown argument: --force");
	});
});

describe.skipIf(!hasTestDb())("issuing and claiming", () => {
	let t: TestDb;

	beforeAll(async () => {
		t = await createTestDb();
	});
	afterAll(async () => {
		await t?.close();
	});
	beforeEach(async () => {
		await t.truncate();
	});

	async function codeRows() {
		return t.db.selectFrom("setup_codes").selectAll().execute();
	}

	test("stores only the SHA-256 of the code, for an hour, and audits without it", async () => {
		const now = new Date("2026-09-24T12:00:00.000Z");
		const code = await issueSetupCode(t.db, now);
		expect(code).toMatch(CODE_SHAPE);
		const rows = await codeRows();
		expect(rows).toHaveLength(1);
		const bare = code.replace(/-/g, "");
		expect(rows[0]?.code_hash).toBe(createHash("sha256").update(bare).digest("hex"));
		expect(JSON.stringify(rows)).not.toContain(bare);
		expect(new Date(rows[0]?.expires_at as Date).toISOString()).toBe(
			"2026-09-24T13:00:00.000Z",
		);

		const audits = await t.db.selectFrom("audit_events").selectAll().execute();
		expect(audits.map((a) => [a.action, a.result])).toEqual([
			["setup.code_issued", "ok"],
		]);
		for (const part of code.split("-")) {
			expect(JSON.stringify(audits)).not.toContain(part);
		}
	});

	test("a new code replaces an unused one but keeps a used one", async () => {
		const user = await insertTestUser(t.db);
		const used = await issueSetupCode(t.db);
		expect(await claimSetupCode(t.db, used, user)).toBe(true);
		const first = await issueSetupCode(t.db);
		const second = await issueSetupCode(t.db);
		expect(await claimSetupCode(t.db, first, user)).toBe(false);
		expect(await claimSetupCode(t.db, second, user)).toBe(true);
		expect((await codeRows()).map((r) => r.used_by)).toEqual([user, user]);
	});

	test("a code is single use", async () => {
		const [a, b] = [await insertTestUser(t.db), await insertTestUser(t.db)];
		const code = await issueSetupCode(t.db);
		expect(await claimSetupCode(t.db, code.toLowerCase(), a)).toBe(true);
		expect(await claimSetupCode(t.db, code, b)).toBe(false);
		const [row] = await codeRows();
		expect(row?.used_by).toBe(a);
		expect(row?.used_at).not.toBeNull();
	});

	test("a code expires after sixty minutes", async () => {
		const user = await insertTestUser(t.db);
		const issued = new Date("2026-09-24T12:00:00.000Z");
		const code = await issueSetupCode(t.db, issued);
		const late = new Date("2026-09-24T13:00:00.001Z");
		expect(await claimSetupCode(t.db, code, user, late)).toBe(false);
		const inTime = new Date("2026-09-24T12:59:59.000Z");
		expect(await claimSetupCode(t.db, code, user, inTime)).toBe(true);
	});

	test("a wrong or malformed code claims nothing", async () => {
		const user = await insertTestUser(t.db);
		await issueSetupCode(t.db);
		expect(await claimSetupCode(t.db, generateSetupCode(), user)).toBe(false);
		expect(await claimSetupCode(t.db, "not a code", user)).toBe(false);
		expect((await codeRows())[0]?.used_at).toBeNull();
	});

	test("counts only enabled administrators", async () => {
		expect(await hasEnabledAdministrator(t.db)).toBe(false);
		await insertTestUser(t.db, { role: "instructor" });
		await insertTestUser(t.db, {
			role: "administrator",
			disabled_at: new Date().toISOString(),
		});
		expect(await hasEnabledAdministrator(t.db)).toBe(false);
		await insertTestUser(t.db, { role: "administrator" });
		expect(await hasEnabledAdministrator(t.db)).toBe(true);
	});
});
