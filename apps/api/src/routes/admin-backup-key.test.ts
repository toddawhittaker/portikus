/**
 * The backup key on an apt-installed server (ADR 0044; SPEC.md section
 * 24.9; STACK.md section 15). Only an administrator may read, download or
 * upload it; each download and upload is audited; the download is never
 * cached; the key never reaches a log line or an audit row; an upload must
 * be a real key, and replacing a different key needs explicit consent.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	CookieJar,
	csrfHeaders,
	loginAs,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import { BACKUP_KEY_MAX_BYTES } from "@portikus/contracts";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import { collectingLogger } from "@portikus/observability/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import {
	type FakeBackupKey,
	fakeKey,
	startFakeBackupKey,
} from "../testing/fake-backup-key.js";
import { buildTestServer, PUBLIC_URL } from "../testing/test-support.js";
import { askKeyHelper } from "./admin-backup-key.js";

const skip = !hasTestDb();

const SERVER_KEY = fakeKey("made by setup");
const OFFSITE_KEY = fakeKey("kept off site");

let testDb: TestDb;
let mock: MockOidcProvider;
let dir: string;
let helper: FakeBackupKey;
let app: FastifyInstance;
let lines: Record<string, unknown>[];
let alice: CookieJar;
let carol: CookieJar;

function send(
	jar: CookieJar | null,
	method: "GET" | "POST",
	url: string,
	payload?: Record<string, unknown>,
) {
	return app.inject({
		method,
		url,
		headers: jar
			? csrfHeaders(jar, PUBLIC_URL)
			: { origin: new URL(PUBLIC_URL).origin },
		...(payload === undefined ? {} : { payload }),
	});
}

async function audits(action: string) {
	return testDb.db
		.selectFrom("audit_events")
		.selectAll()
		.where("action", "=", action)
		.orderBy("id")
		.execute();
}

/** The key's secret line must appear nowhere but in the download itself. */
async function expectNoSecretOutsideTheDownload(identity: string) {
	expect(JSON.stringify(lines)).not.toContain(identity);
	const rows = await testDb.db.selectFrom("audit_events").selectAll().execute();
	expect(JSON.stringify(rows)).not.toContain(identity);
}

beforeAll(async () => {
	if (skip) return;
	testDb = await createTestDb();
	mock = await startMockOidcProvider({ redirectUris: [`${PUBLIC_URL}/auth/callback`] });
	dir = mkdtempSync(join(tmpdir(), "backup-key-test-"));
	helper = await startFakeBackupKey(join(dir, "helper.sock"), {
		identity: null,
		handedOut: null,
	});
});

afterAll(async () => {
	if (skip) return;
	await helper.close();
	rmSync(dir, { recursive: true, force: true });
	await testDb.close();
	await mock.close();
});

beforeEach(async () => {
	if (skip) return;
	await testDb.truncate();
	helper.setState({ identity: SERVER_KEY.identity, handedOut: null });
	helper.verbs.length = 0;
	const collected = collectingLogger("debug");
	lines = collected.lines;
	app = buildTestServer(
		testDb.db,
		mock.issuer,
		{ BACKUP_KEY_SOCKET: helper.socketPath },
		collected.logger,
	);
	await app.ready();
	alice = new CookieJar();
	carol = new CookieJar();
	await loginAs(app, "alice", alice);
	await loginAs(app, "carol", carol);
	return async () => {
		await app.close();
	};
});

describe.skipIf(skip)("who may use the key routes", () => {
	test("every route answers 404 on a site whose backups a separate host takes", async () => {
		const off = buildTestServer(testDb.db, mock.issuer);
		await off.ready();
		try {
			const jar = new CookieJar();
			await loginAs(off, "carol", jar);
			for (const [method, url] of [
				["GET", "/admin/backups/key"],
				["POST", "/admin/backups/key/download"],
				["POST", "/admin/backups/key"],
			] as const) {
				const res = await off.inject({
					method,
					url,
					headers: csrfHeaders(jar, PUBLIC_URL),
					...(method === "POST" && url.endsWith("/key")
						? { payload: { key: OFFSITE_KEY.file, replace: true } }
						: {}),
				});
				expect(res.statusCode, `${method} ${url}`).toBe(404);
			}
		} finally {
			await off.close();
		}
		expect(helper.verbs).toEqual([]);
	});

	test("a student and an anonymous caller are refused before the helper is asked", async () => {
		for (const [method, url] of [
			["GET", "/admin/backups/key"],
			["POST", "/admin/backups/key/download"],
			["POST", "/admin/backups/key"],
		] as const) {
			const payload =
				url.endsWith("/key") && method === "POST"
					? { key: OFFSITE_KEY.file, replace: true }
					: undefined;
			expect((await send(alice, method, url, payload)).statusCode).toBe(403);
			expect((await send(null, method, url, payload)).statusCode).toBe(401);
		}
		expect(helper.verbs).toEqual([]);
		expect(helper.state().identity).toBe(SERVER_KEY.identity);
	});

	test("a download or upload without the site's Origin is refused", async () => {
		const noOrigin = { cookie: carol.cookieHeader() };
		const download = await app.inject({
			method: "POST",
			url: "/admin/backups/key/download",
			headers: noOrigin,
		});
		expect(download.statusCode).toBe(403);
		const upload = await app.inject({
			method: "POST",
			url: "/admin/backups/key",
			headers: { ...noOrigin, origin: "https://evil.example" },
			payload: { key: OFFSITE_KEY.file, replace: true },
		});
		expect(upload.statusCode).toBe(403);
		expect(helper.verbs).toEqual([]);
	});
});

describe.skipIf(skip)("status and download", () => {
	test("a key setup made is installed and not yet downloaded", async () => {
		const res = await send(carol, "GET", "/admin/backups/key");
		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({
			installed: true,
			recipient: SERVER_KEY.recipient,
			downloaded: false,
			downloadedAt: null,
		});
	});

	test("the download is the key file, never cached, audited, and the reminder ends", async () => {
		const res = await send(carol, "POST", "/admin/backups/key/download");
		expect(res.statusCode).toBe(200);
		expect(res.headers["cache-control"]).toBe("no-store");
		expect(res.headers["content-disposition"]).toBe(
			'attachment; filename="portikus-backup-key.txt"',
		);
		expect(res.headers["content-type"]).toMatch(/^text\/plain/);
		expect(res.body).toBe(SERVER_KEY.file);

		const rows = await audits("backup.key_downloaded");
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ target: "backup-key", result: "ok" });
		expect(rows[0]?.actor).toMatch(/^user:/);
		expect(rows[0]?.metadata).toEqual({ recipient: SERVER_KEY.recipient });

		const status = (await send(carol, "GET", "/admin/backups/key")).json();
		expect(status.downloaded).toBe(true);
		expect(Date.parse(status.downloadedAt)).toBeGreaterThan(Date.now() - 60_000);
		await expectNoSecretOutsideTheDownload(SERVER_KEY.identity);
	});

	test("the download is marked only after the reply has gone, and only for the key sent", async () => {
		const res = await send(carol, "POST", "/admin/backups/key/download");
		expect(res.statusCode).toBe(200);
		// The status read waits for the record, so it sees the download.
		expect((await send(carol, "GET", "/admin/backups/key")).json().downloaded).toBe(
			true,
		);
		expect(helper.verbs).toEqual([
			"export",
			`mark-downloaded ${SERVER_KEY.recipient}`,
			"status",
		]);
	});

	test("export alone never marks the key downloaded", async () => {
		await askKeyHelper(helper.socketPath, "export");
		expect(helper.state().handedOut).toBeNull();
		expect((await send(carol, "GET", "/admin/backups/key")).json().downloaded).toBe(
			false,
		);
	});

	test("each download is audited", async () => {
		await send(carol, "POST", "/admin/backups/key/download");
		await send(carol, "POST", "/admin/backups/key/download");
		expect(await audits("backup.key_downloaded")).toHaveLength(2);
	});

	test("a server with no key answers 404 and audits nothing", async () => {
		helper.setState({ identity: null, handedOut: null });
		const res = await send(carol, "POST", "/admin/backups/key/download");
		expect(res.statusCode).toBe(404);
		expect(await audits("backup.key_downloaded")).toEqual([]);
		expect((await send(carol, "GET", "/admin/backups/key")).json()).toMatchObject({
			installed: false,
			recipient: null,
			downloaded: false,
		});
	});

	test("an unreachable helper is a 503, and nothing is audited", async () => {
		const gone = buildTestServer(testDb.db, mock.issuer, {
			BACKUP_KEY_SOCKET: join(dir, "nobody-listens.sock"),
		});
		await gone.ready();
		try {
			const jar = new CookieJar();
			await loginAs(gone, "carol", jar);
			for (const [method, url] of [
				["GET", "/admin/backups/key"],
				["POST", "/admin/backups/key/download"],
			] as const) {
				const res = await gone.inject({
					method,
					url,
					headers: csrfHeaders(jar, PUBLIC_URL),
				});
				expect(res.statusCode).toBe(503);
				expect(res.json().code).toBe("BACKUP_KEY_UNAVAILABLE");
			}
		} finally {
			await gone.close();
		}
		expect(await audits("backup.key_downloaded")).toEqual([]);
	});
});

describe.skipIf(skip)("upload", () => {
	test("the same key is accepted as unchanged, and an upload is not a download", async () => {
		const res = await send(carol, "POST", "/admin/backups/key", {
			key: SERVER_KEY.file,
			replace: false,
		});
		expect(res.statusCode).toBe(200);
		expect(res.json()).toMatchObject({
			outcome: "unchanged",
			replacedRecipient: null,
			key: { installed: true, recipient: SERVER_KEY.recipient, downloaded: false },
		});
		expect(helper.verbs).not.toContainEqual(expect.stringMatching(/^mark-downloaded/));
		const rows = await audits("backup.key_uploaded");
		expect(rows.map((r) => [r.result, r.metadata])).toEqual([
			[
				"ok",
				{
					recipient: SERVER_KEY.recipient,
					outcome: "unchanged",
					replacedRecipient: null,
				},
			],
		]);
		await expectNoSecretOutsideTheDownload(SERVER_KEY.identity);
	});

	test("a different key is refused without consent, and the old key stays", async () => {
		const res = await send(carol, "POST", "/admin/backups/key", {
			key: OFFSITE_KEY.file,
			replace: false,
		});
		expect(res.statusCode).toBe(409);
		expect(res.json().code).toBe("BACKUP_KEY_EXISTS");
		expect(helper.state().identity).toBe(SERVER_KEY.identity);
		const rows = await audits("backup.key_uploaded");
		expect(rows.map((r) => [r.result, r.metadata])).toEqual([
			["refused", { reason: "exists" }],
		]);
	});

	test("with consent a different key replaces it, and both are audited by their public halves", async () => {
		const res = await send(carol, "POST", "/admin/backups/key", {
			key: OFFSITE_KEY.file,
			replace: true,
		});
		expect(res.statusCode).toBe(200);
		expect(res.json()).toEqual({
			outcome: "installed",
			replacedRecipient: SERVER_KEY.recipient,
			// The reminder stays: nothing shows the uploader kept a copy.
			key: {
				installed: true,
				recipient: OFFSITE_KEY.recipient,
				downloaded: false,
				downloadedAt: null,
			},
		});
		expect(helper.state().identity).toBe(OFFSITE_KEY.identity);
		expect(helper.verbs).toContain("import-replace");
		const rows = await audits("backup.key_uploaded");
		expect(rows.map((r) => [r.result, r.metadata])).toEqual([
			[
				"ok",
				{
					recipient: OFFSITE_KEY.recipient,
					outcome: "installed",
					replacedRecipient: SERVER_KEY.recipient,
				},
			],
		]);
		await expectNoSecretOutsideTheDownload(OFFSITE_KEY.identity);
		await expectNoSecretOutsideTheDownload(SERVER_KEY.identity);
	});

	test("onto a server with no key, an upload installs it without consent", async () => {
		helper.setState({ identity: null, handedOut: null });
		const res = await send(carol, "POST", "/admin/backups/key", {
			key: OFFSITE_KEY.file,
			replace: false,
		});
		expect(res.statusCode).toBe(200);
		expect(res.json()).toMatchObject({ outcome: "installed", replacedRecipient: null });
	});

	test.each([
		["text that is not a key", "hello"],
		["a public key", `${SERVER_KEY.recipient}\n`],
		["two keys", `${SERVER_KEY.identity}\n${OFFSITE_KEY.identity}\n`],
		["a key with other text", `${OFFSITE_KEY.identity}\nsomething else\n`],
		["a key in lower case", `${OFFSITE_KEY.identity.toLowerCase()}\n`],
	])("%s is refused, audited, and changes nothing", async (_name, key) => {
		const res = await send(carol, "POST", "/admin/backups/key", { key, replace: true });
		expect(res.statusCode).toBe(400);
		expect(res.json().code).toBe("BACKUP_KEY_INVALID");
		expect(helper.state().identity).toBe(SERVER_KEY.identity);
		const rows = await audits("backup.key_uploaded");
		expect(rows.map((r) => [r.result, r.metadata])).toEqual([
			["refused", { reason: "invalid" }],
		]);
		expect(JSON.stringify(lines)).not.toContain(OFFSITE_KEY.identity);
	});

	test.each([
		[
			"a file larger than a key",
			{
				key: `${"#".repeat(BACKUP_KEY_MAX_BYTES)}\n${OFFSITE_KEY.identity}`,
				replace: true,
			},
		],
		["an empty file", { key: "", replace: true }],
		["no consent field", { key: OFFSITE_KEY.file }],
		["an extra field", { key: OFFSITE_KEY.file, replace: true, path: "/etc/shadow" }],
	])("%s is refused before the helper is asked", async (_name, payload) => {
		const res = await send(carol, "POST", "/admin/backups/key", payload);
		expect(res.statusCode).toBe(400);
		expect(res.json().code).toBe("BACKUP_KEY_INVALID");
		expect(helper.verbs).toEqual([]);
		expect(helper.state().identity).toBe(SERVER_KEY.identity);
		expect(await audits("backup.key_uploaded")).toHaveLength(1);
		expect(JSON.stringify(lines)).not.toContain(OFFSITE_KEY.identity);
	});
});

describe.skipIf(skip)("the helper client", () => {
	test("an answer larger than any key is refused", async () => {
		const flood = await startFakeBackupKey(join(dir, "flood.sock"), {
			identity: `${SERVER_KEY.identity}\n${"#".repeat(20_000)}`,
			handedOut: null,
		});
		try {
			await expect(askKeyHelper(flood.socketPath, "export")).rejects.toThrow(
				/answered too much/,
			);
		} finally {
			await flood.close();
		}
	});
});
