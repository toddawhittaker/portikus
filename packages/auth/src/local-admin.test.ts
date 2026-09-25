import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import bcrypt from "bcryptjs";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { createDexApi, type DexApi } from "./dex-api.js";
import { dexLocalSubject } from "./dex-subject.js";
import { LOCAL_ADMIN_USER_ID, runResetAdmin } from "./local-admin.js";
import { createSession, hashSessionToken } from "./sessions.js";
import {
	type DexGrpcCerts,
	type FakeDexGrpc,
	startFakeDexGrpc,
	writeDexGrpcCerts,
} from "./testing/fake-dex-grpc.js";

/**
 * The local administrator and `reset-admin` (docs/EPIC-14-2.md rulings 10
 * to 20) against a database and the fake Dex gRPC server.
 */

const ISSUER = "https://portikus.example.edu/dex";
const PUBLIC_URL = "https://portikus.example.edu";
const DEFAULT_EMAIL = "admin@portikus.example.edu";
const ENV = { OIDC_ISSUER_URL: ISSUER, PUBLIC_URL };

if (!hasTestDb()) {
	console.log("TEST_DATABASE_URL is not set — skipping local-admin database tests.");
}

let t: TestDb;
let dir: string;
let certs: DexGrpcCerts;
let fake: FakeDexGrpc;
let dex: DexApi;

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "local-admin-test-"));
	certs = writeDexGrpcCerts(dir);
	fake = await startFakeDexGrpc(certs);
	dex = createDexApi({
		address: fake.address,
		ca: readFileSync(certs.ca),
		cert: readFileSync(certs.clientCert),
		key: readFileSync(certs.clientKey),
	});
	if (hasTestDb()) t = await createTestDb();
});

afterAll(async () => {
	dex.close();
	await fake.close();
	rmSync(dir, { recursive: true, force: true });
	if (hasTestDb()) await t.close();
});

beforeEach(async () => {
	fake.passwords.clear();
	if (hasTestDb()) await t.truncate();
});

/** Run the command as `reset-admin-main` does, capturing both streams. */
async function run(...args: string[]) {
	const out: string[] = [];
	const err: string[] = [];
	// Anything written straight to the process, which must never hold a password.
	const direct: string[] = [];
	const spies = [
		vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
			direct.push(String(chunk));
			return true;
		}),
		vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
			direct.push(String(chunk));
			return true;
		}),
		vi.spyOn(console, "log").mockImplementation((...parts) => {
			direct.push(parts.join(" "));
		}),
		vi.spyOn(console, "error").mockImplementation((...parts) => {
			direct.push(parts.join(" "));
		}),
	];
	let code: number;
	try {
		code = await runResetAdmin(
			args,
			{ db: t.db, dex, env: ENV },
			{ stdout: (text) => out.push(text), stderr: (text) => err.push(text) },
		);
	} finally {
		for (const spy of spies) spy.mockRestore();
	}
	return { code, stdout: out.join(""), stderr: err.join(""), direct: direct.join("") };
}

async function account() {
	return t.db
		.selectFrom("users")
		.selectAll()
		.where("oidc_issuer", "=", ISSUER)
		.where("oidc_subject", "=", dexLocalSubject(LOCAL_ADMIN_USER_ID))
		.executeTakeFirstOrThrow();
}

function storedHash(email: string): string {
	return fake.passwords.get(email)?.hash.toString("utf8") ?? "";
}

async function auditRows() {
	return t.db
		.selectFrom("audit_events")
		.select(["actor", "target", "action", "result", "metadata"])
		.orderBy("id")
		.execute();
}

/** A main session and a preview session for the account. */
async function openSessions(userId: string): Promise<void> {
	const session = await createSession(t.db, userId, 3600, {
		method: "oidc",
		courseUserId: null,
	});
	const workspaceId = crypto.randomUUID();
	await t.db
		.insertInto("workspaces")
		.values({
			id: workspaceId,
			owner_user_id: userId,
			incus_instance_name: `ws-${workspaceId.slice(0, 8)}`,
			label: `adm-${workspaceId.slice(0, 8)}`,
			state: "stopped",
			desired_state: "stopped",
		})
		.execute();
	await t.db
		.insertInto("preview_sessions")
		.values({
			token_hash: `hash-${workspaceId}`,
			user_id: userId,
			session_id: hashSessionToken(session.token),
			workspace_id: workspaceId,
			port: 3000,
			preview_host: "x.preview.localhost",
		})
		.execute();
}

describe.skipIf(!hasTestDb())("reset-admin", () => {
	test("creates the local administrator; stdout is exactly the password", async () => {
		const { code, stdout, stderr, direct } = await run("--if-missing");
		expect(code).toBe(0);
		expect(stdout).toMatch(/^[A-Za-z0-9]{20}\n$/);
		const password = stdout.trim();
		expect(stderr).not.toContain(password);
		expect(stderr).toContain(DEFAULT_EMAIL);
		expect(direct).not.toContain(password);

		const stored = fake.passwords.get(DEFAULT_EMAIL);
		expect(stored?.user_id).toBe(LOCAL_ADMIN_USER_ID);
		expect(storedHash(DEFAULT_EMAIL)).toMatch(/^\$2[aby]\$10\$/);
		expect(await bcrypt.compare(password, storedHash(DEFAULT_EMAIL))).toBe(true);

		expect(await account()).toMatchObject({
			email: DEFAULT_EMAIL,
			role: "administrator",
			granted_role: "administrator",
			must_change_password: true,
			disabled_at: null,
		});
		const audit = await auditRows();
		expect(audit).toEqual([
			{
				actor: "host:root",
				target: (await account()).id,
				action: "local_admin.created",
				result: "ok",
				metadata: {},
			},
		]);
		expect(JSON.stringify(audit)).not.toContain(DEFAULT_EMAIL);
	});

	test("--email names the new password's email", async () => {
		const { code } = await run("--email", "Root@Example.edu");
		expect(code).toBe(0);
		expect(fake.passwords.get("root@example.edu")?.user_id).toBe(LOCAL_ADMIN_USER_ID);
		expect((await account()).email).toBe("root@example.edu");
	});

	test("--if-missing changes nothing once the account exists: 10 flagged, 11 clear", async () => {
		const first = await run("--if-missing");
		const hash = storedHash(DEFAULT_EMAIL);
		const before = await account();

		const again = await run("--if-missing", "--email", "other@example.edu");
		expect(again.code).toBe(10);
		expect(again.stdout).toBe("");
		expect(storedHash(DEFAULT_EMAIL)).toBe(hash);
		expect(await account()).toEqual(before);
		expect(await auditRows()).toHaveLength(1);
		expect(await bcrypt.compare(first.stdout.trim(), storedHash(DEFAULT_EMAIL))).toBe(
			true,
		);

		await t.db
			.updateTable("users")
			.set({ must_change_password: false })
			.where("id", "=", before.id)
			.execute();
		const cleared = await run("--if-missing");
		expect(cleared.code).toBe(11);
		expect(cleared.stdout).toBe("");
	});

	test("--if-missing leaves a removed (disabled) account alone", async () => {
		await run();
		const { id } = await account();
		await t.db
			.updateTable("users")
			.set({ disabled_at: new Date().toISOString(), must_change_password: false })
			.where("id", "=", id)
			.execute();
		expect((await run("--if-missing")).code).toBe(11);
		expect((await account()).disabled_at).not.toBeNull();
	});

	test("a reset restores the grant, re-enables, sets the flag and ends every session", async () => {
		const first = await run();
		const { id } = await account();
		await t.db
			.updateTable("users")
			.set({
				disabled_at: new Date().toISOString(),
				granted_role: null,
				role: "student",
				must_change_password: false,
			})
			.where("id", "=", id)
			.execute();
		await openSessions(id);

		const reset = await run();
		expect(reset.code).toBe(0);
		const password = reset.stdout.trim();
		expect(password).not.toBe(first.stdout.trim());
		expect(reset.stderr).not.toContain(password);
		expect(await bcrypt.compare(password, storedHash(DEFAULT_EMAIL))).toBe(true);
		expect(await bcrypt.compare(first.stdout.trim(), storedHash(DEFAULT_EMAIL))).toBe(
			false,
		);

		expect(await account()).toMatchObject({
			id,
			role: "administrator",
			granted_role: "administrator",
			must_change_password: true,
			disabled_at: null,
		});
		const sessions = await t.db
			.selectFrom("sessions")
			.select("id")
			.where("user_id", "=", id)
			.execute();
		expect(sessions).toEqual([]);
		const previews = await t.db
			.selectFrom("preview_sessions")
			.select("id")
			.where("user_id", "=", id)
			.where("revoked_at", "is", null)
			.execute();
		expect(previews).toEqual([]);
		expect((await auditRows()).map((r) => [r.action, r.actor])).toEqual([
			["local_admin.created", "host:root"],
			["local_admin.reset", "host:root"],
		]);
	});

	test("recreates a deleted Dex password under the same subject and account", async () => {
		await run("--email", "keep@example.edu");
		const before = await account();
		fake.passwords.clear();

		const again = await run();
		expect(again.code).toBe(0);
		// The account's stored email, since --email was not given this time.
		expect(fake.passwords.get("keep@example.edu")?.user_id).toBe(LOCAL_ADMIN_USER_ID);
		const after = await account();
		expect(after.id).toBe(before.id);
		expect(after.oidc_subject).toBe(dexLocalSubject(LOCAL_ADMIN_USER_ID));
	});

	test("refuses an email another Dex password holds, and makes no account", async () => {
		await dex.createPassword({
			email: DEFAULT_EMAIL,
			username: "someone",
			userId: crypto.randomUUID(),
			hash: "$2b$10$x",
		});
		const { code, stdout, stderr } = await run();
		expect(code).toBe(1);
		expect(stdout).toBe("");
		expect(stderr).toContain("portikus_admin_email");
		const rows = await t.db.selectFrom("users").select("id").execute();
		expect(rows).toEqual([]);
		expect(await auditRows()).toEqual([]);
	});

	test("Dex being down fails with the status only, and changes nothing", async () => {
		fake.failing = true;
		try {
			const { code, stdout, stderr } = await run();
			expect(code).toBe(1);
			expect(stdout).toBe("");
			expect(stderr).toMatch(/gRPC status \d+/);
		} finally {
			fake.failing = false;
		}
		expect(await t.db.selectFrom("users").select("id").execute()).toEqual([]);
	});

	test("refuses bad arguments with status 2", async () => {
		expect((await run("--bogus")).code).toBe(2);
		expect((await run("--email")).code).toBe(2);
		expect((await run("--email", "not-an-address")).code).toBe(2);
		const missing = await runResetAdmin(
			[],
			{ db: t.db, dex, env: {} },
			{ stdout: () => {}, stderr: () => {} },
		);
		expect(missing).toBe(2);
	});
});
