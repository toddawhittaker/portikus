import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	CookieJar,
	csrfHeaders,
	loginAs,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type FakeAgent, startFakeAgent } from "../testing/fake-agent/index.js";
import {
	buildMatrixWorld,
	buildTestServer,
	MATRIX_MOCK_USERS,
	type MatrixWorld,
	PUBLIC_URL,
	testConfig,
} from "../testing/test-support.js";

/**
 * Every audit event SPEC.md section 24.11 lists writes an audit row, with
 * the right actor, target and result, and no secret in its metadata.
 */

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));

/** Section 24.11 names these only to say they are no longer written. */
const RETIRED = new Set(["setup.code_issued", "setup.code_claimed"]);

/** Every `area.event` name written in backticks in SPEC.md section 24.11. */
function specActionNames(): string[] {
	const spec = readFileSync(join(REPO, "docs/SPEC.md"), "utf8");
	const start = spec.indexOf("### 24.11 Audit logging");
	const end = spec.indexOf("\n### ", start + 1);
	const section = spec.slice(start, end);
	const names = [...section.matchAll(/`([a-z_]+\.[a-z_]+)`/g)].map((m) => m[1] ?? "");
	return [...new Set(names)].filter((name) => !RETIRED.has(name)).sort();
}

function sourceFiles(dir: string, out: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		if (entry === "node_modules" || entry === "dist") continue;
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) sourceFiles(path, out);
		else if (path.endsWith(".ts") && !path.endsWith(".test.ts")) out.push(path);
	}
	return out;
}

/** All non-test TypeScript under the apps and packages, as one string. */
function productSource(): string {
	const roots = ["apps", "packages"].flatMap((top) =>
		readdirSync(join(REPO, top)).map((name) => join(REPO, top, name, "src")),
	);
	return roots
		.filter((root) => {
			try {
				return statSync(root).isDirectory();
			} catch {
				return false;
			}
		})
		.flatMap((root) => sourceFiles(root))
		.map((file) => readFileSync(file, "utf8"))
		.join("\n");
}

describe("SPEC.md section 24.11 action names", () => {
	const names = specActionNames();

	it("the section lists action names in a form this test can read", () => {
		// A rewrite that drops the backticked names would empty this check.
		expect(names.length).toBeGreaterThan(50);
		expect(names).toContain("preview.denied");
		expect(names).toContain("user.role_changed");
	});

	it("every listed action is written by product code", () => {
		const source = productSource();
		const missing = names.filter((name) => !source.includes(`"${name}"`));
		expect(missing).toEqual([]);
	});
});

const skip = !hasTestDb();
if (skip && process.env.CI) {
	throw new Error("the audit coverage test must run in CI: set TEST_DATABASE_URL");
}

const AGENT_TOKEN = "audit-coverage-agent-token";
const PREVIEW_SUFFIX = "preview.localhost";
const PREVIEW_COOKIE = "portikus-preview";
/** A value no response or audit row may ever repeat. */
const PROBE = "probe-secret-7f3a9c";

let testDb: TestDb;
let mock: MockOidcProvider;
let agent: FakeAgent;
let app: FastifyInstance;
let world: MatrixWorld;
let carolId: string;

beforeAll(async () => {
	if (skip) return;
	testDb = await createTestDb();
	mock = await startMockOidcProvider({ users: MATRIX_MOCK_USERS });
	agent = await startFakeAgent(AGENT_TOKEN);
	app = buildTestServer(testDb.db, mock.issuer, { AGENT_PORT: agent.port });
	world = await buildMatrixWorld(app, testDb.db, AGENT_TOKEN);
	carolId = (
		await testDb.db
			.selectFrom("users")
			.select("id")
			.where("oidc_subject", "=", "carol")
			.executeTakeFirstOrThrow()
	).id;
});

afterAll(async () => {
	if (skip) return;
	await app.close();
	await testDb.close();
	await mock.close();
	await agent.close();
});

interface Row {
	actor: string;
	target: string;
	action: string;
	result: string;
	metadata: unknown;
}

async function lastId(): Promise<number> {
	const row = await testDb.db
		.selectFrom("audit_events")
		.select((eb) => eb.fn.max("id").as("max"))
		.executeTakeFirst();
	return Number(row?.max ?? 0);
}

/** Rows written after `since`. */
async function rowsSince(since: number): Promise<Row[]> {
	return (await testDb.db
		.selectFrom("audit_events")
		.select(["actor", "target", "action", "result", "metadata"])
		.where("id", ">", since)
		.orderBy("id")
		.execute()) as Row[];
}

/** Secrets the world holds; none may appear in an audit row (SPEC.md §24.11). */
function knownSecrets(): string[] {
	const config = testConfig(mock.issuer);
	const jars = [world.a.jar, world.b.jar, world.admin];
	const cookies = jars.flatMap((jar) =>
		jar
			.cookieHeader()
			.split(";")
			.map((pair) => pair.split("=").slice(1).join("="))
			.filter((value) => value.length > 8),
	);
	return [
		world.a.agentToken,
		world.b.agentToken,
		config.SESSION_COOKIE_SECRET,
		config.OIDC_CLIENT_SECRET,
		PROBE,
		...cookies,
	];
}

const SECRET_KEY =
	/pass(word)?|token|secret|ticket|cookie|otp|recovery_?codes?|^code$/i;

/** Fail when a metadata key names a secret or a value holds a known one. */
function expectNoSecrets(rows: Row[]): void {
	const secrets = knownSecrets();
	for (const row of rows) {
		const visit = (value: unknown, path: string) => {
			if (value && typeof value === "object") {
				for (const [key, inner] of Object.entries(value)) {
					expect(SECRET_KEY.test(key), `${row.action} metadata key ${path}${key}`).toBe(
						false,
					);
					visit(inner, `${path}${key}.`);
				}
				return;
			}
			if (typeof value === "string") {
				for (const secret of secrets) {
					expect(value, `${row.action} metadata ${path}`).not.toContain(secret);
				}
			}
		};
		visit(row.metadata, "");
	}
}

/**
 * Run `act`, then expect exactly one new row with `action`, matching
 * `expected`, and no secret in any new row.
 */
async function expectAudit(
	act: () => Promise<LightMyRequestResponse | undefined>,
	action: string,
	expected: Partial<Row>,
	status?: number,
): Promise<Row> {
	const since = await lastId();
	const response = await act();
	if (response && status !== undefined) {
		expect(response.statusCode, response.body).toBe(status);
	}
	const rows = await rowsSince(since);
	const matching = rows.filter((row) => row.action === action);
	expect(
		matching,
		`rows written: ${rows.map((r) => r.action).join(", ")}`,
	).toHaveLength(1);
	const row = matching[0] as Row;
	expect(row).toMatchObject(expected);
	expectNoSecrets(rows);
	return row;
}

function post(jar: CookieJar, url: string, payload?: Record<string, unknown>) {
	return app.inject({
		method: "POST",
		url,
		headers: csrfHeaders(jar, PUBLIC_URL),
		...(payload === undefined ? {} : { payload }),
	});
}

function put(jar: CookieJar, url: string, payload: Record<string, unknown>) {
	return app.inject({
		method: "PUT",
		url,
		headers: csrfHeaders(jar, PUBLIC_URL),
		payload,
	});
}

/** Let the next maintenance request through; the worker would clear this. */
async function clearPending(workspaceId: string): Promise<void> {
	await testDb.db
		.updateTable("workspaces")
		.set({ pending_operation: null, pending_operation_args: null })
		.where("id", "=", workspaceId)
		.execute();
}

describe.skipIf(skip)("authentication success and failure", () => {
	it("a sign-in writes auth.login ok", async () => {
		await expectAudit(
			() => loginAs(app, "alice", new CookieJar()).then(() => undefined),
			"auth.login",
			{
				actor: `user:${world.a.userId}`,
				target: world.a.userId,
				result: "ok",
			},
		);
	});

	it("a person the identity provider gives no role writes auth.login denied", async () => {
		await expectAudit(
			() => loginAs(app, "dave", new CookieJar()).then(() => undefined),
			"auth.login",
			{ actor: "subject:dave", target: "dave", result: "denied" },
		);
	});

	it("a disabled account's sign-in writes auth.login denied", async () => {
		const erin = await testDb.db
			.selectFrom("users")
			.select("id")
			.where("oidc_subject", "=", "erin")
			.executeTakeFirstOrThrow();
		await expectAudit(
			() => loginAs(app, "erin", new CookieJar()).then(() => undefined),
			"auth.login",
			{ actor: `user:${erin.id}`, target: erin.id, result: "denied" },
		);
	});

	it("a forged callback writes auth.login failed and never echoes the code", async () => {
		const jar = new CookieJar();
		const start = await app.inject({ method: "GET", url: "/auth/login" });
		jar.capture(start);
		const state =
			new URL(String(start.headers.location)).searchParams.get("state") ?? "";
		let response: LightMyRequestResponse | undefined;
		await expectAudit(
			async () => {
				response = await app.inject({
					method: "GET",
					url: `/auth/callback?code=${PROBE}&state=${encodeURIComponent(state)}`,
					headers: { cookie: jar.cookieHeader() },
				});
				return response;
			},
			"auth.login",
			{ actor: "unknown", target: "unknown", result: "failed" },
			401,
		);
		expect(response?.body).not.toContain(PROBE);
	});

	it("too many sign-in starts write auth.throttled", async () => {
		const remoteAddress = "198.51.100.23";
		for (let i = 0; i < 150; i++) {
			await app.inject({ method: "GET", url: "/auth/login", remoteAddress });
		}
		await expectAudit(
			() => app.inject({ method: "GET", url: "/auth/login", remoteAddress }),
			"auth.throttled",
			{ actor: "unknown", target: "unknown", result: "denied" },
			429,
		);
	});
});

describe.skipIf(skip)("authorization changes and admin actions", () => {
	it("promotion and demotion write user.role_changed, and a demoted session loses admin access at once", async () => {
		const alice = world.a.jar;
		await expectAudit(
			() => post(world.admin, `/admin/users/${world.a.userId}/promote`),
			"user.role_changed",
			{
				actor: `user:${carolId}`,
				target: world.a.userId,
				result: "ok",
				metadata: expect.objectContaining({ from: "student", to: "administrator" }),
			},
			200,
		);
		const asAdmin = await app.inject({
			method: "GET",
			url: "/admin/settings",
			headers: { cookie: alice.cookieHeader() },
		});
		expect(asAdmin.statusCode).toBe(200);

		await expectAudit(
			() => post(world.admin, `/admin/users/${world.a.userId}/demote`),
			"user.role_changed",
			{
				actor: `user:${carolId}`,
				target: world.a.userId,
				result: "ok",
				metadata: expect.objectContaining({ from: "administrator", to: "student" }),
			},
			200,
		);
		// The same session cookie, with no new sign-in (SPEC.md §24.3).
		const afterDemotion = await app.inject({
			method: "GET",
			url: "/admin/settings",
			headers: { cookie: alice.cookieHeader() },
		});
		expect(afterDemotion.statusCode).toBe(403);
	});

	it("disable and enable write user.disabled and user.enabled", async () => {
		await expectAudit(
			() => post(world.admin, `/admin/users/${world.b.userId}/disable`),
			"user.disabled",
			{ actor: `user:${carolId}`, target: world.b.userId, result: "ok" },
			200,
		);
		await expectAudit(
			() => post(world.admin, `/admin/users/${world.b.userId}/enable`),
			"user.enabled",
			{ actor: `user:${carolId}`, target: world.b.userId, result: "ok" },
			200,
		);
		// Disabling ended Bob's sessions; later cases act as him again.
		await loginAs(app, "bob", world.b.jar);
	});

	it("an invitation writes admin.invitation_created and admin.invitation_revoked", async () => {
		let id = "";
		await expectAudit(
			async () => {
				const response = await post(world.admin, "/admin/invitations", {
					email: "invitee@example.edu",
					name: "Invitee",
					role: "student",
				});
				id = response.json().id as string;
				return response;
			},
			"admin.invitation_created",
			{ actor: `user:${carolId}`, result: "ok" },
			201,
		);
		await expectAudit(
			() => post(world.admin, `/admin/invitations/${id}/revoke`),
			"admin.invitation_revoked",
			{ actor: `user:${carolId}`, result: "ok" },
			200,
		);
	});

	it("a settings change writes settings.shutdown_grace_updated", async () => {
		await expectAudit(
			() => put(world.admin, "/admin/settings", { shutdownGraceSeconds: 600 }),
			"settings.shutdown_grace_updated",
			{ actor: `user:${carolId}`, result: "ok" },
			200,
		);
	});

	it("an egress mode change writes egress.mode_changed", async () => {
		const current = await app.inject({
			method: "GET",
			url: "/admin/egress",
			headers: { cookie: world.admin.cookieHeader() },
		});
		await expectAudit(
			() =>
				put(world.admin, "/admin/egress/mode", {
					version: current.json().version,
					mode: "allow-list",
				}),
			"egress.mode_changed",
			{ actor: `user:${carolId}`, target: "egress", result: "ok" },
			200,
		);
	});
});

describe.skipIf(skip)("workspace lifecycle, quota and maintenance", () => {
	it("creating a workspace wrote workspace.provision_requested", async () => {
		const rows = await testDb.db
			.selectFrom("audit_events")
			.select(["actor", "result"])
			.where("action", "=", "workspace.provision_requested")
			.where("target", "=", world.a.workspaceId)
			.execute();
		expect(rows).toEqual([{ actor: `user:${world.a.userId}`, result: "ok" }]);
	});

	it("stop and start write workspace.stop_requested and workspace.start_requested", async () => {
		const id = world.b.workspaceId;
		await expectAudit(
			() => post(world.b.jar, `/workspaces/${id}/stop`),
			"workspace.stop_requested",
			{ actor: `user:${world.b.userId}`, target: id, result: "ok" },
		);
		await expectAudit(
			() => post(world.b.jar, `/workspaces/${id}/start`),
			"workspace.start_requested",
			{ actor: `user:${world.b.userId}`, target: id, result: "ok" },
		);
	});

	it("a Docker reset writes workspace.docker_reset_requested", async () => {
		const id = world.b.workspaceId;
		await clearPending(id);
		await expectAudit(
			() => post(world.b.jar, `/workspaces/${id}/reset-docker`),
			"workspace.docker_reset_requested",
			{ actor: `user:${world.b.userId}`, target: id, result: "ok" },
			202,
		);
		await clearPending(id);
	});

	it("a rebuild writes workspace.rebuild_requested", async () => {
		const id = world.b.workspaceId;
		await clearPending(id);
		await expectAudit(
			() =>
				post(world.admin, `/admin/workspaces/${id}/rebuild`, { resetDocker: false }),
			"workspace.rebuild_requested",
			{ actor: `user:${carolId}`, target: id, result: "ok" },
			202,
		);
		await clearPending(id);
	});

	it("a quota change writes workspace.quota_updated", async () => {
		const id = world.b.workspaceId;
		await expectAudit(
			() =>
				put(world.admin, `/admin/workspaces/${id}/quota`, {
					homeGiB: 30,
					dockerGiB: 30,
				}),
			"workspace.quota_updated",
			{ actor: `user:${carolId}`, target: id, result: "ok" },
		);
	});

	it("archiving a workspace writes workspace.archived", async () => {
		const id = world.b.workspaceId;
		await expectAudit(
			() => post(world.admin, `/admin/workspaces/${id}/archive`),
			"workspace.archived",
			{ actor: `user:${carolId}`, target: id, result: "ok" },
		);
		await post(world.admin, `/admin/workspaces/${id}/unarchive`);
	});
});

describe.skipIf(skip)("projects and recovery", () => {
	it("archiving a project writes project.archived", async () => {
		const { workspaceId, projectId, jar, userId } = world.a;
		await expectAudit(
			() =>
				app.inject({
					method: "PATCH",
					url: `/workspaces/${workspaceId}/projects/${projectId}`,
					headers: csrfHeaders(jar, PUBLIC_URL),
					payload: { state: "archived" },
				}),
			"project.archived",
			{ actor: `user:${userId}`, target: projectId, result: "ok" },
			200,
		);
		await app.inject({
			method: "PATCH",
			url: `/workspaces/${workspaceId}/projects/${projectId}`,
			headers: csrfHeaders(jar, PUBLIC_URL),
			payload: { state: "active" },
		});
	});

	it("a recovery restore writes recovery.restored", async () => {
		const { workspaceId, projectId, jar, userId } = world.a;
		const base = `/workspaces/${workspaceId}/projects/${projectId}/recovery-points`;
		const made = await post(jar, base, {});
		expect(made.statusCode, made.body).toBe(201);
		const pointId = made.json().id as string;
		await expectAudit(
			() => post(jar, `${base}/${pointId}/restore`, {}),
			"recovery.restored",
			{ actor: `user:${userId}`, target: projectId, result: "ok" },
		);
	});
});

function authorize(token: string, host: string) {
	return app.inject({
		method: "GET",
		url: "/preview/authorize",
		remoteAddress: "127.0.0.1",
		headers: {
			"x-forwarded-host": host,
			"x-forwarded-method": "GET",
			"x-forwarded-uri": "/",
			"x-forwarded-proto": "https",
			cookie: `${PREVIEW_COOKIE}=${token}`,
		},
	});
}

function bootstrap(host: string, ticket: string) {
	return app.inject({
		method: "GET",
		url: `/__portikus/bootstrap?t=${encodeURIComponent(ticket)}`,
		headers: { "x-forwarded-host": host },
	});
}

/** What a client can tell apart: status, content type and body. */
function shape(response: LightMyRequestResponse) {
	return {
		status: response.statusCode,
		type: response.headers["content-type"],
		body: response.body,
	};
}

describe.skipIf(skip)("preview authorization failures", () => {
	let token = "";

	beforeAll(async () => {
		if (skip) return;
		const { jar, workspaceId, label } = world.a;
		const grant = await post(jar, `/workspaces/${workspaceId}/preview-grants`, {
			port: 5173,
			presentation: "embedded",
		});
		expect(grant.statusCode, grant.body).toBe(201);
		const ticket = new URL(grant.json().bootstrapUrl).searchParams.get("t") ?? "";
		const done = await bootstrap(`${label}-5173.${PREVIEW_SUFFIX}`, ticket);
		const cookie = (done.cookies as { name: string; value: string }[]).find(
			(one) => one.name === PREVIEW_COOKIE,
		);
		token = cookie?.value ?? "";
		expect(token).not.toBe("");
	});

	it("a 403 refusal writes preview.denied for the workspace, without the cookie", async () => {
		const { workspaceId, label } = world.a;
		await expectAudit(
			() => authorize(token, `${label}-3000.${PREVIEW_SUFFIX}`),
			"preview.denied",
			{ target: workspaceId, result: "denied" },
			403,
		);
		const rows = await rowsSince(0);
		expect(JSON.stringify(rows)).not.toContain(token);
	});

	it("an unknown preview label gets the same refusal as another student's real one", async () => {
		const real = await authorize(token, `${world.b.label}-5173.${PREVIEW_SUFFIX}`);
		const unknown = await authorize(token, `zz-no-such-label-5173.${PREVIEW_SUFFIX}`);
		expect(real.statusCode).toBeGreaterThanOrEqual(400);
		expect(shape(unknown)).toEqual(shape(real));
	});

	it("an unknown label's bootstrap gets the same refusal as a real one's", async () => {
		const real = await bootstrap(`${world.b.label}-5173.${PREVIEW_SUFFIX}`, PROBE);
		const unknown = await bootstrap(`zz-no-such-label-5173.${PREVIEW_SUFFIX}`, PROBE);
		expect(real.statusCode).toBe(403);
		expect(shape(unknown)).toEqual(shape(real));
	});
});

describe.skipIf(skip)("error responses never echo a token", () => {
	function expectNoEcho(response: LightMyRequestResponse) {
		expect(response.statusCode).toBeGreaterThanOrEqual(400);
		expect(response.body).not.toContain(PROBE);
		expect(JSON.stringify(response.headers)).not.toContain(PROBE);
	}

	it("an LTI launch with a forged ID token and state", async () => {
		expectNoEcho(
			await app.inject({
				method: "POST",
				url: "/lti/launch",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				payload: new URLSearchParams({ id_token: PROBE, state: PROBE }).toString(),
			}),
		);
	});

	it("a preview bootstrap with a forged ticket", async () => {
		expectNoEcho(await bootstrap(`${world.a.label}-5173.${PREVIEW_SUFFIX}`, PROBE));
	});

	it("a preview check with a forged session cookie", async () => {
		expectNoEcho(await authorize(PROBE, `${world.a.label}-5173.${PREVIEW_SUFFIX}`));
	});

	it("a sign-in callback with a forged state", async () => {
		expectNoEcho(
			await app.inject({
				method: "GET",
				url: `/auth/callback?code=${PROBE}&state=${PROBE}`,
			}),
		);
	});
});
