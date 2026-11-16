import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiKey } from "@portikus/auth";
import {
	CookieJar,
	loginAs,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import type { ApiKeyScope } from "@portikus/contracts";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type AccessClass, ROUTE_POLICY, splitKey } from "../route-policy.js";
import { type FakeAgent, startFakeAgent } from "../testing/fake-agent/index.js";
import {
	type FakeBackupKey,
	fakeKey,
	startFakeBackupKey,
} from "../testing/fake-backup-key.js";
import { PAYLOADS, QUERIES } from "../testing/matrix-samples.js";
import {
	buildMatrixWorld,
	buildTestServer,
	MATRIX_MOCK_USERS,
	type MatrixWorld,
	PUBLIC_URL,
} from "../testing/test-support.js";

/**
 * The authorization matrix (SPEC.md sections 5.2,
 * 5.3, 20.2, 24.3, 24.6). Every route the API registers has an access class
 * in route-policy.ts, and every kind of caller gets that class's answer.
 */

const skip = !hasTestDb();
if (skip && process.env.CI) {
	throw new Error("the authorization matrix must run in CI: set TEST_DATABASE_URL");
}

const AGENT_TOKEN = "matrix-agent-token";
const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const PUBLIC_ORIGIN = new URL(PUBLIC_URL).origin;

/**
 * Allowed-caller checks that fail today, with the issue that tracks each.
 * The refusal checks of these routes still run normally.
 */
const KNOWN_VULN: Record<string, string> = {};

/**
 * Routes whose allowed callers still get this refusal in the matrix world,
 * because the route needs state the world has none of: a recent course
 * session, a pending or existing link, a granted administrator or
 * instructor, or Dex's gRPC API. The gate let them through; the route's own
 * tests cover the success.
 */
const REFUSED_BY_STATE: Record<string, number> = {
	"POST /me/links/start": 400,
	// The matrix sends no If-Match; a 412 still means the owner passed the gate.
	"PUT /workspaces/:id/projects/:pid/layout": 412,
	// No course launch has left a starter in the matrix world.
	"POST /workspaces/:id/projects/starter": 404,
	"GET /me/links/pending": 404,
	"HEAD /me/links/pending": 404,
	"POST /me/links/passkey/start": 404,
	"POST /me/links/confirm": 404,
	"POST /me/links/:courseUserId/unlink": 404,
	"POST /admin/users/:id/demote": 400,
	"POST /admin/users/:id/remove-instructor": 400,
	"POST /admin/users/:id/links": 400,
	"DELETE /admin/users/:id/links/:courseUserId": 404,
	"POST /admin/dex-users": 404,
	"POST /admin/dex-users/:id/reset-password": 404,
	"POST /admin/dex-users/:id/reset-second-factor": 404,
	"POST /admin/dex-users/:id/remove": 404,
	"POST /admin/dex-users/:id/send-reset-link": 404,
	"PATCH /admin/dex-users/:id": 404,
	// The built-in AI is off in the matrix world, and it holds no conversation.
	"POST /assistant/conversations": 409,
	"DELETE /assistant/conversations/:id": 404,
	// The matrix world has no waiting invitation.
	"POST /admin/invitations/:id/revoke": 404,
	"POST /admin/invitations/:id/send": 404,
	// The matrix workspace is neither throttled nor flagged.
	"POST /admin/workspaces/:id/lift-throttle": 409,
	"POST /admin/workspaces/:id/clear-memory-flag": 409,
	// The matrix workspace is not in error.
	"POST /admin/workspaces/:id/reprovision": 409,
	// The matrix world records no notifications; each is its owner's alone.
	"PATCH /me/notifications/:id": 404,
	// The matrix world lists no egress entries.
	"PUT /admin/egress/entries/:id": 404,
	"DELETE /admin/egress/entries/:id": 404,
	"PUT /admin/egress/blocked-sites/:id": 404,
	"DELETE /admin/egress/blocked-sites/:id": 404,
	"POST /me/password": 404,
	// The matrix accounts are not Dex local passwords and hold no factor.
	"GET /me/second-factor": 400,
	"HEAD /me/second-factor": 400,
	"POST /me/second-factor/totp/start": 400,
	"POST /me/second-factor/totp": 400,
	"POST /me/second-factor/webauthn/start": 400,
	"POST /me/second-factor/webauthn": 400,
	"POST /me/second-factor/webauthn/verify/start": 400,
	"POST /me/second-factor/recovery-codes": 400,
	"PATCH /me/second-factor/:id": 400,
	"DELETE /me/second-factor/:id": 404,
	// Tests have no journal (test-support.ts points JOURNALCTL_PATH nowhere).
	"GET /admin/logs": 503,
	"HEAD /admin/logs": 503,
	"GET /admin/logs/counts": 503,
	"HEAD /admin/logs/counts": 503,
	// The matrix host never reported, so there is nothing to back up, delete or restore.
	"POST /admin/backups/run": 409,
	"DELETE /admin/backups/sets/:stamp": 400,
	"DELETE /admin/backups/dumps/:file": 400,
	"POST /admin/backups/restores": 404,
	"POST /admin/backups/restores/:id/replace-home": 404,
	"DELETE /admin/backups/snapshots/:volume/:snapshot": 400,
	"DELETE /admin/backups/kept-homes/:volume": 400,
	// Tests set no IMAGE_JOBS_DIR, so the Workspace image section is off.
	"GET /admin/image": 404,
	"HEAD /admin/image": 404,
	"GET /admin/image/diff": 404,
	"HEAD /admin/image/diff": 404,
	"POST /admin/image/jobs": 404,
	"GET /admin/image/jobs/:id": 404,
	"HEAD /admin/image/jobs/:id": 404,
	// Tests set no CERTIFICATE_JOBS_DIR, so the Certificate section is off.
	"GET /admin/certificate": 404,
	"HEAD /admin/certificate": 404,
	"GET /admin/certificate/jobs/:id": 404,
	"HEAD /admin/certificate/jobs/:id": 404,
	"POST /admin/certificate/jobs": 404,
	"POST /admin/certificate/preflight": 404,
	"GET /admin/certificate/root.crt": 404,
	"HEAD /admin/certificate/root.crt": 404,
	// Tests set no SITE_JOBS_DIR, so the Site address section is off.
	"GET /admin/address": 404,
	"HEAD /admin/address": 404,
	"POST /admin/address/plan": 404,
	"POST /admin/address/preflight": 404,
	"POST /admin/address/apply": 404,
	"POST /admin/address/keep": 404,
	"POST /admin/address/rollback": 404,
	// Tests set no ALERTS_JOBS_DIR, so the Notifications section is off.
	"GET /admin/proxy-hosts": 404,
	"HEAD /admin/proxy-hosts": 404,
	"PUT /admin/proxy-hosts": 404,
	"GET /admin/lms": 404,
	"HEAD /admin/lms": 404,
	"PUT /admin/lms": 404,
	"GET /admin/notifications": 404,
	"HEAD /admin/notifications": 404,
	"PUT /admin/notifications": 404,
	// Tests set no REGISTRY_JOBS_DIR, so the Docker section is off.
	"GET /admin/docker": 404,
	"HEAD /admin/docker": 404,
	"PUT /admin/docker/settings": 404,
	"PUT /admin/docker/hub-credential": 404,
	"DELETE /admin/docker/hub-credential": 404,
	"POST /admin/docker/cache/clear": 404,
	"PUT /admin/docker/seed/images": 404,
	"POST /admin/docker/seed/jobs": 404,
	"POST /admin/docker/seed/match": 404,
	"GET /admin/docker/seed/jobs": 404,
	"HEAD /admin/docker/seed/jobs": 404,
	"GET /admin/docker/usage": 404,
	"HEAD /admin/docker/usage": 404,
	// Tests set no SITE_JOBS_DIR, so the Sign-in tab's provider routes are off.
	"GET /admin/signin": 404,
	"HEAD /admin/signin": 404,
	"POST /admin/signin": 404,
	"POST /admin/signin/keep": 404,
	"POST /admin/signin/rollback": 404,
	"POST /admin/signin/test": 404,
	// The matrix world has no API keys; the sample names a key id that is nobody's.
	"POST /me/api-keys/:id/renew": 404,
	"POST /me/api-keys/:id/rotate": 404,
	"POST /me/api-keys/:id/revoke": 404,
	"POST /admin/api-keys/:id/expire": 404,
	"POST /admin/api-keys/:id/revoke": 404,
	// The matrix staff sign in through SSO, which owes no passkey to make a key.
	"POST /me/api-keys/passkey/start": 400,
	// The MCP server serves each request on its own, so it has no stream to resume.
	"GET /mcp": 405,
	// The sample names nobody who teaches A; live-help.test.ts covers a start.
	"POST /workspaces/:id/projects/:pid/live-help": 400,
};

// The smallest PNG: one transparent pixel.
const PIXEL_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
	"base64",
);

let testDb: TestDb;
let mock: MockOidcProvider;
let agent: FakeAgent;
/** The root backup key helper of an apt-installed server (ADR 0044). */
let keyHelper: FakeBackupKey;
let keyDir: string;
const MATRIX_KEY = fakeKey("matrix server");
/** A recovery point of A's project, made fresh with each world. */
let pointId: string;
/** A's one kept run of the "lint" check, made fresh with each world. */
let checkRunId: string;
/** A's open live help session with the instructor, made fresh with each world. */
let liveHelpId: string;

beforeAll(async () => {
	if (skip) return;
	testDb = await createTestDb();
	mock = await startMockOidcProvider({
		users: MATRIX_MOCK_USERS,
	});
	agent = await startFakeAgent(AGENT_TOKEN);
	keyDir = mkdtempSync(join(tmpdir(), "authz-matrix-key-"));
	keyHelper = await startFakeBackupKey(join(keyDir, "helper.sock"), {
		identity: MATRIX_KEY.identity,
		handedOut: null,
	});
});

afterAll(async () => {
	if (skip) return;
	await testDb.close();
	await mock.close();
	await agent.close();
	await keyHelper.close();
	rmSync(keyDir, { recursive: true, force: true });
});

/**
 * An administrator who must change their password, as the local
 * administrator is at first sign-in (SPEC.md section 5.3).
 */
const FLAGGED_MOCK_USER = "gail";

/**
 * An administrator who has not accepted the current acceptable-use
 * statement (SPEC.md section 5.1), so no role check can hide the gate.
 */
const UNACCEPTED_MOCK_USER = "frank";

type World = MatrixWorld & { flagged: CookieJar; unaccepted: CookieJar };

/** Routes a flagged account may still reach: `/auth/*` and the change form. */
function passesGate(key: string): boolean {
	return splitKey(key).url.startsWith("/auth/") || key === "POST /me/password";
}

/** Routes an account that has not accepted may still reach: `/auth/*` and the statement. */
function passesUseGate(key: string): boolean {
	return (
		splitKey(key).url.startsWith("/auth/") ||
		key === "GET /me/acceptable-use" ||
		key === "POST /me/acceptable-use"
	);
}

/** A fresh server and world, so one route's writes cannot reach the next. */
async function withWorld(
	run: (app: FastifyInstance, world: World) => Promise<void>,
): Promise<void> {
	await testDb.truncate();
	keyHelper.setState({ identity: MATRIX_KEY.identity, handedOut: null });
	const app = buildTestServer(testDb.db, mock.issuer, {
		AGENT_PORT: agent.port,
		BACKUP_KEY_SOCKET: keyHelper.socketPath,
	});
	await app.ready();
	try {
		const matrix = await buildMatrixWorld(app, testDb.db, AGENT_TOKEN);
		const flagged = new CookieJar();
		await loginAs(app, FLAGGED_MOCK_USER, flagged);
		await testDb.db
			.updateTable("users")
			.set({
				must_change_password: true,
				granted_role: "administrator",
				role: "administrator",
			})
			.where("oidc_subject", "=", FLAGGED_MOCK_USER)
			.execute();
		const unaccepted = new CookieJar();
		await loginAs(app, UNACCEPTED_MOCK_USER, unaccepted);
		await testDb.db
			.updateTable("users")
			.set({
				acceptable_use_version: null,
				granted_role: "administrator",
				role: "administrator",
			})
			.where("oidc_subject", "=", UNACCEPTED_MOCK_USER)
			.execute();
		const world: World = { ...matrix, flagged, unaccepted };
		pointId = crypto.randomUUID();
		await testDb.db
			.insertInto("recovery_points")
			.values({
				id: pointId,
				project_id: world.a.projectId,
				workspace_id: world.a.workspaceId,
				reason: "manual",
				created_by: `user:${world.a.userId}`,
				size_bytes: 1,
				sha256: "0".repeat(64),
				fingerprint: "f",
				// Old enough that "Create recovery point now" is not cooling down.
				created_at: new Date(Date.now() - 3_600_000).toISOString(),
				expires_at: new Date(Date.now() + 86_400_000).toISOString(),
			})
			.execute();
		checkRunId = crypto.randomUUID();
		await testDb.db
			.insertInto("check_runs")
			.values({
				id: checkRunId,
				project_id: world.a.projectId,
				check_id: "lint",
				agent_run_id: "matrix-1",
				state: "passed",
				started_at: new Date(Date.now() - 2000).toISOString(),
				ended_at: new Date(Date.now() - 1000).toISOString(),
				exit_code: 0,
			})
			.execute();
		// A has shared the project, so every owner route below is shown to
		// refuse the instructor even while a share is open (ADR 0057).
		await testDb.db
			.insertInto("project_shares")
			.values({
				project_id: world.a.projectId,
				ends_at: new Date(Date.now() + 3_600_000).toISOString(),
			})
			.execute();
		// A has live help open with the instructor too, so the owner routes
		// still refuse that instructor (ADR 0063).
		const helper = await testDb.db
			.selectFrom("users")
			.select("id")
			.where("oidc_subject", "=", "ivy")
			.executeTakeFirstOrThrow();
		liveHelpId = (
			await testDb.db
				.insertInto("live_help_sessions")
				.values({
					workspace_id: world.a.workspaceId,
					project_id: world.a.projectId,
					helper_user_id: helper.id,
					course_id: world.courseId,
					ends_at: new Date(Date.now() + 3_600_000).toISOString(),
				})
				.returning("id")
				.executeTakeFirstOrThrow()
		).id;
		await run(app, world);
	} finally {
		await app.close();
	}
}

/** Agent calls, leaving out the listening registry's own background socket. */
function agentCalls(): string[] {
	return agent.requests
		.filter((one) => !one.url.startsWith("/listening/events"))
		.map((one) => `${one.method} ${one.url}`);
}

interface Sample {
	url: string;
	payload?: string | Buffer | object;
	headers: Record<string, string>;
}

/**
 * A request the owner could reasonably send on this route, aimed at the ids
 * given. Every caller sends the same one, so only who sent it differs.
 */
function sampleFor(
	key: string,
	world: MatrixWorld,
	ids: { workspaceId: string; projectId: string; terminalId: string },
): Sample {
	const { url: pattern } = splitKey(key);
	let url = pattern
		// A process id is a number inside the workspace, not a project.
		.replace("/processes/:pid/", "/processes/7/")
		.replace(":pid", ids.projectId)
		.replace(":projectId", ids.projectId)
		.replace(":tid", ids.terminalId)
		.replace(":checkId", "lint")
		.replace(":courseId", world.courseId)
		.replace(":courseUserId", world.a.userId)
		.replace(":userId", world.a.userId)
		.replace(":rpid", pointId)
		.replace(":runId", checkRunId)
		.replace(":sid", liveHelpId)
		.replace(":port", "5173")
		.replace("*", "index.html");
	url =
		pattern.startsWith("/admin/users/:id") || pattern.startsWith("/admin/dex-users/:id")
			? url.replace(":id", world.a.userId)
			: url.replace(":id", ids.workspaceId);

	const sample: Sample = { url: `${url}${QUERIES[pattern] ?? ""}`, headers: {} };
	if (pattern.startsWith("/__portikus/") || pattern === "/preview/authorize") {
		// Aim at A's real preview host, so only a session could open it.
		sample.headers.host = `${world.a.label}-5173.preview.localhost`;
	}
	if (pattern === "/mcp") {
		sample.headers.accept = "application/json, text/event-stream";
	}
	if (key === "PUT /workspaces/:id/projects/:pid/file") {
		sample.payload = "hello";
		sample.headers["content-type"] = "text/plain";
	} else if (key === "PUT /me/picture") {
		sample.payload = PIXEL_PNG;
		sample.headers["content-type"] = "image/png";
	} else if (key === "DELETE /workspaces/:id/projects/:pid") {
		sample.payload = { slug: world.a.projectSlug };
	} else if (PAYLOADS[key]) {
		sample.payload = PAYLOADS[key];
	}
	return sample;
}

interface Actor {
	name: string;
	headers: Record<string, string>;
}

function actorsOf(world: World) {
	return {
		anonymous: { name: "anonymous", headers: {} },
		a: { name: "student A", headers: { cookie: world.a.jar.cookieHeader() } },
		b: { name: "student B", headers: { cookie: world.b.jar.cookieHeader() } },
		admin: { name: "administrator", headers: { cookie: world.admin.cookieHeader() } },
		instructor: {
			name: "instructor",
			headers: { cookie: world.instructor.cookieHeader() },
		},
		disabled: {
			name: "disabled user",
			headers: { cookie: world.disabled.cookieHeader() },
		},
		flagged: {
			name: "administrator who must change their password",
			headers: { cookie: world.flagged.cookieHeader() },
		},
		unaccepted: {
			name: "administrator who has not accepted the acceptable-use statement",
			headers: { cookie: world.unaccepted.cookieHeader() },
		},
		bearer: {
			name: "A's agent token, no cookie",
			headers: { authorization: `Bearer ${world.a.agentToken}` },
		},
	} satisfies Record<string, Actor>;
}

/** A fresh API key for a matrix staff member, by sign-in subject. */
async function keyOf(subject: string, scope: ApiKeyScope): Promise<string> {
	const owner = await testDb.db
		.selectFrom("users")
		.select("id")
		.where("oidc_subject", "=", subject)
		.executeTakeFirstOrThrow();
	const made = await createApiKey(testDb.db, owner.id, {
		name: "Matrix key",
		scope,
		periodDays: 30,
	});
	if (!made.ok) throw new Error(`no key for ${subject}: ${made.reason}`);
	return made.secret;
}

/**
 * A state-changing request carries a matching Origin, so the only thing
 * that can refuse it is who sent it.
 */
function withOrigin(key: string, actor: Actor): Actor {
	if (!UNSAFE.has(splitKey(key).method)) return actor;
	return { ...actor, headers: { ...actor.headers, origin: PUBLIC_ORIGIN } };
}

async function send(
	app: FastifyInstance,
	key: string,
	sample: Sample,
	headers: Record<string, string>,
): Promise<{ res: LightMyRequestResponse; calls: string[] }> {
	const before = agentCalls().length;
	const res = await app.inject({
		method: splitKey(key).method as "GET",
		url: sample.url,
		headers: { ...sample.headers, ...headers },
		...(sample.payload === undefined ? {} : { payload: sample.payload }),
	});
	return { res, calls: agentCalls().slice(before) };
}

/** Make A's workspace listen on 5173 and wait until the API has heard. */
async function seedListener(app: FastifyInstance, world: MatrixWorld): Promise<void> {
	const key = world.a.agentToken.slice(AGENT_TOKEN.length + 1);
	const seeded = await fetch(`http://127.0.0.1:${agent.port}/__test/listening`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ key, services: [{ port: 5173 }] }),
	});
	expect(seeded.status).toBe(204);
	await expect
		.poll(async () => {
			const res = await app.inject({
				method: "GET",
				url: `/workspaces/${world.a.workspaceId}/listening`,
				headers: { cookie: world.a.jar.cookieHeader() },
			});
			return res.body.includes("5173");
		})
		.toBe(true);
}

/** Nothing about student A may appear in an answer to anyone else. */
function expectNoTraceOfA(world: MatrixWorld, body: string, who: string): void {
	for (const secret of [
		world.a.email,
		world.a.projectName,
		world.a.projectSlug,
		world.a.terminalName,
		world.a.label,
	]) {
		expect(body, `${who}'s answer names ${secret}`).not.toContain(secret);
	}
}

async function expectRefused(
	app: FastifyInstance,
	world: MatrixWorld,
	key: string,
	sample: Sample,
	actor: Actor,
	status: number,
): Promise<void> {
	const { res, calls } = await send(app, key, sample, actor.headers);
	expect(res.statusCode, `${key} for ${actor.name}`).toBe(status);
	expect(calls, `${key} for ${actor.name} reached the agent`).toEqual([]);
	expectNoTraceOfA(world, res.body, actor.name);
}

/**
 * Allowed means the route did its work: a success, or an answer that came
 * back from the agent after the gate let the caller through.
 */
async function expectAllowed(
	app: FastifyInstance,
	key: string,
	sample: Sample,
	actor: Actor,
): Promise<LightMyRequestResponse> {
	const { res, calls } = await send(app, key, sample, actor.headers);
	const why = `${key} for ${actor.name} answered ${res.statusCode} ${res.body.slice(0, 200)}`;
	expect([401, 403], why).not.toContain(res.statusCode);
	if (REFUSED_BY_STATE[key] !== undefined) {
		expect(res.statusCode, why).toBe(REFUSED_BY_STATE[key]);
		return res;
	}
	expect(res.statusCode < 400 || calls.length > 0, why).toBe(true);
	return res;
}

/**
 * Every "METHOD url" in Fastify's printed route tree. Each line is one piece
 * of the path, indented four columns per level; the pieces join with nothing
 * between them, and a line that ends a route lists its methods.
 */
function printedRoutes(app: FastifyInstance): string[] {
	const keys: string[] = [];
	const parents: string[] = [];
	for (const line of app.printRoutes().split("\n")) {
		const match = /^(.*?)[├└]── (.*?)(?: \((.*)\))?$/.exec(line);
		if (!match) continue;
		const depth = (match[1] ?? "").length / 4;
		parents.length = depth;
		const url = parents.join("") + (match[2] ?? "");
		parents.push(match[2] ?? "");
		for (const method of match[3]?.split(", ") ?? []) keys.push(`${method} ${url}`);
	}
	return keys;
}

// --- Every route is classified, every class names a route ----

test.skipIf(skip)("every registered route has an access class, and back", async () => {
	const app = buildTestServer(testDb.db, mock.issuer, {
		AGENT_PORT: agent.port,
		BACKUP_KEY_SOCKET: keyHelper.socketPath,
	});
	const seen = new Map<string, boolean>();
	app.addHook("onRoute", (route) => {
		const methods = Array.isArray(route.method) ? route.method : [route.method];
		for (const method of methods) {
			seen.set(`${method} ${route.url}`, route.websocket === true);
		}
	});
	await app.ready();
	try {
		// The hook only sees routes registered after it was added. The printed
		// route tree lists every route, so one registered on the root instance
		// before the hook shows up here as unseen. Comparing both ways also
		// checks that the tree was read correctly.
		expect(
			printedRoutes(app).sort(),
			"routes registered outside the routes plugin in server.ts",
		).toEqual([...seen.keys()].sort());

		const unclassified = [...seen.keys()].filter((key) => !(key in ROUTE_POLICY));
		expect(unclassified, "routes with no class in route-policy.ts").toEqual([]);

		const gone = Object.keys(ROUTE_POLICY).filter((key) => {
			const { method, url } = splitKey(key);
			return !app.hasRoute({ method: method as "GET", url });
		});
		expect(gone, "route-policy.ts entries for routes that no longer exist").toEqual([]);

		const wrongSocketFlag = [...seen]
			.filter(
				([key, websocket]) => (ROUTE_POLICY[key]?.websocket ?? false) !== websocket,
			)
			.map(([key]) => key);
		expect(wrongSocketFlag, "routes whose websocket flag is wrong").toEqual([]);
	} finally {
		await app.close();
	}
});

// --- Every caller gets its class's answer --------------

const httpKeys = Object.keys(ROUTE_POLICY).filter((key) => {
	// A socket's upgrade is probed in ws-authz-matrix.test.ts.
	return !(ROUTE_POLICY[key]?.websocket && key.startsWith("GET "));
});

const signedInOnly: AccessClass[] = [
	"api-key",
	"self",
	"staff",
	"owner",
	"owner-or-admin",
	"admin",
	"course-instructor",
];

/** The LMS posts these cross-site; the token, state and nonce guard them. */
const CSRF_EXEMPT = new Set(["POST /lti/login", "POST /lti/launch"]);

describe.skipIf(skip)("refused callers get the class's refusal", () => {
	for (const key of httpKeys) {
		const access = ROUTE_POLICY[key]?.access as AccessClass;

		test(`${key} (${access})`, () =>
			withWorld(async (app, world) => {
				const actors = actorsOf(world);
				const own = sampleFor(key, world, world.a);

				if (UNSAFE.has(splitKey(key).method) && !CSRF_EXEMPT.has(key)) {
					const cookie = world.a.jar.cookieHeader();
					const preview = `https://${world.a.label}-5173.preview.localhost`;
					const noOrigin = { name: "A with no Origin", headers: { cookie } };
					const fromPreview = {
						name: "A from a preview Origin",
						headers: { cookie, origin: preview },
					};
					// The MCP door answers every keyless refusal with 401 (SPEC.md section 24.8).
					const refusal = access === "api-key" ? 401 : 403;
					await expectRefused(app, world, key, own, noOrigin, refusal);
					await expectRefused(app, world, key, own, fromPreview, refusal);
				}

				if (signedInOnly.includes(access)) {
					for (const actor of [actors.anonymous, actors.disabled, actors.bearer]) {
						await expectRefused(app, world, key, own, withOrigin(key, actor), 401);
					}
				}

				const a = withOrigin(key, actors.a);
				const b = withOrigin(key, actors.b);
				const admin = withOrigin(key, actors.admin);
				const instructor = withOrigin(key, actors.instructor);
				const flagged = withOrigin(key, actors.flagged);
				const unaccepted = withOrigin(key, actors.unaccepted);

				if (access === "api-key") {
					// No browser session gets in, whatever it may otherwise reach.
					for (const actor of [a, b, admin, instructor, flagged, unaccepted]) {
						await expectRefused(app, world, key, own, actor, 401);
					}
				}

				if (signedInOnly.includes(access) && access !== "api-key" && !passesGate(key)) {
					await expectRefused(app, world, key, own, flagged, 403);
					if (!key.startsWith("HEAD ")) {
						const { res } = await send(app, key, own, flagged.headers);
						expect(res.json().code, `${key} for the flagged account`).toBe(
							"PASSWORD_CHANGE_REQUIRED",
						);
					}
				}

				if (
					signedInOnly.includes(access) &&
					access !== "api-key" &&
					!passesUseGate(key)
				) {
					await expectRefused(app, world, key, own, unaccepted, 403);
					if (!key.startsWith("HEAD ")) {
						const { res } = await send(app, key, own, unaccepted.headers);
						expect(res.json().code, `${key} for the unaccepted account`).toBe(
							"ACCEPTABLE_USE_REQUIRED",
						);
					}
				}

				if (access === "owner" || access === "owner-or-admin") {
					await expectRefused(app, world, key, own, b, 404);
					// Teaching A's course gives no way into A's workspace.
					await expectRefused(app, world, key, own, instructor, 404);
				}
				if (access === "owner") {
					await expectRefused(app, world, key, own, admin, 404);
				}
				if (access === "staff") {
					await expectRefused(app, world, key, own, a, 403);
					await expectRefused(app, world, key, own, b, 403);
				}
				if (access === "admin") {
					await expectRefused(app, world, key, own, a, 403);
					await expectRefused(app, world, key, own, b, 403);
					await expectRefused(app, world, key, own, instructor, 403);
				}
				if (access === "course-instructor" && key.includes(":courseId")) {
					// A is a student of the course; nobody but its instructor sees it.
					for (const actor of [a, b, admin]) {
						const { res } = await send(app, key, own, actor.headers);
						expect(res.statusCode, `${key} for ${actor.name}`).toBe(404);
					}
				}
				if (access === "course-instructor" && !key.includes(":courseId")) {
					for (const actor of [a, b, admin]) {
						const { res } = await send(app, key, own, actor.headers);
						expect(res.statusCode, `${key} for ${actor.name}`).toBe(200);
						if (key.startsWith("GET ")) expect(res.json()).toEqual([]);
					}
				}
				if (access === "public" || access === "preview-edge") {
					// Nobody gets more than a stranger's GET gets. A HEAD twin
					// outside the sign-in exemption may be refused outright.
					const getKey = key.replace(/^HEAD /, "GET ");
					const anonymous = withOrigin(getKey, actors.anonymous);
					const stranger = await send(app, getKey, own, anonymous.headers);
					if (access === "public") {
						expect([401, 403]).not.toContain(stranger.res.statusCode);
					}
					for (const actor of Object.values(actors)) {
						const headers = withOrigin(key, actor).headers;
						const { res, calls } = await send(app, key, own, headers);
						// The gate may refuse a flagged account outright, which is no more.
						const gated = actor === actors.flagged || actor === actors.unaccepted;
						const refusals = gated ? [401, 403] : [401];
						expect(
							[stranger.res.statusCode, ...refusals],
							`${key} for ${actor.name} answered ${res.statusCode}`,
						).toContain(res.statusCode);
						expect(calls).toEqual([]);
					}
				}
			}));
	}
});

const allowedKeys = httpKeys.filter((key) => {
	const access = ROUTE_POLICY[key]?.access;
	return access !== "public" && access !== "preview-edge";
});

describe.skipIf(skip)("allowed callers get through", () => {
	for (const key of allowedKeys) {
		const access = ROUTE_POLICY[key]?.access as AccessClass;
		const known = KNOWN_VULN[key];
		const run = known ? test.fails : test;

		// One world per allowed caller, so one caller's change (a pending
		// maintenance operation, say) cannot refuse the next.
		const callers = access === "owner-or-admin" ? ["admin", "a"] : ["one"];
		run(known ? `${known} (${key})` : `${key} (${access})`, async () => {
			for (const caller of callers)
				await withWorld(async (app, world) => {
					const actors = actorsOf(world);
					const own = sampleFor(key, world, world.a);
					const a = withOrigin(key, actors.a);
					const b = withOrigin(key, actors.b);
					const admin = withOrigin(key, actors.admin);
					const instructor = withOrigin(key, actors.instructor);

					if (key.includes("/me/picture") && !key.startsWith("PUT ")) {
						// Give every caller a picture of their own to read or remove.
						const put = sampleFor("PUT /me/picture", world, world.a);
						for (const actor of [a, b, admin, instructor]) {
							await send(
								app,
								"PUT /me/picture",
								put,
								withOrigin("PUT x", actor).headers,
							);
						}
					}

					if (key.includes("/listening/")) await seedListener(app, world);

					switch (access) {
						case "self": {
							// Each caller acts on its own account and sees nothing of A.
							const forB = await expectAllowed(app, key, own, b);
							expectNoTraceOfA(world, forB.body, "student B");
							const forAdmin = await expectAllowed(app, key, own, admin);
							expectNoTraceOfA(world, forAdmin.body, "administrator");
							const forInstructor = await expectAllowed(app, key, own, instructor);
							expectNoTraceOfA(world, forInstructor.body, "instructor");
							await expectAllowed(app, key, own, a);
							break;
						}
						case "staff": {
							const forAdmin = await expectAllowed(app, key, own, admin);
							expectNoTraceOfA(world, forAdmin.body, "administrator");
							const forInstructor = await expectAllowed(app, key, own, instructor);
							expectNoTraceOfA(world, forInstructor.body, "instructor");
							break;
						}
						case "owner":
							await expectAllowed(app, key, own, a);
							break;
						case "owner-or-admin":
							await expectAllowed(app, key, own, caller === "admin" ? admin : a);
							break;
						case "admin":
							await expectAllowed(app, key, own, admin);
							break;
						case "course-instructor":
							await expectAllowed(app, key, own, instructor);
							break;
						case "api-key": {
							// Both kinds of key holder get in, whatever the key's scope.
							for (const [subject, scope] of [
								["carol", "read"],
								["ivy", "read"],
							] as const) {
								const secret = await keyOf(subject, scope);
								const holder = {
									name: `${subject}'s key`,
									headers: { authorization: `Bearer ${secret}` },
								};
								await expectAllowed(app, key, own, holder);
							}
							break;
						}
					}
				});
		});
	}
});

// --- Students hold no API keys ------------------------------------

const ownKeyRoutes = Object.keys(ROUTE_POLICY).filter((key) =>
	splitKey(key).url.startsWith("/me/api-keys"),
);

test("the key routes are all on the staff class", () => {
	expect(ownKeyRoutes.length).toBeGreaterThanOrEqual(7);
	for (const key of ownKeyRoutes) expect(ROUTE_POLICY[key]?.access, key).toBe("staff");
});

test.skipIf(skip)("a student session gets 403 on every /me/api-keys route", () =>
	withWorld(async (app, world) => {
		const a = actorsOf(world).a;
		for (const key of ownKeyRoutes) {
			const own = sampleFor(key, world, world.a);
			const { res } = await send(app, key, own, withOrigin(key, a).headers);
			expect(res.statusCode, key).toBe(403);
		}
		const keys = await testDb.db.selectFrom("api_keys").select("id").execute();
		expect(keys).toEqual([]);
	}),
);

// --- A's workspace with B's child id is a 404 -----------------

// A process id belongs to whichever workspace's agent is asked, so it has no
// owner of its own to mix in.
const childKeys = httpKeys.filter(
	(key) => /:(pid|tid|checkId|rpid)/.test(key) && !key.includes("/processes/"),
);

describe.skipIf(skip)("A's workspace id with B's child id is a 404", () => {
	for (const key of childKeys) {
		test(key, () =>
			withWorld(async (app, world) => {
				const mixed = sampleFor(key, world, {
					workspaceId: world.a.workspaceId,
					projectId: world.b.projectId,
					terminalId: world.b.terminalId,
				});
				const a = withOrigin(key, actorsOf(world).a);
				const { res, calls } = await send(app, key, mixed, a.headers);
				expect(res.statusCode).toBe(404);
				expect(calls, "the agent was called").toEqual([]);
				for (const secret of [world.b.projectName, world.b.terminalName]) {
					expect(res.body).not.toContain(secret);
				}
			}),
		);
	}
});
