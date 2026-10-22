import { readdirSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createOidcClient } from "@portikus/auth";
import {
	CookieJar,
	csrfHeaders,
	loginAs,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import { collectingLogger } from "@portikus/observability/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { toAuthOptions } from "./auth-options.js";
import { buildServer } from "./server.js";
import { REPO_ROOT, specActionNames } from "./testing/spec-actions.js";
import { stubDex } from "./testing/stub-dex.js";
import { PUBLIC_URL, testConfig } from "./testing/test-support.js";

/**
 * SPEC.md section 24.11 lists the audit events the platform writes. The
 * action names are checked against the code in security/audit-coverage.test.ts.
 * This file checks that a test names each of them, and drives the two
 * administrator email actions that no route test asserted.
 */

const RESET_LINK_SENT = "dex_user.reset_link_sent";
const INVITATION_EMAILED = "admin.invitation_emailed";

/** Listed actions whose rows this file asserts below. */
const ASSERTED_HERE: ReadonlySet<string> = new Set([
	RESET_LINK_SENT,
	INVITATION_EMAILED,
]);

/**
 * Outcome rows the worker writes from the table OUTCOME_ACTIONS in
 * apps/worker/src/backups.ts. Their sibling kinds are asserted in
 * apps/worker/src/backups.test.ts; these seven are written by the same code
 * and no test names them. Fix the gap in the worker test, then delete the name
 * here: the test below fails while a name stays after a test names it.
 */
const UNASSERTED_WORKER_OUTCOMES: ReadonlySet<string> = new Set([
	"backup.failed",
	"backup.set_deleted",
	"backup.set_delete_failed",
	"backup.dump_deleted",
	"backup.home_imported",
	"backup.home_import_failed",
	"backup.snapshot_delete_failed",
]);

const SELF = fileURLToPath(import.meta.url);

/** Test files of the API, the worker, the controller and the shared packages. */
function testFiles(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules" || entry === "dist") continue;
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) testFiles(path, out);
		else if (/\.test\.tsx?$/.test(path) && path !== SELF) out.push(path);
	}
	return out;
}

function testSource(): string {
	const roots = [
		...["api", "worker", "workspace-controller", "workspace-agent"].map((app) =>
			join(REPO_ROOT, "apps", app, "src"),
		),
		...readdirSync(join(REPO_ROOT, "packages")).map((name) =>
			join(REPO_ROOT, "packages", name, "src"),
		),
	];
	return roots
		.filter((root) => {
			try {
				return statSync(root).isDirectory();
			} catch {
				return false;
			}
		})
		.flatMap((root) => testFiles(root))
		.map((file) => readFileSync(file, "utf8"))
		.join("\n");
}

describe("every SPEC.md section 24.11 action has a test that names it", () => {
	const names = specActionNames();
	const tests = testSource();
	const named = (name: string) => tests.includes(name);

	test("the section lists action names in a form this test can read", () => {
		expect(names.length).toBeGreaterThan(50);
		expect(names).toContain("preview.denied");
	});

	test("each listed action appears in a test, bar the known worker gaps", () => {
		const missing = names.filter(
			(name) =>
				!named(name) &&
				!ASSERTED_HERE.has(name) &&
				!UNASSERTED_WORKER_OUTCOMES.has(name),
		);
		expect(missing).toEqual([]);
	});

	test("the known gaps are real listed actions that still lack a test", () => {
		const stale = [...UNASSERTED_WORKER_OUTCOMES].filter(
			(name) => !names.includes(name) || named(name),
		);
		expect(stale).toEqual([]);
	});

	test("the actions asserted here are listed", () => {
		expect([...ASSERTED_HERE].filter((name) => !names.includes(name))).toEqual([]);
	});
});

const skip = !hasTestDb();
if (skip && process.env.CI) {
	throw new Error("the audit coverage test must run in CI: set TEST_DATABASE_URL");
}

let testDb: TestDb;
let mock: MockOidcProvider;
let app: FastifyInstance | undefined;
let mailDir: string;
let mailFile: string;
let carolId: string;
let lines: Record<string, unknown>[];

/** With no capture file and no mail server in the notification settings, a send fails. */
const NO_MAIL_SERVER = "no mail server";

async function startApp(captureFile: string): Promise<void> {
	const collected = collectingLogger("debug");
	lines = collected.lines;
	const base = {
		...testConfig(mock.issuer),
		NOTIFY_FILE: join(mailDir, "notify.json"),
	};
	const config =
		captureFile === NO_MAIL_SERVER ? base : { ...base, MAIL_CAPTURE_FILE: captureFile };
	app = buildServer({
		db: testDb.db,
		config,
		logger: collected.logger,
		oidc: createOidcClient(toAuthOptions(config)),
		dex: stubDex().dex,
	});
	await app.ready();
}

beforeAll(async () => {
	if (skip) return;
	testDb = await createTestDb();
	mock = await startMockOidcProvider({ redirectUris: [`${PUBLIC_URL}/auth/callback`] });
	mailDir = await mkdtemp(join(tmpdir(), "portikus-audit-coverage-"));
	mailFile = join(mailDir, "mail.jsonl");
});

afterAll(async () => {
	if (skip) return;
	await testDb.close();
	await mock.close();
	await rm(mailDir, { recursive: true, force: true });
});

beforeEach(async () => {
	if (skip) return;
	await testDb.truncate();
	await rm(mailFile, { force: true });
	return async () => {
		await app?.close();
		app = undefined;
	};
});

async function switchOn(): Promise<void> {
	await testDb.db
		.insertInto("settings")
		.values({ id: 1, shutdown_grace_seconds: 600, account_email_enabled: true })
		.onConflict((oc) => oc.column("id").doUpdateSet({ account_email_enabled: true }))
		.execute();
}

/** Sign in as the administrator (the mock provider's "carol"). */
async function adminJar(): Promise<CookieJar> {
	if (!app) throw new Error("start the app first");
	const jar = new CookieJar();
	await loginAs(app, "carol", jar);
	carolId = (
		await testDb.db
			.selectFrom("users")
			.select("id")
			.where("oidc_subject", "=", "carol")
			.executeTakeFirstOrThrow()
	).id;
	return jar;
}

function post(jar: CookieJar, url: string, payload?: object) {
	if (!app) throw new Error("start the app first");
	return app.inject({
		method: "POST",
		url,
		headers: csrfHeaders(jar, PUBLIC_URL),
		...(payload ? { payload } : {}),
	});
}

async function auditRows(action: string) {
	return testDb.db
		.selectFrom("audit_events")
		.select(["actor", "target", "result", "metadata"])
		.where("action", "=", action)
		.orderBy("id")
		.execute();
}

async function mailSent(): Promise<number> {
	try {
		return (await readFile(mailFile, "utf8")).split("\n").filter((l) => l !== "")
			.length;
	} catch {
		return 0;
	}
}

async function addDana(jar: CookieJar): Promise<string> {
	const res = await post(jar, "/admin/dex-users", {
		name: "Dana",
		email: "dana@example.edu",
		username: "dana",
		role: "student",
	});
	expect(res.statusCode).toBe(200);
	return (res.json() as { user: { id: string } }).user.id;
}

describe.skipIf(skip)(`${RESET_LINK_SENT} (SPEC.md section 24.11)`, () => {
	test("a reset link the administrator sends writes an ok row with the token row id only", async () => {
		await startApp(mailFile);
		await switchOn();
		const jar = await adminJar();
		const userId = await addDana(jar);
		expect(
			(await post(jar, `/admin/dex-users/${userId}/send-reset-link`)).statusCode,
		).toBe(204);
		const token = await testDb.db
			.selectFrom("account_email_tokens")
			.select("id")
			.where("user_id", "=", userId)
			.where("purpose", "=", "reset")
			.executeTakeFirstOrThrow();
		expect(await auditRows(RESET_LINK_SENT)).toEqual([
			{
				actor: `user:${carolId}`,
				target: userId,
				result: "ok",
				metadata: { tokenId: token.id },
			},
		]);
		const stored = JSON.stringify(await auditRows(RESET_LINK_SENT));
		expect(stored).not.toContain("dana@");
		expect(stored).not.toContain("example.edu");
	});

	test("an email that cannot be sent writes a failed row", async () => {
		await startApp(NO_MAIL_SERVER);
		await switchOn();
		const jar = await adminJar();
		const userId = await addDana(jar);
		const res = await post(jar, `/admin/dex-users/${userId}/send-reset-link`);
		expect(res.statusCode).not.toBe(204);
		const rows = await auditRows(RESET_LINK_SENT);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ target: userId, result: "failed" });
	});

	test("a refused request (account email off) writes no row", async () => {
		await startApp(mailFile);
		const jar = await adminJar();
		const userId = await addDana(jar);
		const res = await post(jar, `/admin/dex-users/${userId}/send-reset-link`);
		expect(res.statusCode).toBe(409);
		expect(await auditRows(RESET_LINK_SENT)).toEqual([]);
		expect(await mailSent()).toBe(0);
	});
});

describe.skipIf(skip)(`${INVITATION_EMAILED} (SPEC.md section 24.11)`, () => {
	const NINA = { name: "Nina", email: "nina@example.edu", role: "student" };

	test("creating an invitation with sendEmail writes an ok row with no address", async () => {
		await startApp(mailFile);
		await switchOn();
		const jar = await adminJar();
		const res = await post(jar, "/admin/invitations", { ...NINA, sendEmail: true });
		expect(res.statusCode).toBe(201);
		const { id } = res.json() as { id: string };
		expect(await auditRows(INVITATION_EMAILED)).toEqual([
			{
				actor: `user:${carolId}`,
				target: `invitation:${id}`,
				result: "ok",
				metadata: {},
			},
		]);
		expect(JSON.stringify(await auditRows(INVITATION_EMAILED))).not.toContain("nina@");
	});

	test("resending a waiting invitation writes another ok row", async () => {
		await startApp(mailFile);
		await switchOn();
		const jar = await adminJar();
		const { id } = (await post(jar, "/admin/invitations", NINA)).json() as {
			id: string;
		};
		expect(await auditRows(INVITATION_EMAILED)).toEqual([]);
		expect((await post(jar, `/admin/invitations/${id}/send`)).statusCode).toBe(204);
		const rows = await auditRows(INVITATION_EMAILED);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ target: `invitation:${id}`, result: "ok" });
	});

	test("an email that cannot be sent writes a failed row", async () => {
		await startApp(NO_MAIL_SERVER);
		await switchOn();
		const jar = await adminJar();
		const { id } = (await post(jar, "/admin/invitations", NINA)).json() as {
			id: string;
		};
		const res = await post(jar, `/admin/invitations/${id}/send`);
		expect(res.statusCode).not.toBe(204);
		const rows = await auditRows(INVITATION_EMAILED);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ target: `invitation:${id}`, result: "failed" });
	});

	test("a CSV import that emails an invitation writes a row for it", async () => {
		await startApp(mailFile);
		await switchOn();
		const jar = await adminJar();
		const csv = [
			"name,email,username,role,kind",
			"Quinn,quinn@example.edu,,student,invite",
		].join("\n");
		const res = await post(jar, "/admin/accounts/import", { csv, sendEmail: true });
		expect(res.statusCode).toBe(200);
		const rows = await auditRows(INVITATION_EMAILED);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ actor: `user:${carolId}`, result: "ok" });
		expect(rows[0]?.target).toMatch(/^invitation:/);
		expect(JSON.stringify(lines)).not.toContain("quinn@");
	});
});
