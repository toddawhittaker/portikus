import { createOidcClient } from "@portikus/auth";
import {
	CookieJar,
	csrfHeaders,
	loginAs,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import type {
	AccountImportPreviewRow,
	AccountImportResultRow,
} from "@portikus/contracts";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import { collectingLogger } from "@portikus/observability/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { ADMIN_ROW_REASON } from "../admin/account-import.js";
import { toAuthOptions } from "../auth-options.js";
import { buildServer } from "../server.js";
import { stubDex } from "../testing/stub-dex.js";
import { buildTestServer, PUBLIC_URL, testConfig } from "../testing/test-support.js";

/**
 * Bulk-add accounts from a CSV file (SPEC.md section 5.1, "Add user";
 * section 24.13): the preview classifies, confirm checks again and creates
 * only the valid rows, and a one-time password appears only in confirm's
 * response, never in the audit log or the server log.
 */

const skip = !hasTestDb();
let testDb: TestDb;
let mock: MockOidcProvider;
let app: FastifyInstance;
let stub: ReturnType<typeof stubDex>;
let lines: Record<string, unknown>[];
let admin: CookieJar;

beforeAll(async () => {
	if (skip) return;
	testDb = await createTestDb();
	mock = await startMockOidcProvider({ redirectUris: [`${PUBLIC_URL}/auth/callback`] });
});

afterAll(async () => {
	if (skip) return;
	await testDb.close();
	await mock.close();
});

beforeEach(async () => {
	if (skip) return;
	await testDb.truncate();
	stub = stubDex();
	const collected = collectingLogger("debug");
	lines = collected.lines;
	const config = testConfig(mock.issuer);
	app = buildServer({
		db: testDb.db,
		config,
		logger: collected.logger,
		oidc: createOidcClient(toAuthOptions(config)),
		dex: stub.dex,
		previewPollIntervalMs: 50,
	});
	await app.ready();
	admin = new CookieJar();
	await loginAs(app, "carol", admin);
	return async () => {
		await app.close();
	};
});

function post(url: string, csv: unknown, jar = admin, server = app) {
	return server.inject({
		method: "POST",
		url,
		headers: csrfHeaders(jar, PUBLIC_URL),
		payload: { csv },
	});
}

async function preview(csv: string): Promise<AccountImportPreviewRow[]> {
	const res = await post("/admin/accounts/import/preview", csv);
	expect(res.statusCode).toBe(200);
	return res.json().rows;
}

async function confirm(csv: string): Promise<AccountImportResultRow[]> {
	const res = await post("/admin/accounts/import", csv);
	expect(res.statusCode).toBe(200);
	return res.json().rows;
}

const HEADER = "name,email,username,role,kind\n";

const MIXED = `${HEADER}${[
	"Pat Password,pat@example.edu,pat,student,password",
	'"Iris, Invite",iris@example.edu,Iris@Tenant.example,instructor,invite',
	"Al Admin,al@example.edu,al,administrator,password",
	"No Email,,nobody,student,password",
	"Bad Kind,bk@example.edu,bk,student,email",
	"Pat Again,PAT@example.edu,pat2,student,invite",
	"Carol Exists,carol@example.edu,carol2,student,password",
].join("\r\n")}\r\n`;

test.skipIf(skip)("the preview marks valid, invalid and duplicate rows", async () => {
	const rows = await preview(MIXED);
	expect(rows.map((r) => [r.line, r.status])).toEqual([
		[2, "valid"],
		[3, "valid"],
		[4, "invalid"],
		[5, "invalid"],
		[6, "invalid"],
		[7, "duplicate"],
		[8, "duplicate"],
	]);
	expect(rows[1]?.name).toBe("Iris, Invite");
	expect(rows[2]?.reason).toBe(ADMIN_ROW_REASON);
	expect(rows[3]?.reason).toMatch(/^email:/);
	expect(rows[4]?.reason).toBe("Kind must be password or invite.");
	expect(rows[5]?.reason).toBe("Repeats row 2.");
	expect(rows[6]?.reason).toBe("An account with this email already exists.");
	// The preview creates nothing.
	expect(stub.passwords.size).toBe(0);
	const invites = await testDb.db
		.selectFrom("account_invitations")
		.select("id")
		.where("email", "=", "iris@example.edu")
		.execute();
	expect(invites).toHaveLength(0);
});

test.skipIf(skip)(
	"confirm creates the valid rows, returns each password once, and audits counts only",
	async () => {
		const rows = await confirm(MIXED);
		expect(rows.map((r) => r.outcome)).toEqual([
			"created",
			"invited",
			"invalid",
			"invalid",
			"invalid",
			"skipped",
			"skipped",
		]);
		const password = rows[0]?.password ?? "";
		expect(password).toMatch(/^[A-Za-z0-9]{20}$/);
		expect(rows.filter((r) => r.password !== undefined)).toHaveLength(1);

		const pat = await testDb.db
			.selectFrom("users")
			.select(["role", "must_change_password", "display_name", "preferred_username"])
			.where("email", "=", "pat@example.edu")
			.executeTakeFirstOrThrow();
		expect(pat).toEqual({
			role: "student",
			must_change_password: true,
			display_name: "Pat Password",
			preferred_username: "pat",
		});
		expect(stub.passwords.has("pat@example.edu")).toBe(true);
		const iris = await testDb.db
			.selectFrom("account_invitations")
			.select(["email", "username", "role", "display_name"])
			.where("email", "=", "iris@example.edu")
			.executeTakeFirstOrThrow();
		expect(iris).toEqual({
			email: "iris@example.edu",
			username: "iris@tenant.example",
			role: "instructor",
			display_name: "Iris, Invite",
		});
		// Nobody became an administrator.
		const al = await testDb.db
			.selectFrom("users")
			.select("id")
			.where("email", "=", "al@example.edu")
			.execute();
		expect(al).toHaveLength(0);

		const audit = await testDb.db
			.selectFrom("audit_events")
			.select(["action", "metadata"])
			.orderBy("id")
			.execute();
		const imported = audit.filter((a) => a.action === "admin.accounts_imported");
		expect(imported).toHaveLength(1);
		expect(imported[0]?.metadata).toMatchObject({
			created: 1,
			invited: 1,
			skipped: 2,
			invalid: 3,
			failed: 0,
		});
		expect(audit.map((a) => a.action)).toEqual(
			expect.arrayContaining(["dex_user.created", "admin.invitation_created"]),
		);
		expect(JSON.stringify(audit)).not.toContain(password);
		expect(JSON.stringify(lines)).not.toContain(password);
	},
);

test.skipIf(skip)("a re-upload skips everyone it already added", async () => {
	await confirm(MIXED);
	const again = await confirm(MIXED);
	expect(
		again.filter((r) => r.outcome === "created" || r.outcome === "invited"),
	).toEqual([]);
	expect(again[0]).toMatchObject({
		outcome: "skipped",
		reason: "An account with this email already exists.",
	});
	expect(again[1]).toMatchObject({
		outcome: "skipped",
		reason: "An invitation for this email is already waiting.",
	});
	expect(stub.passwords.size).toBe(1);
});

test.skipIf(skip)("confirm checks again instead of trusting the preview", async () => {
	const csv = `${HEADER}Nell New,nell@example.edu,nell,student,password\n`;
	expect((await preview(csv))[0]?.status).toBe("valid");
	// Someone adds her between preview and confirm.
	const added = await app.inject({
		method: "POST",
		url: "/admin/dex-users",
		headers: csrfHeaders(admin, PUBLIC_URL),
		payload: {
			name: "Nell",
			email: "nell@example.edu",
			username: "nell",
			role: "student",
		},
	});
	expect(added.statusCode).toBe(200);
	const rows = await confirm(csv);
	expect(rows[0]).toMatchObject({ outcome: "skipped" });
	expect(rows[0]?.password).toBeUndefined();
});

test.skipIf(skip)("a row Dex cannot take is reported failed, not lost", async () => {
	stub.state.failing = true;
	const rows = await confirm(
		`${HEADER}Fay Fail,fay@example.edu,fay,student,password\n`,
	);
	expect(rows[0]).toMatchObject({
		outcome: "failed",
		reason: "Dex could not be reached.",
	});
	const fay = await testDb.db
		.selectFrom("users")
		.select("id")
		.where("email", "=", "fay@example.edu")
		.execute();
	expect(fay).toHaveLength(0);
});

test.skipIf(skip)("a bad file is refused whole", async () => {
	const missing = await post(
		"/admin/accounts/import/preview",
		"name,email\nA,a@x.edu\n",
	);
	expect(missing.statusCode).toBe(400);
	expect(missing.json().message).toContain('"username"');
	const notText = await post("/admin/accounts/import", 42);
	expect(notText.statusCode).toBe(400);
	const tooMany = await post(
		"/admin/accounts/import",
		HEADER + "A,a@example.edu,a,student,invite\n".repeat(501),
	);
	expect(tooMany.statusCode).toBe(400);
	const audit = await testDb.db
		.selectFrom("audit_events")
		.select("id")
		.where("action", "=", "admin.accounts_imported")
		.execute();
	expect(audit).toHaveLength(0);
});

test.skipIf(skip)("non-administrators are refused", async () => {
	const student = new CookieJar();
	await loginAs(app, "alice", student);
	const csv = `${HEADER}A,a@example.edu,a,student,invite\n`;
	expect((await post("/admin/accounts/import/preview", csv, student)).statusCode).toBe(
		403,
	);
	expect((await post("/admin/accounts/import", csv, student)).statusCode).toBe(403);
});

test.skipIf(skip)("a site without Dex passwords takes only invite rows", async () => {
	const plain = buildTestServer(testDb.db, mock.issuer);
	await plain.ready();
	try {
		const jar = new CookieJar();
		await loginAs(plain, "carol", jar);
		const res = await post(
			"/admin/accounts/import/preview",
			`${HEADER}P,p@example.edu,p,student,password\nI,i@example.edu,,student,invite\n`,
			jar,
			plain,
		);
		const rows: AccountImportPreviewRow[] = res.json().rows;
		expect(rows.map((r) => r.status)).toEqual(["invalid", "valid"]);
		expect(rows[0]?.reason).toContain("Use kind invite");
	} finally {
		await plain.close();
	}
});
