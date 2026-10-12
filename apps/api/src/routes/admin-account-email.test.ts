import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createOidcClient,
	createSession,
	DEX_ACCOUNT_ISSUER,
	dexLocalSubject,
	LOCAL_ADMIN_USER_ID,
} from "@portikus/auth";
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
import { hashAccountEmailToken } from "../account-email/tokens.js";
import { toAuthOptions } from "../auth-options.js";
import { buildServer } from "../server.js";
import { stubDex } from "../testing/stub-dex.js";
import { PUBLIC_URL, testConfig } from "../testing/test-support.js";

/**
 * Account email an administrator sends, and editing a Dex user's email or
 * username (SPEC.md sections 5.1 and 5.3). Mail goes to MAIL_CAPTURE_FILE.
 */

const skip = !hasTestDb();

let testDb: TestDb;
let mock: MockOidcProvider;
let app: FastifyInstance;
let stub: ReturnType<typeof stubDex>;
let mailDir: string;
let mailFile: string;
let lines: Record<string, unknown>[];

beforeAll(async () => {
	if (skip) return;
	testDb = await createTestDb();
	mock = await startMockOidcProvider({ redirectUris: [`${PUBLIC_URL}/auth/callback`] });
	mailDir = await mkdtemp(join(tmpdir(), "portikus-admin-mail-"));
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
	stub = stubDex();
	const collected = collectingLogger("debug");
	lines = collected.lines;
	const config = { ...testConfig(mock.issuer), MAIL_CAPTURE_FILE: mailFile };
	app = buildServer({
		db: testDb.db,
		config,
		logger: collected.logger,
		oidc: createOidcClient(toAuthOptions(config)),
		dex: stub.dex,
	});
	await app.ready();
	return async () => {
		await app.close();
	};
});

interface Mail {
	to: string[];
	subject: string;
	text: string;
}

async function mail(): Promise<Mail[]> {
	let text: string;
	try {
		text = await readFile(mailFile, "utf8");
	} catch {
		return [];
	}
	return text
		.split("\n")
		.filter((l) => l !== "")
		.map((l) => {
			const m = JSON.parse(l) as {
				to: { address: string }[];
				subject: string;
				text: string;
			};
			return { to: m.to.map((a) => a.address), subject: m.subject, text: m.text };
		});
}

function tokenIn(message: Mail | undefined): string {
	const token = message?.text.match(/#([A-Za-z0-9_-]{43})/)?.[1];
	if (!token) throw new Error("no link in the message");
	return token;
}

async function switchOn(): Promise<void> {
	await testDb.db
		.insertInto("settings")
		.values({ id: 1, shutdown_grace_seconds: 600, account_email_enabled: true })
		.onConflict((oc) => oc.column("id").doUpdateSet({ account_email_enabled: true }))
		.execute();
}

async function adminJar(): Promise<CookieJar> {
	const jar = new CookieJar();
	await loginAs(app, "carol", jar);
	return jar;
}

function send(jar: CookieJar, method: "POST" | "PATCH", url: string, payload?: object) {
	return app.inject({
		method,
		url,
		headers: csrfHeaders(jar, PUBLIC_URL),
		...(payload ? { payload } : {}),
	});
}

const DANA = {
	name: "Dana",
	email: "dana@example.edu",
	username: "dana",
	role: "student",
};

async function addDana(jar: CookieJar, extra: object = {}) {
	const res = await send(jar, "POST", "/admin/dex-users", { ...DANA, ...extra });
	expect(res.statusCode).toBe(200);
	return res.json() as {
		user: { id: string; email: string; preferredUsername: string };
		password: string | null;
		emailed: boolean;
	};
}

async function tokenRows(userId: string) {
	return testDb.db
		.selectFrom("account_email_tokens")
		.select(["id", "purpose", "token_hash", "expires_at", "created_at", "revoked_at"])
		.where("user_id", "=", userId)
		.orderBy("created_at")
		.execute();
}

async function audit(action: string) {
	return testDb.db
		.selectFrom("audit_events")
		.select(["target", "result", "metadata"])
		.where("action", "=", action)
		.orderBy("id")
		.execute();
}

describe.skipIf(skip)("Add user with an emailed link", () => {
	test("emails a 7-day invite link and shows no password", async () => {
		await switchOn();
		const jar = await adminJar();
		const created = await addDana(jar, { sendLink: true });
		expect(created.password).toBeNull();
		expect(created.emailed).toBe(true);
		const [message] = await mail();
		expect(message?.to).toEqual(["dana@example.edu"]);
		expect(message?.text).toContain(`${PUBLIC_URL}/reset-password#`);
		const [row] = await tokenRows(created.user.id);
		expect(row?.purpose).toBe("invite");
		expect(row?.token_hash).toBe(hashAccountEmailToken(tokenIn(message)));
		const lifetime =
			(row?.expires_at.getTime() ?? 0) - (row?.created_at.getTime() ?? 0);
		expect(lifetime).toBe(7 * 24 * 60 * 60_000);
		// The audit row holds the token row id, never the token or the address.
		const [sent] = await audit("dex_user.invite_sent");
		expect(sent?.metadata).toEqual({ tokenId: row?.id });
		expect(JSON.stringify(await audit("dex_user.invite_sent"))).not.toContain("dana@");
		expect(JSON.stringify(lines)).not.toContain(tokenIn(message));
	});

	test("is refused with account email off, and nothing is made", async () => {
		const jar = await adminJar();
		const res = await send(jar, "POST", "/admin/dex-users", {
			...DANA,
			sendLink: true,
		});
		expect(res.statusCode).toBe(409);
		expect(res.json().code).toBe("ACCOUNT_EMAIL_OFF");
		expect(stub.passwords.size).toBe(0);
		expect(await mail()).toEqual([]);
	});

	test("without sendLink still shows the password, even with account email on", async () => {
		await switchOn();
		const jar = await adminJar();
		const created = await addDana(jar);
		expect(created.password).toMatch(/^[A-Za-z0-9]{20}$/);
		expect(created.emailed).toBe(false);
		expect(await mail()).toEqual([]);
	});
});

describe.skipIf(skip)("Send reset link", () => {
	test("emails a 30-minute reset link to the address Dex holds", async () => {
		await switchOn();
		const jar = await adminJar();
		const { user } = await addDana(jar);
		// Portikus's copy of the email is not trusted for the address.
		await testDb.db
			.updateTable("users")
			.set({ email: "elsewhere@example.edu" })
			.where("id", "=", user.id)
			.execute();
		const res = await send(jar, "POST", `/admin/dex-users/${user.id}/send-reset-link`);
		expect(res.statusCode).toBe(204);
		const [message] = await mail();
		expect(message?.to).toEqual(["dana@example.edu"]);
		const [row] = await tokenRows(user.id);
		expect(row?.purpose).toBe("reset");
		expect((row?.expires_at.getTime() ?? 0) - (row?.created_at.getTime() ?? 0)).toBe(
			30 * 60_000,
		);
	});

	test("a second link revokes the first", async () => {
		await switchOn();
		const jar = await adminJar();
		const { user } = await addDana(jar);
		await send(jar, "POST", `/admin/dex-users/${user.id}/send-reset-link`);
		await send(jar, "POST", `/admin/dex-users/${user.id}/send-reset-link`);
		const rows = await tokenRows(user.id);
		expect(rows.map((r) => r.revoked_at === null)).toEqual([false, true]);
	});

	test("allows five an hour per account, then 429 audited once", async () => {
		await switchOn();
		const jar = await adminJar();
		const { user } = await addDana(jar);
		const url = `/admin/dex-users/${user.id}/send-reset-link`;
		for (let i = 0; i < 5; i++)
			expect((await send(jar, "POST", url)).statusCode).toBe(204);
		expect((await send(jar, "POST", url)).statusCode).toBe(429);
		expect((await send(jar, "POST", url)).statusCode).toBe(429);
		expect(await mail()).toHaveLength(5);
		const throttled = await audit("auth.throttled");
		expect(throttled).toHaveLength(1);
		expect(throttled[0]?.metadata).toEqual({ scope: "admin-account-email" });
	});

	test("is refused with account email off", async () => {
		const jar = await adminJar();
		const { user } = await addDana(jar);
		const res = await send(jar, "POST", `/admin/dex-users/${user.id}/send-reset-link`);
		expect(res.statusCode).toBe(409);
		expect(await tokenRows(user.id)).toEqual([]);
	});

	test("is refused for the install administrator", async () => {
		await switchOn();
		const jar = await adminJar();
		const install = await testDb.db
			.insertInto("users")
			.values({
				oidc_issuer: DEX_ACCOUNT_ISSUER,
				oidc_subject: dexLocalSubject(LOCAL_ADMIN_USER_ID),
				email: "admin@example.edu",
				display_name: "admin",
				role: "administrator",
				provider_role: "student",
				granted_role: "administrator",
			})
			.returning("id")
			.executeTakeFirstOrThrow();
		stub.passwords.set("admin@example.edu", {
			email: "admin@example.edu",
			username: "admin",
			userId: LOCAL_ADMIN_USER_ID,
			hash: "x",
		});
		const reset = await send(
			jar,
			"POST",
			`/admin/dex-users/${install.id}/send-reset-link`,
		);
		expect(reset.statusCode).toBe(403);
		const edit = await send(jar, "PATCH", `/admin/dex-users/${install.id}`, {
			email: "new@example.edu",
		});
		expect(edit.statusCode).toBe(403);
		expect(stub.passwords.has("admin@example.edu")).toBe(true);
		expect(await mail()).toEqual([]);
	});
});

describe.skipIf(skip)("Editing a Dex user", () => {
	test("a new username changes in place and keeps the password and sessions", async () => {
		const jar = await adminJar();
		const { user } = await addDana(jar);
		const hash = stub.passwords.get("dana@example.edu")?.hash;
		await createSession(testDb.db, user.id, 3600, {
			method: "oidc",
			courseUserId: null,
		});
		const res = await send(jar, "PATCH", `/admin/dex-users/${user.id}`, {
			username: "dana2",
		});
		expect(res.statusCode).toBe(200);
		expect(res.json().password).toBeNull();
		expect(res.json().user.preferredUsername).toBe("dana2");
		const stored = stub.passwords.get("dana@example.edu");
		expect(stored?.username).toBe("dana2");
		expect(stored?.hash).toBe(hash);
		const sessions = await testDb.db
			.selectFrom("sessions")
			.select("id")
			.where("user_id", "=", user.id)
			.execute();
		expect(sessions).toHaveLength(1);
		const [row] = await audit("dex_user.updated");
		expect(row?.metadata).toMatchObject({ fields: ["username"] });
	});

	test("a new email keeps the user ID and account, ends sessions, and shows a new password", async () => {
		const jar = await adminJar();
		const { user } = await addDana(jar);
		const before = stub.passwords.get("dana@example.edu");
		await createSession(testDb.db, user.id, 3600, {
			method: "oidc",
			courseUserId: null,
		});
		const res = await send(jar, "PATCH", `/admin/dex-users/${user.id}`, {
			email: "Dana.New@Example.edu",
		});
		expect(res.statusCode).toBe(200);
		const body = res.json();
		expect(body.user.id).toBe(user.id);
		expect(body.user.email).toBe("dana.new@example.edu");
		expect(body.password).toMatch(/^[A-Za-z0-9]{20}$/);
		expect(body.emailed).toBe(false);
		// The old password never survives.
		expect(stub.passwords.has("dana@example.edu")).toBe(false);
		const after = stub.passwords.get("dana.new@example.edu");
		expect(after?.userId).toBe(before?.userId);
		expect(after?.hash).not.toBe(before?.hash);
		const account = await testDb.db
			.selectFrom("users")
			.select(["oidc_subject", "must_change_password"])
			.where("id", "=", user.id)
			.executeTakeFirstOrThrow();
		expect(account.oidc_subject).toBe(dexLocalSubject(before?.userId ?? ""));
		expect(account.must_change_password).toBe(true);
		const sessions = await testDb.db
			.selectFrom("sessions")
			.select("id")
			.where("user_id", "=", user.id)
			.execute();
		expect(sessions).toEqual([]);
		const rows = await audit("dex_user.updated");
		expect(rows[0]?.metadata).toMatchObject({ fields: ["email"] });
		expect(JSON.stringify(rows)).not.toContain("example.edu");
	});

	test("with account email on, the new address gets a link and the old one a notice", async () => {
		await switchOn();
		const jar = await adminJar();
		const { user } = await addDana(jar);
		await send(jar, "POST", `/admin/dex-users/${user.id}/send-reset-link`);
		const res = await send(jar, "PATCH", `/admin/dex-users/${user.id}`, {
			email: "dana.new@example.edu",
		});
		expect(res.json().password).toBeNull();
		expect(res.json().emailed).toBe(true);
		const messages = await mail();
		const toNew = messages.filter((m) => m.to.includes("dana.new@example.edu"));
		const toOld = messages.filter((m) => m.to.includes("dana@example.edu"));
		expect(toNew).toHaveLength(1);
		expect(toNew[0]?.text).toContain("/reset-password#");
		expect(toOld.at(-1)?.subject).toBe("Your Portikus email address was changed");
		expect(toOld.at(-1)?.text).not.toContain("reset-password");
		// The earlier reset link is revoked; only the new invite is live.
		const live = (await tokenRows(user.id)).filter((r) => r.revoked_at === null);
		expect(live.map((r) => r.purpose)).toEqual(["invite"]);
	});

	test("an email another Dex user holds is refused and nothing changes", async () => {
		const jar = await adminJar();
		const { user } = await addDana(jar);
		await send(jar, "POST", "/admin/dex-users", {
			...DANA,
			email: "erin@example.edu",
			username: "erin",
		});
		const res = await send(jar, "PATCH", `/admin/dex-users/${user.id}`, {
			email: "erin@example.edu",
		});
		expect(res.statusCode).toBe(409);
		expect(stub.passwords.has("dana@example.edu")).toBe(true);
	});

	test("Dex failing after the delete fails closed, and a retry finishes the change", async () => {
		const jar = await adminJar();
		const { user } = await addDana(jar);
		const create = stub.dex.createPassword.bind(stub.dex);
		stub.dex.createPassword = async () => {
			throw Object.assign(new Error("unavailable"), { code: 14 });
		};
		const failed = await send(jar, "PATCH", `/admin/dex-users/${user.id}`, {
			email: "dana.new@example.edu",
		});
		expect(failed.statusCode).toBe(503);
		// No password at all: nobody can sign in as the account.
		expect(stub.passwords.size).toBe(0);
		stub.dex.createPassword = create;
		const retried = await send(jar, "PATCH", `/admin/dex-users/${user.id}`, {
			email: "dana.new@example.edu",
		});
		expect(retried.statusCode).toBe(200);
		expect([...stub.passwords.keys()]).toEqual(["dana.new@example.edu"]);
		expect(retried.json().user.email).toBe("dana.new@example.edu");
	});

	test("a retry after Dex took the change but the database did not finishes it", async () => {
		const jar = await adminJar();
		const { user } = await addDana(jar);
		const stored = stub.passwords.get("dana@example.edu");
		if (!stored) throw new Error("no password");
		// Dex already moved, and the account still has the old email; a stale second row too.
		stub.passwords.set("dana.new@example.edu", {
			...stored,
			email: "dana.new@example.edu",
		});
		const res = await send(jar, "PATCH", `/admin/dex-users/${user.id}`, {
			email: "dana.new@example.edu",
		});
		expect(res.statusCode).toBe(200);
		expect([...stub.passwords.keys()]).toEqual(["dana.new@example.edu"]);
		expect(res.json().password).toMatch(/^[A-Za-z0-9]{20}$/);
	});

	test("Remove deletes every password under the user ID", async () => {
		const jar = await adminJar();
		const { user } = await addDana(jar);
		const stored = stub.passwords.get("dana@example.edu");
		if (!stored) throw new Error("no password");
		stub.passwords.set("dana.new@example.edu", {
			...stored,
			email: "dana.new@example.edu",
		});
		const res = await send(jar, "POST", `/admin/dex-users/${user.id}/remove`);
		expect(res.statusCode).toBe(200);
		expect(stub.passwords.size).toBe(0);
	});

	test("nothing to change answers with the account and touches nothing", async () => {
		const jar = await adminJar();
		const { user } = await addDana(jar);
		const res = await send(jar, "PATCH", `/admin/dex-users/${user.id}`, {
			email: "dana@example.edu",
			username: "dana",
		});
		expect(res.statusCode).toBe(200);
		expect(await audit("dex_user.updated")).toEqual([]);
	});

	test("an empty body and your own account are refused", async () => {
		const jar = await adminJar();
		const { user } = await addDana(jar);
		expect(
			(await send(jar, "PATCH", `/admin/dex-users/${user.id}`, {})).statusCode,
		).toBe(400);
		const me = await testDb.db
			.selectFrom("users")
			.select("id")
			.where("oidc_subject", "=", "carol")
			.executeTakeFirstOrThrow();
		const self = await send(jar, "PATCH", `/admin/dex-users/${me.id}`, {
			username: "c",
		});
		expect(self.statusCode).toBe(400);
	});
});

describe.skipIf(skip)("SSO invitations by email", () => {
	const NINA = { name: "Nina", email: "nina@example.edu", role: "student" };

	test("Invite with sendEmail emails a sign-in pointer with no token", async () => {
		await switchOn();
		const jar = await adminJar();
		const res = await send(jar, "POST", "/admin/invitations", {
			...NINA,
			sendEmail: true,
		});
		expect(res.statusCode).toBe(201);
		expect(res.json().emailed).toBe(true);
		const [message] = await mail();
		expect(message?.to).toEqual(["nina@example.edu"]);
		expect(message?.text).toContain(`${PUBLIC_URL}/`);
		expect(message?.text).not.toContain("#");
	});

	test("Resend sends again, five an hour, and 404s for a revoked invitation", async () => {
		await switchOn();
		const jar = await adminJar();
		const created = (await send(jar, "POST", "/admin/invitations", NINA)).json();
		expect(created.emailed).toBe(false);
		const url = `/admin/invitations/${created.id}/send`;
		for (let i = 0; i < 5; i++)
			expect((await send(jar, "POST", url)).statusCode).toBe(204);
		expect((await send(jar, "POST", url)).statusCode).toBe(429);
		await send(jar, "POST", `/admin/invitations/${created.id}/revoke`);
		expect((await send(jar, "POST", url)).statusCode).toBe(404);
	});

	test("is refused with account email off, and no invitation is made", async () => {
		const jar = await adminJar();
		const res = await send(jar, "POST", "/admin/invitations", {
			...NINA,
			sendEmail: true,
		});
		expect(res.statusCode).toBe(409);
		const rows = await testDb.db
			.selectFrom("account_invitations")
			.select("id")
			.where("email", "=", NINA.email)
			.execute();
		expect(rows).toEqual([]);
	});
});

describe.skipIf(skip)("CSV import with email", () => {
	const CSV = [
		"name,email,username,role,kind",
		"Pat,pat@example.edu,pat,student,password",
		"Quinn,quinn@example.edu,,student,invite",
	].join("\n");

	test("emails each person and shows no passwords", async () => {
		await switchOn();
		const jar = await adminJar();
		const res = await send(jar, "POST", "/admin/accounts/import", {
			csv: CSV,
			sendEmail: true,
		});
		expect(res.statusCode).toBe(200);
		const rows = res.json().rows as {
			outcome: string;
			emailed?: boolean;
			password?: string;
		}[];
		expect(rows.map((r) => [r.outcome, r.emailed, r.password])).toEqual([
			["created", true, undefined],
			["invited", true, undefined],
		]);
		const to = (await mail()).flatMap((m) => m.to).sort();
		expect(to).toEqual(["pat@example.edu", "quinn@example.edu"]);
	});

	test("is refused with account email off", async () => {
		const jar = await adminJar();
		const res = await send(jar, "POST", "/admin/accounts/import", {
			csv: CSV,
			sendEmail: true,
		});
		expect(res.statusCode).toBe(409);
		expect(stub.passwords.size).toBe(0);
	});
});
