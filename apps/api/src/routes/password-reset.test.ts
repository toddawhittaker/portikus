import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createDexApi,
	createOidcClient,
	createSession,
	DEX_ACCOUNT_ISSUER,
	type DexApi,
	dexLocalSubject,
	hashDexPassword,
	LOCAL_ADMIN_USER_ID,
} from "@portikus/auth";
import {
	type DexGrpcCerts,
	type FakeDexGrpc,
	type MockOidcProvider,
	startFakeDexGrpc,
	startMockOidcProvider,
	writeDexGrpcCerts,
} from "@portikus/auth/testing";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import { collectingLogger } from "@portikus/observability/testing";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { issueAccountEmailToken } from "../account-email/tokens.js";
import { toAuthOptions } from "../auth-options.js";
import { buildServer } from "../server.js";
import { PUBLIC_URL, testConfig } from "../testing/test-support.js";

/**
 * Forgotten password by email (SPEC.md sections 5.3 and 24.13): one answer
 * for every request, throttles, single-use links, the install administrator
 * left out, and every session ended by a completed reset.
 */

const skip = !hasTestDb();
const OLD = "the-old-password-here";
const NEW = "a-brand-new-long-password";
const ORIGIN = new URL(PUBLIC_URL).origin;

let testDb: TestDb;
let mock: MockOidcProvider;
let dir: string;
let certs: DexGrpcCerts;
let fake: FakeDexGrpc;
let dex: DexApi;
let app: FastifyInstance;
let mailFile: string;
let lines: Record<string, unknown>[];

beforeAll(async () => {
	if (skip) return;
	testDb = await createTestDb();
	mock = await startMockOidcProvider({ redirectUris: [`${PUBLIC_URL}/auth/callback`] });
	dir = mkdtempSync(join(tmpdir(), "password-reset-test-"));
	certs = writeDexGrpcCerts(dir);
	fake = await startFakeDexGrpc(certs);
	dex = createDexApi({
		address: fake.address,
		ca: readFileSync(certs.ca),
		cert: readFileSync(certs.clientCert),
		key: readFileSync(certs.clientKey),
	});
});

afterAll(async () => {
	if (skip) return;
	dex.close();
	await fake.close();
	rmSync(dir, { recursive: true, force: true });
	await testDb.close();
	await mock.close();
});

let mailCount = 0;
beforeEach(async () => {
	if (skip) return;
	await testDb.truncate();
	fake.passwords.clear();
	mailFile = join(dir, `mail-${++mailCount}.jsonl`);
	await switchOn(true);
	const collected = collectingLogger("debug");
	lines = collected.lines;
	const config = testConfig(mock.issuer, { MAIL_CAPTURE_FILE: mailFile });
	app = buildServer({
		db: testDb.db,
		config,
		logger: collected.logger,
		oidc: createOidcClient(toAuthOptions(config)),
		dex,
	});
	await app.ready();
	return async () => {
		await app.close();
	};
});

async function switchOn(on: boolean) {
	await testDb.db.deleteFrom("settings").execute();
	await testDb.db
		.insertInto("settings")
		.values({ id: 1, shutdown_grace_seconds: 600, account_email_enabled: on })
		.execute();
}

/** A Dex local account with a password, as T3 or an administrator would make it. */
async function account(email: string, dexUserId: string = crypto.randomUUID()) {
	await dex.createPassword({
		email,
		username: email.split("@")[0] ?? "x",
		userId: dexUserId,
		hash: await hashDexPassword(OLD),
	});
	const row = await testDb.db
		.insertInto("users")
		.values({
			oidc_issuer: DEX_ACCOUNT_ISSUER,
			oidc_subject: dexLocalSubject(dexUserId),
			email,
			display_name: email,
			role: "student",
			provider_role: "student",
			must_change_password: true,
		})
		.returning("id")
		.executeTakeFirstOrThrow();
	return row.id;
}

function mails(): { to: { address: string }[]; subject: string; text: string }[] {
	try {
		return readFileSync(mailFile, "utf8")
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	} catch {
		return [];
	}
}

function requestReset(login: string, ip = "192.0.2.10") {
	return app.inject({
		method: "POST",
		url: "/auth/password-reset",
		headers: { origin: ORIGIN },
		remoteAddress: ip,
		payload: { login },
	});
}

function completeReset(token: string, password = NEW, ip = "192.0.2.20") {
	return app.inject({
		method: "POST",
		url: "/auth/password-reset/complete",
		headers: { origin: ORIGIN },
		remoteAddress: ip,
		payload: { token, password },
	});
}

async function auditRows(action: string) {
	return testDb.db
		.selectFrom("audit_events")
		.select(["target", "result", "metadata"])
		.where("action", "=", action)
		.orderBy("id")
		.execute();
}

/** The detached send has finished once its audit row is written. */
async function settled(count: number) {
	await vi.waitFor(async () => {
		expect((await auditRows("user.password_reset_requested")).length).toBe(count);
	});
}

function tokenFrom(text: string): string {
	const match = text.match(/\/reset-password#([A-Za-z0-9_-]{43})/);
	if (!match?.[1]) throw new Error("no link in the message");
	return match[1];
}

describe.skipIf(skip)("asking for a reset link", () => {
	test("a known and an unknown login get the same answer; only the account is mailed", async () => {
		await account("alice@example.edu");
		const known = await requestReset("Alice@Example.edu ");
		const unknown = await requestReset("nobody@example.edu");
		expect(known.statusCode).toBe(202);
		expect(unknown.statusCode).toBe(202);
		expect(known.body).toBe(unknown.body);
		expect(Object.keys(known.headers).sort()).toEqual(
			Object.keys(unknown.headers).sort(),
		);
		await settled(1);
		const sent = mails();
		expect(sent).toHaveLength(1);
		expect(sent[0]?.to).toEqual([{ address: "alice@example.edu", name: "" }]);
		expect(sent[0]?.text).toContain(`${PUBLIC_URL}/reset-password#`);
		const token = tokenFrom(sent[0]?.text ?? "");
		// The token is never audited or logged.
		const rows = await auditRows("user.password_reset_requested");
		expect(JSON.stringify(rows)).not.toContain(token);
		expect(rows[0]?.metadata).toMatchObject({ tokenId: expect.any(String) });
		expect(JSON.stringify(lines)).not.toContain(token);
	});

	test("with account email off nothing is sent", async () => {
		await switchOn(false);
		await account("alice@example.edu");
		expect((await requestReset("alice@example.edu")).statusCode).toBe(202);
		await settled(1);
		expect(mails()).toEqual([]);
	});

	test("a request without the site's origin is refused", async () => {
		const res = await app.inject({
			method: "POST",
			url: "/auth/password-reset",
			headers: { origin: "https://evil.example" },
			payload: { login: "alice@example.edu" },
		});
		expect(res.statusCode).toBe(403);
	});

	test("the install administrator is refused silently", async () => {
		const id = await account("admin@example.edu", LOCAL_ADMIN_USER_ID);
		expect((await requestReset("admin@example.edu")).statusCode).toBe(202);
		await settled(1);
		expect(mails()).toEqual([]);
		const rows = await auditRows("user.password_reset_requested");
		expect(rows[0]).toMatchObject({ target: id, result: "denied" });
	});

	test("one address gets five requests an hour, then 429", async () => {
		for (let i = 0; i < 5; i++) {
			expect((await requestReset(`x${i}@example.edu`)).statusCode).toBe(202);
		}
		expect((await requestReset("x5@example.edu")).statusCode).toBe(429);
		// Another address is not held back.
		expect((await requestReset("x6@example.edu", "198.51.100.1")).statusCode).toBe(202);
	});

	test("one account gets three emails an hour, and the fourth request still answers 202", async () => {
		await account("alice@example.edu");
		for (let i = 0; i < 4; i++) {
			const res = await requestReset("alice@example.edu", `198.51.100.${i}`);
			expect(res.statusCode).toBe(202);
		}
		await settled(3);
		// Let the fourth, throttled task finish too.
		await new Promise((r) => setTimeout(r, 200));
		expect(mails()).toHaveLength(3);
	});
});

describe.skipIf(skip)("completing a reset", () => {
	async function linkFor(email: string) {
		const id = await account(email);
		const issued = await issueAccountEmailToken(testDb.db, {
			userId: id,
			purpose: "reset",
			createdBy: null,
		});
		return { id, token: issued.token, tokenId: issued.id };
	}

	test("sets the password, ends every session, clears the flag and starts none", async () => {
		const { id, token, tokenId } = await linkFor("alice@example.edu");
		await createSession(testDb.db, id, 3600, { method: "oidc", courseUserId: null });
		const other = await issueAccountEmailToken(testDb.db, {
			userId: id,
			purpose: "invite",
			createdBy: null,
		});

		const res = await completeReset(token);
		expect(res.statusCode).toBe(204);
		expect(res.headers["set-cookie"]).toBeUndefined();

		const hash = fake.passwords.get("alice@example.edu")?.hash.toString("utf8") ?? "";
		expect(await bcrypt.compare(NEW, hash)).toBe(true);
		const sessions = await testDb.db
			.selectFrom("sessions")
			.select("id")
			.where("user_id", "=", id)
			.execute();
		expect(sessions).toEqual([]);
		const user = await testDb.db
			.selectFrom("users")
			.select("must_change_password")
			.where("id", "=", id)
			.executeTakeFirstOrThrow();
		expect(user.must_change_password).toBe(false);
		// Other links are revoked.
		expect((await completeReset(other.token)).statusCode).toBe(400);

		const rows = await auditRows("user.password_reset_by_email");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.metadata).toMatchObject({ tokenId });
		expect(JSON.stringify(rows)).not.toContain(token);
		await vi.waitFor(() => {
			expect(mails().map((m) => m.subject)).toEqual([
				"Your Portikus password was changed",
			]);
		});
		expect(mails()[0]?.to).toEqual([{ address: "alice@example.edu", name: "" }]);
	});

	test("a link works once", async () => {
		const { token } = await linkFor("alice@example.edu");
		expect((await completeReset(token)).statusCode).toBe(204);
		const again = await completeReset(token, "yet-another-long-password");
		expect(again.statusCode).toBe(400);
		expect(again.json().code).toBe("RESET_LINK_INVALID");
	});

	test("a weak or breached password is refused without using up the link", async () => {
		const { token } = await linkFor("alice@example.edu");
		expect((await completeReset(token, "short")).statusCode).toBe(400);
		expect((await completeReset(token, "PASSWORDPASSWORD")).statusCode).toBe(400);
		expect((await completeReset(token)).statusCode).toBe(204);
	});

	test("twenty wrong links in ten minutes from one address, then 429", async () => {
		const { token } = await linkFor("alice@example.edu");
		for (let i = 0; i < 20; i++) {
			expect((await completeReset("b".repeat(43))).statusCode).toBe(400);
		}
		expect((await completeReset(token)).statusCode).toBe(429);
		expect((await completeReset(token, NEW, "198.51.100.9")).statusCode).toBe(204);
	});
});
