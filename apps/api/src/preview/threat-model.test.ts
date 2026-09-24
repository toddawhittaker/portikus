import * as crypto from "node:crypto";
import { hashSessionToken } from "@portikus/auth";
import {
	CookieJar,
	csrfHeaders,
	loginAs,
	type MockOidcProvider,
	openWorkspaceSocket,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import { collectingLogger } from "@portikus/observability/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { type FakeAgent, startFakeAgent } from "../fake-agent.js";
import { buildTestServer, PUBLIC_URL } from "../test-support.js";

/**
 * The preview threat model (BROWSER-HANDLING.md §16, §25.1, §26; SPEC.md
 * §24.7). Everything here asks what the preview subsystem must refuse:
 * requests that carry a preview origin, planted cookies, replayed or
 * misdirected bootstrap tickets, authorization asked for under the wrong
 * host, port, user or lifecycle state, upstreams named by the request, and
 * secrets that must never reach a log line.
 */

const skip = !hasTestDb();
const AGENT_TOKEN = "threat-model-agent-token";
const SUFFIX = "preview.localhost";
const COOKIE = "portikus-preview";

let testDb: TestDb;
let mock: MockOidcProvider;
let agent: FakeAgent;
let app: FastifyInstance;
let alice: CookieJar;
let bob: CookieJar;
let workspaceId: string;
let label: string;

async function until(check: () => Promise<boolean> | boolean): Promise<void> {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("condition never held");
}

async function seedListening(
	key: string,
	services: {
		port: number;
		previewReachability?: "reachable" | "forwarded" | "unknown";
	}[],
): Promise<void> {
	const response = await fetch(`http://127.0.0.1:${agent.port}/__test/listening`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ key, services }),
	});
	expect(response.status).toBe(204);
}

function previewHostFor(port: number, name = label): string {
	return `${name}-${port}.${SUFFIX}`;
}

function previewOriginFor(port: number, name = label): string {
	// The end-to-end public URL carries a port, so the preview origin does too.
	return `https://${previewHostFor(port, name)}:5173`;
}

async function grant(
	instance: FastifyInstance,
	jar: CookieJar,
	id: string,
	port: number,
) {
	return instance.inject({
		method: "POST",
		url: `/workspaces/${id}/preview-grants`,
		headers: csrfHeaders(jar, PUBLIC_URL),
		payload: { port, presentation: "embedded" },
	});
}

function ticketOf(bootstrapUrl: string): string {
	return new URL(bootstrapUrl).searchParams.get("t") ?? "";
}

async function bootstrap(instance: FastifyInstance, host: string, ticket: string) {
	return instance.inject({
		method: "GET",
		url: `/__portikus/bootstrap?t=${encodeURIComponent(ticket)}`,
		headers: { "x-forwarded-host": host },
	});
}

function previewCookie(response: { cookies: unknown[] }): string {
	const cookie = (response.cookies as { name: string; value: string }[]).find(
		(one) => one.name === COOKIE,
	);
	if (!cookie) throw new Error("no preview cookie was set");
	return cookie.value;
}

async function authorize(
	token: string | null,
	host: string,
	options: { remoteAddress?: string; extra?: Record<string, string> } = {},
) {
	return app.inject({
		method: "GET",
		url: "/preview/authorize",
		remoteAddress: options.remoteAddress ?? "127.0.0.1",
		headers: {
			"x-forwarded-host": host,
			"x-forwarded-proto": "https",
			...(token === null ? {} : { cookie: `${COOKIE}=${token}` }),
			...options.extra,
		},
	});
}

/** A grant, its bootstrap, and the preview cookie the bootstrap set. */
async function openPreview(port: number): Promise<string> {
	const created = await grant(app, alice, workspaceId, port);
	expect(created.statusCode).toBe(201);
	const done = await bootstrap(
		app,
		previewHostFor(port),
		ticketOf(created.json().bootstrapUrl),
	);
	expect(done.statusCode).toBe(303);
	return previewCookie(done);
}

/** Make a workspace look started, with the fake agent behind it. */
async function makeRunning(id: string): Promise<string> {
	const row = await testDb.db
		.updateTable("workspaces")
		.set({
			state: "running",
			agent_address: "127.0.0.1",
			agent_token: `${AGENT_TOKEN}:${id}`,
			updated_at: new Date().toISOString(),
		})
		.where("id", "=", id)
		.returning("label")
		.executeTakeFirstOrThrow();
	return row.label;
}

beforeAll(async () => {
	if (skip) return;
	testDb = await createTestDb();
	mock = await startMockOidcProvider({
		redirectUris: [`${PUBLIC_URL}/auth/callback`],
	});
	agent = await startFakeAgent(AGENT_TOKEN);
});

afterAll(async () => {
	if (skip) return;
	await testDb.close();
	await mock.close();
	await agent.close();
});

beforeEach(async () => {
	if (skip) return;
	await testDb.truncate();
	agent.listening.clear();
	agent.forwards.clear();
	agent.failForward = false;
	app = buildTestServer(testDb.db, mock.issuer, { AGENT_PORT: agent.port });
	await app.listen({ port: 0, host: "127.0.0.1" });
	alice = new CookieJar();
	bob = new CookieJar();
	await loginAs(app, "alice", alice);
	await loginAs(app, "bob", bob);
	workspaceId = (
		await app.inject({
			method: "POST",
			url: "/workspaces",
			headers: csrfHeaders(alice, PUBLIC_URL),
		})
	).json().id;
	label = await makeRunning(workspaceId);
	await seedListening(workspaceId, [{ port: 5173 }]);
	await until(async () => {
		const seen = await app.inject({
			method: "GET",
			url: `/workspaces/${workspaceId}/listening`,
			headers: { cookie: alice.cookieHeader() },
		});
		return seen.json().services.length === 1;
	});
	return async () => {
		await app.close();
	};
});

// ── A preview origin may never drive the control plane (BH §16.1, §25.1) ──

const WRITES = [
	{
		name: "preview-grants",
		url: () => `/workspaces/${workspaceId}/preview-grants`,
		payload: () => ({ port: 5173, presentation: "embedded" }),
	},
	{
		name: "preview reset",
		url: () => `/workspaces/${workspaceId}/preview/reset`,
		payload: () => ({}),
	},
	{
		name: "the project create route",
		url: () => `/workspaces/${workspaceId}/projects`,
		payload: () => ({ name: "from-a-preview", source: "empty" }),
	},
];

for (const route of WRITES) {
	test.skipIf(skip)(
		`a same-site preview origin cannot post to ${route.name}`,
		async () => {
			const response = await app.inject({
				method: "POST",
				url: route.url(),
				headers: {
					cookie: alice.cookieHeader(),
					origin: previewOriginFor(5173),
					"sec-fetch-site": "same-site",
				},
				payload: route.payload(),
			});
			expect(response.statusCode).toBe(403);
			expect(response.json().code).toBe("FORBIDDEN");
		},
	);

	test.skipIf(skip)(
		`a preview origin with no fetch metadata cannot post to ${route.name}`,
		async () => {
			// An older browser sends no Sec-Fetch-Site, so Origin alone decides.
			const response = await app.inject({
				method: "POST",
				url: route.url(),
				headers: {
					cookie: alice.cookieHeader(),
					origin: previewOriginFor(5173),
				},
				payload: route.payload(),
			});
			expect(response.statusCode).toBe(403);
		},
	);
}

test.skipIf(skip)("the workspace socket refuses a preview origin", async () => {
	await expect(
		openWorkspaceSocket(app, workspaceId, alice, PUBLIC_URL, {
			origin: previewOriginFor(5173),
		}),
	).rejects.toMatchObject({ status: 403 });
});

test.skipIf(skip)(
	"the workspace socket refuses a preview origin with no port",
	async () => {
		await expect(
			openWorkspaceSocket(app, workspaceId, alice, PUBLIC_URL, {
				origin: `https://${previewHostFor(5173)}`,
			}),
		).rejects.toMatchObject({ status: 403 });
	},
);

// ── Parent-domain cookie planting (BROWSER-HANDLING.md §9.3) ──

/**
 * Over https the session cookie carries the `__Host-` prefix, so a preview
 * host can only plant a cookie under some other name. Simulate what the
 * browser would then send: both cookies on one request.
 */
test.skipIf(skip)("a planted cookie never authenticates as someone else", async () => {
	const secure = buildTestServer(testDb.db, mock.issuer, {
		AGENT_PORT: agent.port,
		PUBLIC_URL: "https://portikus.school.edu",
	});
	await secure.listen({ port: 0, host: "127.0.0.1" });
	try {
		const users = await testDb.db
			.selectFrom("users")
			.select(["id", "email"])
			.orderBy("created_at")
			.execute();
		const aliceId = users[0]?.id ?? "";
		const bobId = users[1]?.id ?? "";
		expect(aliceId).not.toBe(bobId);

		const aliceToken = crypto.randomBytes(32).toString("base64url");
		const bobToken = crypto.randomBytes(32).toString("base64url");
		for (const [token, userId] of [
			[aliceToken, aliceId],
			[bobToken, bobId],
		] as const) {
			await testDb.db
				.insertInto("sessions")
				.values({
					id: hashSessionToken(token),
					user_id: userId,
					expires_at: new Date(Date.now() + 3_600_000).toISOString(),
				})
				.execute();
		}

		const real = `__Host-portikus_session=${aliceToken}`;
		// A cookie a preview host planted with Domain=.school.edu arrives
		// without the prefix, and may arrive before or after the real one.
		const planted = `portikus_session=${bobToken}`;

		const me = async (cookie: string) =>
			secure.inject({ method: "GET", url: "/auth/me", headers: { cookie } });

		expect((await me(real)).json().id).toBe(aliceId);
		expect((await me(`${planted}; ${real}`)).json().id).toBe(aliceId);
		expect((await me(`${real}; ${planted}`)).json().id).toBe(aliceId);
		// On its own the planted cookie is nobody.
		expect((await me(planted)).statusCode).toBe(401);
		// Nor does a look-alike name help.
		expect(
			(await me(`portikus-session=${bobToken}; __host-portikus_session=${bobToken}`))
				.statusCode,
		).toBe(401);
	} finally {
		await secure.close();
	}
});

// ── Bootstrap tickets (BROWSER-HANDLING.md §9.1, §25.1) ──

test.skipIf(skip)(
	"a replayed ticket is refused and leaves the first session alone",
	async () => {
		const created = await grant(app, alice, workspaceId, 5173);
		const ticket = ticketOf(created.json().bootstrapUrl);
		const first = await bootstrap(app, previewHostFor(5173), ticket);
		const token = previewCookie(first);

		const replay = await bootstrap(app, previewHostFor(5173), ticket);
		expect(replay.statusCode).toBe(403);
		expect(replay.headers["set-cookie"]).toBeUndefined();
		const sessions = await testDb.db
			.selectFrom("preview_sessions")
			.selectAll()
			.execute();
		expect(sessions).toHaveLength(1);
		expect((await authorize(token, previewHostFor(5173))).statusCode).toBe(200);
	},
);

test.skipIf(skip)("a ticket that ran out of time is refused", async () => {
	const brief = buildTestServer(testDb.db, mock.issuer, {
		AGENT_PORT: agent.port,
		PREVIEW_TICKET_TTL_SECONDS: 1,
	});
	await brief.listen({ port: 0, host: "127.0.0.1" });
	try {
		const created = await grant(brief, alice, workspaceId, 5173);
		expect(created.statusCode).toBe(201);
		const ticket = ticketOf(created.json().bootstrapUrl);
		// The grant's expiry is compared against the database clock, so the
		// wait is real rather than a mocked timer.
		await new Promise((resolve) => setTimeout(resolve, 1200));
		const response = await bootstrap(brief, previewHostFor(5173), ticket);
		expect(response.statusCode).toBe(403);
		expect(
			await testDb.db.selectFrom("preview_sessions").selectAll().execute(),
		).toHaveLength(0);
	} finally {
		await brief.close();
	}
});

test.skipIf(skip)("a ticket is refused on the wrong host, port and label", async () => {
	const created = await grant(app, alice, workspaceId, 5173);
	const ticket = ticketOf(created.json().bootstrapUrl);
	// Another port of the same workspace.
	expect((await bootstrap(app, previewHostFor(3000), ticket)).statusCode).toBe(403);
	// Another workspace's label on the right port.
	expect(
		(await bootstrap(app, previewHostFor(5173, "ws-other"), ticket)).statusCode,
	).toBe(403);
	// The application host, and a look-alike suffix.
	expect((await bootstrap(app, "portikus.school.edu", ticket)).statusCode).toBe(403);
	expect((await bootstrap(app, `${label}-5173.evil.example`, ticket)).statusCode).toBe(
		403,
	);
	// None of that consumed it, and the port Caddy leaves on the host does
	// not change which preview host this is.
	expect(
		(await bootstrap(app, `${previewHostFor(5173)}:8443`, ticket)).statusCode,
	).toBe(303);
});

test.skipIf(skip)(
	"one student's ticket never opens another student's workspace",
	async () => {
		const bobWorkspace = (
			await app.inject({
				method: "POST",
				url: "/workspaces",
				headers: csrfHeaders(bob, PUBLIC_URL),
			})
		).json().id;
		const bobLabel = await makeRunning(bobWorkspace);
		await seedListening(bobWorkspace, [{ port: 5173 }]);
		await until(async () => {
			const seen = await app.inject({
				method: "GET",
				url: `/workspaces/${bobWorkspace}/listening`,
				headers: { cookie: bob.cookieHeader() },
			});
			return seen.json().services.length === 1;
		});

		// Bob's own ticket, presented on Alice's preview host.
		const bobGrant = await grant(app, bob, bobWorkspace, 5173);
		expect(bobGrant.statusCode).toBe(201);
		const bobTicket = ticketOf(bobGrant.json().bootstrapUrl);
		expect(
			(await bootstrap(app, previewHostFor(5173, label), bobTicket)).statusCode,
		).toBe(403);

		// And Alice asking for a grant on Bob's workspace never gets one.
		expect((await grant(app, alice, bobWorkspace, 5173)).statusCode).toBe(404);

		// Bob's ticket still works where it belongs, and names only his workspace.
		const done = await bootstrap(app, previewHostFor(5173, bobLabel), bobTicket);
		expect(done.statusCode).toBe(303);
	},
);

// ── The authorization matrix (BROWSER-HANDLING.md §10, §25.1) ──

test.skipIf(skip)("an expired main session ends the preview", async () => {
	const token = await openPreview(5173);
	await testDb.db
		.updateTable("sessions")
		.set({ expires_at: new Date(Date.now() - 1000).toISOString() })
		.execute();
	const response = await authorize(token, previewHostFor(5173));
	expect(response.statusCode).toBe(401);
	expect(response.headers["x-portikus-upstream"]).toBeUndefined();
});

test.skipIf(skip)("logging out ends the preview", async () => {
	const token = await openPreview(5173);
	const out = await app.inject({
		method: "POST",
		url: "/auth/logout",
		headers: csrfHeaders(alice, PUBLIC_URL),
	});
	expect(out.statusCode).toBeLessThan(400);
	expect((await authorize(token, previewHostFor(5173))).statusCode).toBe(401);
});

test.skipIf(skip)(
	"stopping the workspace after the session was made ends it",
	async () => {
		const token = await openPreview(5173);
		expect((await authorize(token, previewHostFor(5173))).statusCode).toBe(200);
		await testDb.db
			.updateTable("workspaces")
			.set({ state: "stopped", updated_at: new Date().toISOString() })
			.where("id", "=", workspaceId)
			.execute();
		await until(async () => {
			const response = await authorize(token, previewHostFor(5173));
			return response.statusCode !== 200;
		});
		const response = await authorize(token, previewHostFor(5173));
		expect([401, 503]).toContain(response.statusCode);
		expect(response.headers["x-portikus-upstream"]).toBeUndefined();
	},
);

test.skipIf(skip)("a port that stopped listening authorizes nothing", async () => {
	const token = await openPreview(5173);
	await seedListening(workspaceId, []);
	await until(
		async () => (await authorize(token, previewHostFor(5173))).statusCode === 503,
	);
	const response = await authorize(token, previewHostFor(5173));
	expect(response.statusCode).toBe(503);
	expect(response.headers["x-portikus-upstream"]).toBeUndefined();
});

test.skipIf(skip)("a host that carries a port still authorizes", async () => {
	const token = await openPreview(5173);
	const response = await authorize(token, `${previewHostFor(5173)}:8443`);
	expect(response.statusCode).toBe(200);
	expect(response.headers["x-portikus-upstream"]).toBe("127.0.0.1:5173");
});

test.skipIf(skip)(
	"an uppercase host authorizes and a trailing dot does not",
	async () => {
		const token = await openPreview(5173);
		const upper = await authorize(token, previewHostFor(5173).toUpperCase());
		expect(upper.statusCode).toBe(200);

		// A trailing dot is a different name on the wire, and is not routed.
		const dotted = await authorize(token, `${previewHostFor(5173)}.`);
		expect(dotted.statusCode).toBe(403);
		expect(dotted.headers["x-portikus-upstream"]).toBeUndefined();
	},
);

test.skipIf(skip)(
	"a session moved outside the port range authorizes nothing",
	async () => {
		const token = await openPreview(5173);
		for (const port of [80, 65536]) {
			await testDb.db.updateTable("preview_sessions").set({ port }).execute();
			const response = await authorize(token, previewHostFor(port));
			expect(response.statusCode).toBe(403);
			expect(response.headers["x-portikus-upstream"]).toBeUndefined();
		}
	},
);

test.skipIf(skip)("a session on a denied port authorizes nothing", async () => {
	const token = await openPreview(5173);
	for (const port of [22, 2375, 5432]) {
		await testDb.db.updateTable("preview_sessions").set({ port }).execute();
		const response = await authorize(token, previewHostFor(port));
		expect(response.statusCode).toBe(403);
		expect(response.headers["x-portikus-upstream"]).toBeUndefined();
	}
});

test.skipIf(skip)(
	"a valid session is worthless on another workspace's label",
	async () => {
		const bobWorkspace = (
			await app.inject({
				method: "POST",
				url: "/workspaces",
				headers: csrfHeaders(bob, PUBLIC_URL),
			})
		).json().id;
		const bobLabel = await makeRunning(bobWorkspace);
		await seedListening(bobWorkspace, [{ port: 5173 }]);
		const token = await openPreview(5173);

		const response = await authorize(token, previewHostFor(5173, bobLabel));
		expect(response.statusCode).toBe(403);
		expect(response.headers["x-portikus-upstream"]).toBeUndefined();
	},
);

test.skipIf(skip)("a malformed host never produces an upstream", async () => {
	const token = await openPreview(5173);
	const hosts = [
		"localhost.evil.example",
		`${label}-5173.preview.localhost.evil.example`,
		`extra.${previewHostFor(5173)}`,
		`user@${previewHostFor(5173)}`,
		`${label}-05173.${SUFFIX}`,
		`${label}-0x1f.${SUFFIX}`,
		`${label}-99999999.${SUFFIX}`,
		"169.254.169.254",
		"[::1]",
		"",
	];
	for (const host of hosts) {
		const response = await authorize(token, host);
		expect(response.statusCode, host).toBeGreaterThanOrEqual(400);
		expect(response.headers["x-portikus-upstream"], host).toBeUndefined();
	}
});

// ── The upstream comes from the workspace row alone (SPEC.md §24.7) ──

test.skipIf(skip)("no request header can name the upstream", async () => {
	const token = await openPreview(5173);
	const attempts: Record<string, string>[] = [
		{ "x-portikus-upstream": "169.254.169.254:80" },
		{ host: "169.254.169.254:80" },
		{ "x-portikus-upstream": "10.0.0.1:22", "x-forwarded-for": "10.0.0.1" },
		{ "x-forwarded-uri": "http://169.254.169.254/latest/meta-data" },
		{ "x-forwarded-port": "22" },
	];
	for (const extra of attempts) {
		const response = await authorize(token, previewHostFor(5173), { extra });
		expect(response.statusCode, JSON.stringify(extra)).toBe(200);
		expect(response.headers["x-portikus-upstream"]).toBe("127.0.0.1:5173");
	}

	// X-Forwarded-Host decides which preview host this is, so naming another
	// one is refused rather than answered for the Host header's workspace.
	const swapped = await authorize(token, previewHostFor(5173), {
		extra: {
			host: previewHostFor(5173),
			"x-forwarded-host": `ws-other-5173.${SUFFIX}`,
		},
	});
	expect(swapped.statusCode).toBe(403);
	expect(swapped.headers["x-portikus-upstream"]).toBeUndefined();
});

test.skipIf(skip)("a refused authorization never names an upstream", async () => {
	const responses = [
		await authorize(null, previewHostFor(5173)),
		await authorize("not-a-token", previewHostFor(5173)),
		await authorize(null, previewHostFor(5173), { remoteAddress: "10.1.2.3" }),
	];
	for (const response of responses) {
		expect(response.headers["x-portikus-upstream"]).toBeUndefined();
		expect(response.statusCode).toBeGreaterThanOrEqual(400);
	}
});

// ── Logging (BROWSER-HANDLING.md §16.5) ──

test.skipIf(skip)(
	"no log line carries a ticket, a preview token or a query string",
	async () => {
		const { logger, lines } = collectingLogger();
		const logged = buildTestServer(
			testDb.db,
			mock.issuer,
			{ AGENT_PORT: agent.port },
			logger,
		);
		await logged.listen({ port: 0, host: "127.0.0.1" });
		try {
			const jar = new CookieJar();
			await loginAs(logged, "alice", jar);
			const created = await grant(logged, jar, workspaceId, 5173);
			expect(created.statusCode).toBe(201);
			const ticket = ticketOf(created.json().bootstrapUrl);

			// A refused bootstrap, a good one, an authorization, and a reset:
			// every path that handles a secret.
			await bootstrap(logged, `${label}-3000.${SUFFIX}`, ticket);
			const done = await bootstrap(logged, previewHostFor(5173), ticket);
			const token = previewCookie(done);
			await logged.inject({
				method: "GET",
				url: "/preview/authorize",
				remoteAddress: "127.0.0.1",
				headers: {
					"x-forwarded-host": previewHostFor(5173),
					cookie: `${COOKIE}=${token}`,
				},
			});
			await logged.inject({
				method: "GET",
				url: "/__portikus/reset",
				headers: {
					"x-forwarded-host": previewHostFor(5173),
					cookie: `${COOKIE}=${token}`,
				},
			});

			const text = JSON.stringify(lines);
			expect(text).not.toContain(ticket);
			expect(text).not.toContain(token);
			expect(text).not.toContain("?t=");
			expect(text).not.toContain(jar.cookieHeader());
		} finally {
			await logged.close();
		}
	},
);
