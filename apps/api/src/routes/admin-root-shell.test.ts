import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ELEVATED_SESSION_MAX_SECONDS } from "@portikus/auth";
import {
	CookieJar,
	csrfHeaders,
	loginAs,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import {
	CloseCode,
	MAX_TERMINAL_SOCKETS_PER_USER,
	NOTIFY_FILE_OFF,
} from "@portikus/contracts";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "vitest";
import WebSocket from "ws";
import {
	FAKE_ROOT_PROMPT,
	type FakeRootShell,
	startFakeRootShell,
} from "../testing/fake-root-shell.js";
import { buildTestServer, PUBLIC_URL } from "../testing/test-support.js";
import { terminalSockets } from "../workspaces/terminal-sockets.js";

/**
 * The root-shell routes (ADR 0051; SPEC.md §20.3, §24.11, §24.13): only an
 * administrator opens one, each open and close is audited, the optional
 * alert follows the settings file, and losing the administrator's session
 * ends the shell's whole sign-in session.
 */

const skip = !hasTestDb();
const ORIGIN = new URL(PUBLIC_URL).origin;

let testDb: TestDb;
let mock: MockOidcProvider;
let fake: FakeRootShell;
let app: FastifyInstance;
let carol: CookieJar;
let carolId: string;
let notifyFile: string;

beforeAll(async () => {
	if (skip) return;
	testDb = await createTestDb();
	mock = await startMockOidcProvider({ redirectUris: [`${PUBLIC_URL}/auth/callback`] });
	const dir = mkdtempSync(join(tmpdir(), "portikus-root-shell-route-"));
	fake = await startFakeRootShell(join(dir, "helper.sock"));
	notifyFile = join(dir, "notify.json");
});

afterAll(async () => {
	if (skip) return;
	await fake.close();
	await testDb.close();
	await mock.close();
});

async function start(overrides: Record<string, string> = {}): Promise<void> {
	app = buildTestServer(testDb.db, mock.issuer, {
		ROOT_SHELL_SOCKET: fake.socketPath,
		NOTIFY_FILE: notifyFile,
		...overrides,
	});
	await app.listen({ port: 0, host: "127.0.0.1" });
}

beforeEach(async () => {
	if (skip) return;
	await testDb.truncate();
	fake.connections.length = 0;
	writeFileSync(notifyFile, JSON.stringify(NOTIFY_FILE_OFF));
	await start();
	carol = new CookieJar();
	await loginAs(app, "carol", carol);
	carolId = (
		await testDb.db
			.selectFrom("users")
			.select("id")
			.where("oidc_subject", "=", "carol")
			.executeTakeFirstOrThrow()
	).id;
});

afterEach(async () => {
	if (skip) return;
	vi.useRealTimers();
	await app.close();
});

interface Shell {
	ws: WebSocket;
	output: () => string;
	text: string[];
	closed: Promise<number>;
}

/** Open a root shell, or reject with the HTTP status that refused it. */
function openShell(jar: CookieJar, query = "?cols=100&rows=30"): Promise<Shell> {
	const { port } = app.server.address() as AddressInfo;
	const ws = new WebSocket(`ws://127.0.0.1:${port}/admin/root-shell/ws${query}`, {
		headers: { origin: ORIGIN, cookie: jar.cookieHeader() },
	});
	// A refused upgrade also emits error; the promise below reports it.
	ws.on("error", () => {});
	const binary: Buffer[] = [];
	const text: string[] = [];
	ws.on("message", (data: Buffer, isBinary: boolean) => {
		if (isBinary) binary.push(data);
		else text.push(data.toString());
	});
	const closed = new Promise<number>((resolve) => ws.once("close", resolve));
	return new Promise((resolve, reject) => {
		ws.once("open", () =>
			resolve({ ws, text, closed, output: () => Buffer.concat(binary).toString() }),
		);
		ws.once("unexpected-response", (_request, response) => {
			reject({ status: response.statusCode });
			ws.terminate();
		});
	});
}

async function until(found: () => boolean | Promise<boolean>): Promise<void> {
	for (let i = 0; i < 200 && !(await found()); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	expect(await found()).toBe(true);
}

async function auditRows(action: string) {
	return testDb.db
		.selectFrom("audit_events")
		.select(["actor", "target", "result", "metadata"])
		.where("action", "=", action)
		.execute();
}

test.skipIf(skip)("GET /admin/root-shell says whether root shells are on", async () => {
	const on = await app.inject({
		method: "GET",
		url: "/admin/root-shell",
		cookies: {},
		headers: { cookie: carol.cookieHeader() },
	});
	expect(on.json()).toEqual({ enabled: true });
	await app.close();
	await start({ ROOT_SHELL_SOCKET: "" });
	const off = await app.inject({
		method: "GET",
		url: "/admin/root-shell",
		headers: { cookie: carol.cookieHeader() },
	});
	expect(off.json()).toEqual({ enabled: false });
});

test.skipIf(skip)("a student and an instructor get 403 on both routes", async () => {
	const alice = new CookieJar();
	await loginAs(app, "alice", alice);
	for (const role of ["student", "instructor"] as const) {
		await testDb.db
			.updateTable("users")
			.set({ role })
			.where("oidc_subject", "=", "alice")
			.execute();
		const status = await app.inject({
			method: "GET",
			url: "/admin/root-shell",
			headers: { cookie: alice.cookieHeader() },
		});
		expect(status.statusCode, role).toBe(403);
		await expect(openShell(alice)).rejects.toEqual({ status: 403 });
	}
	expect(fake.connections).toHaveLength(0);
});

test.skipIf(skip)(
	"with root shells off the socket is a 404 and the helper is never asked",
	async () => {
		await app.close();
		await start({ ROOT_SHELL_SOCKET: "" });
		await expect(openShell(carol)).rejects.toEqual({ status: 404 });
		expect(fake.connections).toHaveLength(0);
	},
);

test.skipIf(skip)(
	"an open shell is audited, sends the helper an open frame and echoes input",
	async () => {
		const shell = await openShell(carol);
		await until(() => shell.output().includes(FAKE_ROOT_PROMPT));
		const [opened] = await auditRows("admin.root_shell_opened");
		const shellId = (opened?.metadata as { shellId?: string } | undefined)?.shellId;
		expect(opened).toMatchObject({
			actor: `user:${carolId}`,
			target: shellId,
			result: "ok",
		});
		expect(fake.connections[0]?.open).toEqual({
			shellId,
			actorId: carolId,
			actorName: expect.any(String),
			address: "127.0.0.1",
			cols: 100,
			rows: 30,
		});

		shell.ws.send(JSON.stringify({ type: "input", data: "exit\r" }));
		expect(await shell.closed).toBe(1000);
		expect(shell.text).toContain(JSON.stringify({ type: "exit" }));
		await until(async () => (await auditRows("admin.root_shell_closed")).length === 1);
		const [closed] = await auditRows("admin.root_shell_closed");
		expect(closed).toMatchObject({
			actor: `user:${carolId}`,
			target: shellId,
			metadata: { shellId, reason: "exit", durationSeconds: expect.any(Number) },
		});
	},
);

test.skipIf(skip)(
	"closing the pane is audited as client and only hangs up",
	async () => {
		const shell = await openShell(carol);
		await until(() => shell.output().includes(FAKE_ROOT_PROMPT));
		shell.ws.close(1000);
		await until(async () => (await auditRows("admin.root_shell_closed")).length === 1);
		const [closed] = await auditRows("admin.root_shell_closed");
		expect(closed?.metadata).toMatchObject({ reason: "client" });
		expect(fake.connections[0]?.endReason).toBeNull();
		expect(terminalSockets.open(carolId)).toBe(0);
	},
);

test.skipIf(skip)("stopping the API ends each shell as api_stopped", async () => {
	const shell = await openShell(carol);
	await until(() => shell.output().includes(FAKE_ROOT_PROMPT));
	await app.close();
	expect(await shell.closed).toBe(1001);
	const [closed] = await auditRows("admin.root_shell_closed");
	expect(closed?.metadata).toMatchObject({ reason: "api_stopped" });
	await start();
});

async function notices(): Promise<string[]> {
	const rows = await testDb.db
		.selectFrom("notifications")
		.select(["title", "tone"])
		.execute();
	return rows.map((row) => `${row.tone}: ${row.title}`);
}

test.skipIf(skip)("with the open alert off, no administrator is notified", async () => {
	const shell = await openShell(carol);
	await until(() => shell.output().includes(FAKE_ROOT_PROMPT));
	await new Promise((resolve) => setTimeout(resolve, 100));
	expect(await notices()).toEqual([]);
	shell.ws.close();
});

test.skipIf(skip)(
	"with the open alert on, every administrator gets a warning naming the opener",
	async () => {
		writeFileSync(
			notifyFile,
			JSON.stringify({ ...NOTIFY_FILE_OFF, rootShellOpenedAlert: true }),
		);
		const shell = await openShell(carol);
		await until(async () => (await notices()).length > 0);
		const name = (
			await testDb.db
				.selectFrom("users")
				.select("display_name")
				.where("id", "=", carolId)
				.executeTakeFirstOrThrow()
		).display_name;
		expect(await notices()).toEqual([`warning: Root shell opened by ${name}`]);
		shell.ws.close();
	},
);

test.skipIf(skip)(
	"root shells count toward the per-user terminal socket cap",
	async () => {
		for (let i = 0; i < MAX_TERMINAL_SOCKETS_PER_USER; i += 1)
			terminalSockets.take(carolId);
		try {
			const shell = await openShell(carol);
			expect(await shell.closed).toBe(CloseCode.TOO_MANY_SOCKETS);
			expect(fake.connections).toHaveLength(0);
			expect(await auditRows("admin.root_shell_opened")).toEqual([]);
		} finally {
			for (let i = 0; i < MAX_TERMINAL_SOCKETS_PER_USER; i += 1)
				terminalSockets.release(carolId);
		}
	},
);

const revocations: Array<[string, () => Promise<unknown>]> = [
	["sign-out", () => testDb.db.deleteFrom("sessions").execute()],
	[
		"demotion",
		() =>
			testDb.db
				.updateTable("users")
				.set({ role: "student", granted_role: null })
				.where("id", "=", carolId)
				.execute(),
	],
	[
		"a disabled account",
		() =>
			testDb.db
				.updateTable("users")
				.set({ disabled_at: new Date().toISOString() })
				.where("id", "=", carolId)
				.execute(),
	],
	[
		"the 12-hour limit on a provider-given role",
		async () => {
			await testDb.db
				.updateTable("users")
				.set({ provider_role: "administrator", granted_role: null })
				.where("id", "=", carolId)
				.execute();
			await testDb.db
				.updateTable("sessions")
				.set({
					created_at: new Date(
						Date.now() - ELEVATED_SESSION_MAX_SECONDS * 1000,
					).toISOString(),
				} as never)
				.execute();
		},
	],
];

for (const [why, revoke] of revocations) {
	test.skipIf(skip)(
		`${why} ends the shell's sign-in session and closes with 4401`,
		async () => {
			vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ["setInterval"] });
			const shell = await openShell(carol);
			await until(() => shell.output().includes(FAKE_ROOT_PROMPT));
			await revoke();
			vi.advanceTimersByTime(1500);
			expect(await shell.closed).toBe(CloseCode.SESSION_ENDED);
			await until(() => fake.connections[0]?.closed === true);
			expect(fake.connections[0]?.endReason).toBe("session_ended");
			await until(
				async () => (await auditRows("admin.root_shell_closed")).length === 1,
			);
			const [closed] = await auditRows("admin.root_shell_closed");
			expect(closed?.metadata).toMatchObject({ reason: "session_ended" });
		},
	);
}

test.skipIf(skip)(
	"a shell whose helper is down is refused, and still audited as closed",
	async () => {
		await app.close();
		await start({ ROOT_SHELL_SOCKET: "/nonexistent/root-shell.sock" });
		const shell = await openShell(carol);
		expect(await shell.closed).toBe(CloseCode.SERVER_ERROR);
		await until(async () => (await auditRows("admin.root_shell_closed")).length === 1);
		expect(terminalSockets.open(carolId)).toBe(0);
	},
);

test.skipIf(skip)(
	"a POST with the CSRF header still cannot reach the socket path",
	async () => {
		const response = await app.inject({
			method: "POST",
			url: "/admin/root-shell/ws",
			headers: csrfHeaders(carol, PUBLIC_URL),
		});
		expect(response.statusCode).toBe(404);
	},
);
