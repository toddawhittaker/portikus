import { type AddressInfo, createServer } from "node:net";
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
import { createPreviewSession, hashToken } from "../preview/store.js";
import { buildTestServer, PUBLIC_URL } from "../test-support.js";

const skip = !hasTestDb();
const AGENT_TOKEN = "preview-agent-token";
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

/** Poll until a condition holds, so a registry tick does not need a sleep. */
async function until(check: () => Promise<boolean> | boolean): Promise<void> {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error("condition never held");
}

/** Tell the fake agent what this workspace is listening on. */
async function seedListening(
	services: {
		port: number;
		addresses?: string[];
		previewReachability?: "reachable" | "forwarded" | "unknown";
		system?: boolean;
		process?: { pid?: number; command?: string };
	}[],
): Promise<void> {
	const response = await fetch(`http://127.0.0.1:${agent.port}/__test/listening`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ key: workspaceId, services }),
	});
	expect(response.status).toBe(204);
}

/** A port that was free a moment ago and has nothing listening on it now. */
async function closedPort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	await new Promise<void>((resolve) => server.close(() => resolve()));
	return port;
}

function previewHostFor(port: number, name = label): string {
	return `${name}-${port}.${SUFFIX}`;
}

async function grant(
	jar: CookieJar,
	id: string,
	port: number,
	extra: Record<string, string> = {},
	presentation: "embedded" | "top-level" = "embedded",
) {
	return app.inject({
		method: "POST",
		url: `/workspaces/${id}/preview-grants`,
		headers: { ...csrfHeaders(jar, PUBLIC_URL), ...extra },
		payload: { port, presentation },
	});
}

/** The ticket out of a bootstrap URL. */
function ticketOf(bootstrapUrl: string): string {
	return new URL(bootstrapUrl).searchParams.get("t") ?? "";
}

async function bootstrap(
	host: string,
	ticket: string,
	extra: Record<string, string> = {},
) {
	return app.inject({
		method: "GET",
		url: `/__portikus/bootstrap?t=${encodeURIComponent(ticket)}`,
		headers: { "x-forwarded-host": host, ...extra },
	});
}

/** The preview cookie a bootstrap response set. */
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
			"x-forwarded-method": "GET",
			"x-forwarded-uri": "/",
			"x-forwarded-proto": "https",
			...(token === null ? {} : { cookie: `${COOKIE}=${token}` }),
			...options.extra,
		},
	});
}

/** The whole happy path: a grant, its bootstrap, and the cookie it set. */
async function openPreview(
	port: number,
	jar: CookieJar = alice,
	id: string = workspaceId,
	name?: string,
): Promise<string> {
	const created = await grant(jar, id, port);
	expect(created.statusCode).toBe(201);
	const done = await bootstrap(
		previewHostFor(port, name),
		ticketOf(created.json().bootstrapUrl),
	);
	expect(done.statusCode).toBe(303);
	return previewCookie(done);
}

/** A second running workspace, Bob's, with the fake agent behind it. */
async function bobsWorkspace(): Promise<{ id: string; label: string }> {
	const id = (
		await app.inject({
			method: "POST",
			url: "/workspaces",
			headers: csrfHeaders(bob, PUBLIC_URL),
		})
	).json().id;
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
	return { id, label: row.label };
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
	const row = await testDb.db
		.updateTable("workspaces")
		.set({
			state: "running",
			agent_address: "127.0.0.1",
			// The fake agent keeps one listing per key, so each workspace of a
			// run gets its own.
			agent_token: `${AGENT_TOKEN}:${workspaceId}`,
			updated_at: new Date().toISOString(),
		})
		.where("id", "=", workspaceId)
		.returning("label")
		.executeTakeFirstOrThrow();
	label = row.label;
	await seedListening([{ port: 5173 }]);
	// The registry needs one tick to open its socket to the agent.
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

// ── The listening registry (BROWSER-HANDLING.md §11.1, §17) ──

test.skipIf(skip)(
	"usage is proxied for the owner and hidden from everyone else",
	async () => {
		const response = await app.inject({
			method: "GET",
			url: `/workspaces/${workspaceId}/usage`,
			headers: { cookie: alice.cookieHeader() },
		});
		expect(response.statusCode).toBe(200);
		expect(response.json()).toMatchObject({
			cpuPercent: 1.5,
			processes: [{ pid: 7, command: "node" }],
		});

		const denied = await app.inject({
			method: "GET",
			url: `/workspaces/${workspaceId}/usage`,
			headers: { cookie: bob.cookieHeader() },
		});
		expect(denied.statusCode).toBe(404);
	},
);

test.skipIf(skip)("the registry stamps the workspace id on every service", async () => {
	const response = await app.inject({
		method: "GET",
		url: `/workspaces/${workspaceId}/listening`,
		headers: { cookie: alice.cookieHeader() },
	});
	expect(response.statusCode).toBe(200);
	expect(response.json().services).toEqual([
		expect.objectContaining({
			workspaceId,
			port: 5173,
			previewReachability: "reachable",
		}),
	]);
});

test.skipIf(skip)(
	"a denied port is marked denied however the agent reports it",
	async () => {
		await seedListening([
			{ port: 22, previewReachability: "reachable" },
			{ port: 5432, previewReachability: "reachable" },
			{ port: 5173 },
		]);
		await until(async () => {
			const seen = await app.inject({
				method: "GET",
				url: `/workspaces/${workspaceId}/listening`,
				headers: { cookie: alice.cookieHeader() },
			});
			return seen.json().services.length === 3;
		});
		const response = await app.inject({
			method: "GET",
			url: `/workspaces/${workspaceId}/listening`,
			headers: { cookie: alice.cookieHeader() },
		});
		const byPort = new Map<number, string>(
			response
				.json()
				.services.map((one: { port: number; previewReachability: string }) => [
					one.port,
					one.previewReachability,
				]),
		);
		expect(byPort.get(22)).toBe("denied");
		expect(byPort.get(5432)).toBe("denied");
		expect(byPort.get(5173)).toBe("reachable");
	},
);

// ── Stopping a listener (SPEC.md 18.2, issue #273) ──

/** Wait until the API reports exactly these ports for the workspace. */
async function untilPorts(ports: number[]): Promise<void> {
	await until(async () => {
		const seen = await app.inject({
			method: "GET",
			url: `/workspaces/${workspaceId}/listening`,
			headers: { cookie: alice.cookieHeader() },
		});
		const found = seen.json().services.map((one: { port: number }) => one.port);
		return JSON.stringify(found.sort()) === JSON.stringify([...ports].sort());
	});
}

async function stop(jar: CookieJar, id: string, port: number) {
	return app.inject({
		method: "POST",
		url: `/workspaces/${id}/listening/${port}/stop`,
		headers: csrfHeaders(jar, PUBLIC_URL),
	});
}

test.skipIf(skip)("the owner can stop a listener and the row goes away", async () => {
	await seedListening([{ port: 5173, process: { pid: 4242, command: "node" } }]);
	await untilPorts([5173]);
	const response = await stop(alice, workspaceId, 5173);
	expect(response.statusCode).toBe(200);
	expect(response.json()).toEqual({ port: 5173, stopped: true });
	await untilPorts([]);
});

test.skipIf(skip)("another user cannot stop a listener", async () => {
	await seedListening([{ port: 5173 }]);
	await untilPorts([5173]);
	const response = await stop(bob, workspaceId, 5173);
	expect(response.statusCode).toBe(404);
	// The listener is untouched.
	await untilPorts([5173]);
});

test.skipIf(skip)("a system listener is refused", async () => {
	await seedListening([{ port: 5355, system: true }, { port: 5173 }]);
	await untilPorts([5355, 5173]);
	const response = await stop(alice, workspaceId, 5355);
	expect(response.statusCode).toBe(403);
	expect(response.json().code).toBe("LISTENER_IS_SYSTEM");
});

/**
 * Stopping makes the control plane work for the student, so it shares the
 * grant and probe budget rather than being free (issue #283).
 */
test.skipIf(skip)(
	"stops come out of the same per-minute budget as grants and probes",
	async () => {
		await seedListening([{ port: 5173 }]);
		await untilPorts([5173]);
		for (let made = 0; made < 30; made += 1) {
			expect((await grant(alice, workspaceId, 5173)).statusCode).toBe(201);
		}
		const refused = await stop(alice, workspaceId, 5173);
		expect(refused.statusCode).toBe(429);
		expect(refused.json().code).toBe("PREVIEW_RATE_LIMITED");
		// The listener is untouched, and another student's budget is their own.
		await untilPorts([5173]);
	},
	20_000,
);

/** One stop at a time per workspace (issue #283). */
test.skipIf(skip)("a second stop while one is running is refused", async () => {
	await seedListening([{ port: 5173 }, { port: 5174 }]);
	await untilPorts([5173, 5174]);
	// The fake agent holds the first stop, so the second arrives while it runs.
	const hold = agent.holdNextStop();
	const firstStop = stop(alice, workspaceId, 5173);
	await hold.reached;
	const second = await stop(alice, workspaceId, 5174);
	hold.release();
	const first = await firstStop;
	expect([first.statusCode, second.statusCode]).toEqual([200, 409]);
	expect(second.json().code).toBe("STOP_IN_PROGRESS");
	// Once the first has answered, stopping works again.
	const again = await stop(alice, workspaceId, 5174);
	expect(again.statusCode).toBe(200);
});

test.skipIf(skip)("stopping a port nothing is listening on is a 404", async () => {
	await seedListening([{ port: 5173 }]);
	await untilPorts([5173]);
	const response = await stop(alice, workspaceId, 4321);
	expect(response.statusCode).toBe(404);
	expect(response.json().code).toBe("LISTENER_NOT_FOUND");
});

test.skipIf(skip)(
	"another user cannot read a workspace's listening ports",
	async () => {
		const response = await app.inject({
			method: "GET",
			url: `/workspaces/${workspaceId}/listening`,
			headers: { cookie: bob.cookieHeader() },
		});
		expect(response.statusCode).toBe(404);
	},
);

test.skipIf(skip)(
	"the workspace socket carries the listening list and its changes",
	async () => {
		const socket = await openWorkspaceSocket(app, workspaceId, alice, PUBLIC_URL);
		try {
			await until(() =>
				socket.messages.some(
					(message) =>
						message.type === "listening-services" &&
						message.services.some((one) => one.port === 5173),
				),
			);
			await seedListening([{ port: 5173 }, { port: 22 }]);
			await until(() =>
				socket.messages.some(
					(message) =>
						message.type === "listening-services" &&
						message.services.some((one) => one.previewReachability === "denied"),
				),
			);
			const frames = socket.messages.filter(
				(message) => message.type === "listening-services",
			);
			for (const frame of frames) {
				for (const service of frame.services) {
					expect(service.workspaceId).toBe(workspaceId);
				}
			}
		} finally {
			socket.ws.close();
		}
	},
);

// ── Grants (BROWSER-HANDLING.md §9.1) ──

test.skipIf(skip)("a grant names the preview host the server computed", async () => {
	const response = await grant(alice, workspaceId, 5173);
	expect(response.statusCode).toBe(201);
	const body = response.json();
	expect(body.previewOrigin).toBe(`https://${label}-5173.${SUFFIX}:5173`);
	expect(
		body.bootstrapUrl.startsWith(`${body.previewOrigin}/__portikus/bootstrap?t=`),
	).toBe(true);
	expect(new Date(body.expiresAt).getTime()).toBeGreaterThan(Date.now());
	expect(response.headers["cache-control"]).toBe("no-store");
});

test.skipIf(skip)("a student cannot ask for grants without end", async () => {
	for (let asked = 0; asked < 30; asked += 1) {
		expect((await grant(alice, workspaceId, 5173)).statusCode).toBe(201);
	}
	const refused = await grant(alice, workspaceId, 5173);
	expect(refused.statusCode).toBe(429);
	expect(refused.json().code).toBe("PREVIEW_RATE_LIMITED");

	// The limit is the student's own; it does not spill onto anyone else.
	const bobs = await bobsWorkspace();
	expect((await grant(bob, bobs.id, 5173)).statusCode).toBe(201);
});

test.skipIf(skip)(
	"asking for a grant clears preview sessions nobody can use",
	async () => {
		const bobs = await bobsWorkspace();
		await fetch(`http://127.0.0.1:${agent.port}/__test/listening`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ key: bobs.id, services: [{ port: 5173 }] }),
		});
		const live = await openPreview(5173, bob, bobs.id, bobs.label);

		// One of Alice's was revoked two days ago; the other is still open but
		// her main session has run out.
		const revoked = await openPreview(5173);
		await testDb.db
			.updateTable("preview_sessions")
			.set({ revoked_at: new Date(Date.now() - 2 * 86_400_000).toISOString() })
			.where("token_hash", "=", hashToken(revoked))
			.execute();
		const orphan = await openPreview(5173);
		const aliceId = (
			await testDb.db
				.selectFrom("preview_sessions")
				.select("user_id")
				.where("token_hash", "=", hashToken(orphan))
				.executeTakeFirstOrThrow()
		).user_id;
		await testDb.db
			.updateTable("sessions")
			.set({ expires_at: new Date(Date.now() - 1000).toISOString() })
			.where("user_id", "=", aliceId)
			.execute();

		expect((await grant(bob, bobs.id, 5173)).statusCode).toBe(201);

		const hashes = (
			await testDb.db.selectFrom("preview_sessions").select("token_hash").execute()
		).map((row) => row.token_hash);
		expect(hashes).not.toContain(hashToken(revoked));
		expect(hashes).not.toContain(hashToken(orphan));
		expect(hashes).toContain(hashToken(live));
	},
);

test.skipIf(skip)("a denied or out-of-range port gets no grant", async () => {
	expect((await grant(alice, workspaceId, 22)).statusCode).toBe(403);
	expect((await grant(alice, workspaceId, 80)).statusCode).toBe(403);
	expect((await grant(alice, workspaceId, 7400)).statusCode).toBe(403);
	expect((await grant(alice, workspaceId, 0)).statusCode).toBe(400);
});

test.skipIf(skip)("a stopped workspace gets no grant", async () => {
	await testDb.db
		.updateTable("workspaces")
		.set({ state: "stopped", updated_at: new Date().toISOString() })
		.where("id", "=", workspaceId)
		.execute();
	const response = await grant(alice, workspaceId, 5173);
	expect(response.statusCode).toBe(409);
	expect(response.json().code).toBe("WORKSPACE_NOT_RUNNING");
});

test.skipIf(skip)("another user gets no grant for this workspace", async () => {
	expect((await grant(bob, workspaceId, 5173)).statusCode).toBe(404);
});

test.skipIf(skip)(
	"a loopback-only port gets a forward before the grant is issued",
	async () => {
		await seedListening([{ port: 3000, previewReachability: "unknown" }]);
		await until(() => agent.listening.get(workspaceId)?.length === 1);
		const response = await grant(alice, workspaceId, 3000);
		expect(response.statusCode).toBe(201);
		expect([...(agent.forwards.get(workspaceId) ?? [])]).toEqual([3000]);
	},
);

test.skipIf(skip)("a forward the agent refuses answers 409", async () => {
	await seedListening([{ port: 3000, previewReachability: "unknown" }]);
	await until(() => agent.listening.get(workspaceId)?.length === 1);
	agent.failForward = true;
	const response = await grant(alice, workspaceId, 3000);
	expect(response.statusCode).toBe(409);
	expect(response.json().code).toBe("PREVIEW_FORWARD_FAILED");
});

test.skipIf(skip)(
	"a grant asked for from a preview origin is refused (BROWSER-HANDLING 16.1)",
	async () => {
		const response = await app.inject({
			method: "POST",
			url: `/workspaces/${workspaceId}/preview-grants`,
			headers: {
				cookie: alice.cookieHeader(),
				origin: `https://${previewHostFor(5173)}`,
				"sec-fetch-site": "same-site",
			},
			payload: { port: 5173, presentation: "embedded" },
		});
		expect(response.statusCode).toBe(403);
	},
);

// ── Bootstrap (BROWSER-HANDLING.md §9.1, §9.2) ──

test.skipIf(skip)("bootstrap sets a host-only cookie and redirects", async () => {
	const created = await grant(alice, workspaceId, 5173);
	const response = await bootstrap(
		previewHostFor(5173),
		ticketOf(created.json().bootstrapUrl),
	);
	expect(response.statusCode).toBe(303);
	expect(response.headers.location).toBe("/");
	expect(response.headers["cache-control"]).toBe("no-store");
	expect(response.headers["referrer-policy"]).toBe("no-referrer");
	const header = String(response.headers["set-cookie"]);
	expect(header).toContain("HttpOnly");
	expect(header).toContain("SameSite=Strict");
	expect(header).toContain("Path=/");
	expect(header).not.toContain("Domain=");
	// Nothing of the ticket may survive into the response.
	expect(response.body).not.toContain(ticketOf(created.json().bootstrapUrl));
});

test.skipIf(skip)("a ticket is only good where it was meant to open", async () => {
	// A ticket for the preview frame, opened as a top-level page.
	const framed = await grant(alice, workspaceId, 5173);
	const refusedTop = await bootstrap(
		previewHostFor(5173),
		ticketOf(framed.json().bootstrapUrl),
		{ "sec-fetch-dest": "document" },
	);
	expect(refusedTop.statusCode).toBe(403);
	expect(refusedTop.headers["set-cookie"]).toBeUndefined();

	// A ticket for a tab, opened inside a frame.
	const tab = await grant(alice, workspaceId, 5173, {}, "top-level");
	const refusedFrame = await bootstrap(
		previewHostFor(5173),
		ticketOf(tab.json().bootstrapUrl),
		{ "sec-fetch-dest": "iframe" },
	);
	expect(refusedFrame.statusCode).toBe(403);
	expect(refusedFrame.headers["set-cookie"]).toBeUndefined();

	expect(
		await testDb.db.selectFrom("preview_sessions").selectAll().execute(),
	).toHaveLength(0);
});

test.skipIf(skip)("a ticket opened the way it asked for is accepted", async () => {
	const framed = await grant(alice, workspaceId, 5173);
	expect(
		(
			await bootstrap(previewHostFor(5173), ticketOf(framed.json().bootstrapUrl), {
				"sec-fetch-dest": "iframe",
			})
		).statusCode,
	).toBe(303);

	const tab = await grant(alice, workspaceId, 5173, {}, "top-level");
	expect(
		(
			await bootstrap(previewHostFor(5173), ticketOf(tab.json().bootstrapUrl), {
				"sec-fetch-dest": "document",
			})
		).statusCode,
	).toBe(303);

	// A browser that sends no Sec-Fetch-Dest is still let in.
	const quiet = await grant(alice, workspaceId, 5173);
	expect(
		(await bootstrap(previewHostFor(5173), ticketOf(quiet.json().bootstrapUrl)))
			.statusCode,
	).toBe(303);
});

test.skipIf(skip)("an unknown ticket is refused", async () => {
	const response = await bootstrap(previewHostFor(5173), "not-a-ticket");
	expect(response.statusCode).toBe(403);
	expect(response.headers["content-type"]).toContain("text/html");
});

// ── Authorization (BROWSER-HANDLING.md §10, ADR 0018) ──
// The refusal matrix a hostile request meets lives in threat-model.test.ts;
// what a student sees when a preview is simply not there lives here.

test.skipIf(skip)(
	"an authorized request names the workspace's own upstream",
	async () => {
		const token = await openPreview(5173);
		const response = await authorize(token, previewHostFor(5173));
		expect(response.statusCode).toBe(200);
		expect(response.headers["x-portikus-upstream"]).toBe("127.0.0.1:5173");
		expect(response.body).toBe("");
	},
);

test.skipIf(skip)("no preview cookie is 401", async () => {
	const response = await authorize(null, previewHostFor(5173));
	expect(response.statusCode).toBe(401);
	expect(response.headers["x-portikus-upstream"]).toBeUndefined();
});

test.skipIf(skip)("an unknown or revoked preview session is 401", async () => {
	expect((await authorize("nonsense", previewHostFor(5173))).statusCode).toBe(401);

	const token = await openPreview(5173);
	await testDb.db
		.updateTable("preview_sessions")
		.set({ revoked_at: new Date().toISOString() })
		.execute();
	const response = await authorize(token, previewHostFor(5173));
	expect(response.statusCode).toBe(401);
	expect(response.headers["x-portikus-upstream"]).toBeUndefined();
});

test.skipIf(skip)("a preview session dies with its main session", async () => {
	const token = await openPreview(5173);
	expect((await authorize(token, previewHostFor(5173))).statusCode).toBe(200);

	await app.inject({
		method: "POST",
		url: "/auth/logout",
		headers: csrfHeaders(alice, PUBLIC_URL),
	});

	const response = await authorize(token, previewHostFor(5173));
	expect(response.statusCode).toBe(401);
});

test.skipIf(skip)("a preview cookie is worthless on another host", async () => {
	const token = await openPreview(5173);
	// Another port of the same workspace, and another workspace's label.
	expect((await authorize(token, previewHostFor(3000))).statusCode).toBe(403);
	expect((await authorize(token, `someone-5173.${SUFFIX}`)).statusCode).toBe(403);
	expect((await authorize(token, "127.0.0.1")).statusCode).toBe(403);
	expect((await authorize(token, `${label}-5173.evil.example`)).statusCode).toBe(403);
});

test.skipIf(skip)(
	"a 403 refusal is audited as preview.denied, once a minute",
	async () => {
		const token = await openPreview(5173);
		for (let i = 0; i < 3; i++) {
			expect((await authorize(token, previewHostFor(3000))).statusCode).toBe(403);
		}
		// A refusal for a second reason gets its own row.
		const bridged = await authorize(token, previewHostFor(5173), {
			extra: { "x-forwarded-uri": "/__portikus/ports/nope/" },
		});
		expect(bridged.statusCode).toBe(403);
		// 401 answers are the ordinary "sign in first" and are not audited.
		expect((await authorize(null, previewHostFor(5173))).statusCode).toBe(401);

		const rows = await testDb.db
			.selectFrom("audit_events")
			.selectAll()
			.where("action", "=", "preview.denied")
			.orderBy("id")
			.execute();
		expect(rows.map((row) => row.metadata)).toEqual([
			{ reason: "host_mismatch", workspaceId, count: 3 },
			{ reason: "invalid_bridge_path", workspaceId, count: 1 },
		]);
		expect(rows.every((row) => row.target === workspaceId)).toBe(true);
		expect(rows.every((row) => row.result === "denied")).toBe(true);
		// No cookie, ticket, host or path reaches the audit row (STACK.md §15).
		const serialized = JSON.stringify(rows.map((row) => row.metadata));
		expect(serialized).not.toContain(token);
		expect(serialized).not.toContain(SUFFIX);
	},
);

test.skipIf(skip)("a workspace that changed hands stops authorizing", async () => {
	const token = await openPreview(5173);
	const bobId = (
		await testDb.db
			.selectFrom("users")
			.select("id")
			.where("display_name", "!=", "")
			.orderBy("created_at")
			.execute()
	).at(-1)?.id;
	await testDb.db
		.updateTable("workspaces")
		.set({ owner_user_id: bobId ?? "", updated_at: new Date().toISOString() })
		.where("id", "=", workspaceId)
		.execute();
	expect((await authorize(token, previewHostFor(5173))).statusCode).toBe(403);
});

test.skipIf(skip)("a stopped workspace explains itself", async () => {
	const token = await openPreview(5173);
	await testDb.db
		.updateTable("workspaces")
		.set({ state: "stopped", updated_at: new Date().toISOString() })
		.where("id", "=", workspaceId)
		.execute();
	const response = await authorize(token, previewHostFor(5173));
	expect(response.statusCode).toBe(503);
	expect(response.headers["content-type"]).toContain("text/html");
	expect(response.body).toContain("not running");
});

test.skipIf(skip)(
	"a stopped workspace explains itself after its sessions are revoked",
	async () => {
		// Stopping revokes the preview sessions too; the more specific cause wins.
		const token = await openPreview(5173);
		await testDb.db
			.updateTable("workspaces")
			.set({ state: "stopped", updated_at: new Date().toISOString() })
			.where("id", "=", workspaceId)
			.execute();
		await testDb.db
			.updateTable("preview_sessions")
			.set({ revoked_at: new Date().toISOString() })
			.execute();
		const response = await authorize(token, previewHostFor(5173));
		expect(response.statusCode).toBe(503);
		expect(response.body).toContain("not running");
		expect(response.headers["x-portikus-upstream"]).toBeUndefined();

		// The revoked cookie proves nothing on another host.
		expect((await authorize(token, previewHostFor(3000))).statusCode).toBe(401);

		// A student who signed out is told to sign in, not about the workspace.
		await app.inject({
			method: "POST",
			url: "/auth/logout",
			headers: csrfHeaders(alice, PUBLIC_URL),
		});
		expect((await authorize(token, previewHostFor(5173))).statusCode).toBe(401);
	},
);

test.skipIf(skip)("a port with nothing listening explains itself", async () => {
	const token = await openPreview(5173);
	await seedListening([]);
	await until(async () => {
		const response = await authorize(token, previewHostFor(5173));
		return response.statusCode === 503;
	});
	const response = await authorize(token, previewHostFor(5173));
	expect(response.body).toContain("Nothing is currently listening on port 5173");
	expect(response.body).toContain("Start your application to reconnect this preview");
});

test.skipIf(skip)("only loopback may ask for an authorization", async () => {
	const token = await openPreview(5173);
	const response = await authorize(token, previewHostFor(5173), {
		remoteAddress: "10.1.2.3",
	});
	expect(response.statusCode).toBe(403);
	expect(response.headers["x-portikus-upstream"]).toBeUndefined();
});

test.skipIf(skip)("a preview session of one user never serves another", async () => {
	// Bob gets his own running workspace and preview.
	const bobWorkspace = (
		await app.inject({
			method: "POST",
			url: "/workspaces",
			headers: csrfHeaders(bob, PUBLIC_URL),
		})
	).json().id;
	await testDb.db
		.updateTable("workspaces")
		.set({
			state: "running",
			agent_address: "127.0.0.1",
			agent_token: `${AGENT_TOKEN}:${bobWorkspace}`,
			updated_at: new Date().toISOString(),
		})
		.where("id", "=", bobWorkspace)
		.execute();

	const aliceToken = await openPreview(5173);
	const bobLabel = (
		await testDb.db
			.selectFrom("workspaces")
			.select("label")
			.where("id", "=", bobWorkspace)
			.executeTakeFirstOrThrow()
	).label;

	// Alice's cookie on Bob's preview host resolves to nothing.
	const response = await authorize(aliceToken, previewHostFor(5173, bobLabel));
	expect(response.statusCode).toBe(403);
	expect(response.headers["x-portikus-upstream"]).toBeUndefined();
});

// ── The framing probe (BROWSER-HANDLING.md §12) ──

/** Start a real application inside the fake agent and wait for the registry. */
async function startApp(frameOptions?: string, delayMs = 0): Promise<number> {
	const created = await fetch(`http://127.0.0.1:${agent.port}/__test/app`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			key: workspaceId,
			title: "Framing",
			frameOptions,
			delayMs,
		}),
	});
	expect(created.status).toBe(201);
	const { port } = (await created.json()) as { port: number };
	await until(async () => {
		const seen = await app.inject({
			method: "GET",
			url: `/workspaces/${workspaceId}/listening`,
			headers: { cookie: alice.cookieHeader() },
		});
		return (seen.json().services as { port: number }[]).some(
			(one) => one.port === port,
		);
	});
	return port;
}

async function embeddable(
	port: number,
	id: string = workspaceId,
	jar: CookieJar = alice,
) {
	return app.inject({
		method: "GET",
		url: `/workspaces/${id}/preview/embeddable?port=${port}`,
		headers: { cookie: jar.cookieHeader() },
	});
}

test.skipIf(skip)("an ordinary application is reported as embeddable", async () => {
	const port = await startApp();
	const response = await embeddable(port);
	expect(response.statusCode).toBe(200);
	expect(response.json()).toEqual({ embeddable: true });
});

test.skipIf(skip)(
	"an application that refuses framing is reported as not embeddable",
	async () => {
		const port = await startApp("DENY");
		const response = await embeddable(port);
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({
			embeddable: false,
			reason: "x-frame-options",
		});
	},
);

test.skipIf(skip)(
	"the probe never returns anything the application served",
	async () => {
		const port = await startApp();
		const response = await embeddable(port);
		// The test app's page says "Framing"; only the verdict comes back.
		expect(response.body).not.toContain("Framing");
		expect(Object.keys(response.json())).toEqual(["embeddable"]);
	},
);

test.skipIf(skip)(
	"a port the registry does not vouch for is unreachable, not probed",
	async () => {
		// 5174 is not in the registry at all, so no upstream can be named.
		const response = await embeddable(5174);
		expect(response.statusCode).toBe(200);
		expect(response.json()).toEqual({ embeddable: false, reason: "unreachable" });
	},
);

test.skipIf(skip)("an application that does not answer is unreachable", async () => {
	// A port this test bound and closed, so nothing else on the machine answers it.
	const port = await closedPort();
	await seedListening([{ port }]);
	await until(async () => {
		const seen = await app.inject({
			method: "GET",
			url: `/workspaces/${workspaceId}/listening`,
			headers: { cookie: alice.cookieHeader() },
		});
		return seen.json().services.some((one: { port: number }) => one.port === port);
	});
	const response = await embeddable(port);
	expect(response.statusCode).toBe(200);
	expect(response.json()).toEqual({ embeddable: false, reason: "unreachable" });
});

test.skipIf(skip)("the probe refuses a port policy does not allow", async () => {
	const response = await embeddable(22);
	expect(response.statusCode).toBe(403);
});

test.skipIf(skip)("one student cannot probe another's workspace", async () => {
	const bobs = await bobsWorkspace();
	const response = await embeddable(5173, bobs.id);
	expect(response.statusCode).toBe(404);
});

test.skipIf(skip)(
	"grants and probes share one per-minute budget",
	async () => {
		// The probe does real work on the student's behalf — it holds an
		// outbound socket for up to three seconds — so it is counted with the
		// grants rather than being free. Each test builds a fresh server, so
		// the window starts empty here.
		// 5174 is not in the registry, so each probe answers at once.
		for (let made = 0; made < 30; made += 1) {
			expect((await embeddable(5174)).statusCode).toBe(200);
		}
		const probe = await embeddable(5174);
		expect(probe.statusCode).toBe(429);
		expect(probe.json().code).toBe("PREVIEW_RATE_LIMITED");
		// The grant route shares the same spent budget.
		expect((await grant(alice, workspaceId, 5173)).statusCode).toBe(429);
		// Another student's budget is their own.
		const bobs = await bobsWorkspace();
		expect((await embeddable(5174, bobs.id, bob)).statusCode).toBe(200);
	},
	20_000,
);

test.skipIf(skip)(
	"two probes of the same port at once ask the application once",
	async () => {
		const port = await startApp(undefined, 300);
		agent.appHits.set(port, 0);
		const [first, second] = await Promise.all([embeddable(port), embeddable(port)]);
		expect(first.statusCode).toBe(200);
		expect(second.statusCode).toBe(200);
		expect(first.json()).toEqual({ embeddable: true });
		expect(second.json()).toEqual(first.json());
		expect(agent.appHits.get(port)).toBe(1);
	},
	20_000,
);

test.skipIf(skip)(
	"two probes of different ports at once are answered one at a time",
	async () => {
		const open = await startApp(undefined, 300);
		const refusing = await startApp("DENY", 300);
		agent.appHits.set(open, 0);
		agent.appHits.set(refusing, 0);
		const [first, second] = await Promise.all([embeddable(open), embeddable(refusing)]);
		// Each port gets its own answer; neither reuses the other's.
		expect(first.json()).toEqual({ embeddable: true });
		expect(second.json()).toEqual({
			embeddable: false,
			reason: "x-frame-options",
		});
		expect(agent.appHits.get(open)).toBe(1);
		expect(agent.appHits.get(refusing)).toBe(1);
	},
	20_000,
);

test.skipIf(skip)("the probe needs a session", async () => {
	const response = await app.inject({
		method: "GET",
		url: `/workspaces/${workspaceId}/preview/embeddable?port=5173`,
	});
	expect(response.statusCode).toBe(401);
});

test.skipIf(skip)(
	"a student holds at most fifty live preview sessions",
	async () => {
		// Nothing else bounds how many previews one main session can open, so
		// the oldest gives way rather than the table growing without limit.
		// The sessions are made through the store so the grant rate limit,
		// which is a separate guard, does not decide this test.
		const first = await openPreview(5173);
		const row = await testDb.db
			.selectFrom("preview_sessions")
			.select(["user_id", "session_id"])
			.executeTakeFirstOrThrow();

		const tokens = [first];
		for (let opened = 0; opened < 51; opened += 1) {
			tokens.push(
				await createPreviewSession(testDb.db, {
					userId: row.user_id,
					sessionId: row.session_id,
					workspaceId,
					port: 5173,
					previewHost: previewHostFor(5173),
				}),
			);
		}

		const live = await testDb.db
			.selectFrom("preview_sessions")
			.select("id")
			.where("revoked_at", "is", null)
			.execute();
		expect(live.length).toBe(50);

		// The oldest gave way; the newest still opens the preview.
		expect(
			(await authorize(tokens[0] as string, previewHostFor(5173))).statusCode,
		).toBe(401);
		expect(
			(await authorize(tokens[51] as string, previewHostFor(5173))).statusCode,
		).toBe(200);
	},
	30_000,
);

// ── Reset (BROWSER-HANDLING.md §16.4) ──

test.skipIf(skip)(
	"reset expires the application's own cookies as well as ours",
	async () => {
		const token = await openPreview(5173);
		const response = await app.inject({
			method: "GET",
			url: "/__portikus/reset",
			headers: {
				"x-forwarded-host": previewHostFor(5173),
				cookie: `${COOKIE}=${token}; session=abc; cart=42`,
			},
		});
		expect(response.statusCode).toBe(200);
		// Clear-Site-Data cannot clear cookies without signing the student out
		// of Portikus, so each name that arrived is sent back expired.
		expect(response.headers["clear-site-data"]).toBe('"storage"');
		const names = (response.cookies as { name: string; value: string }[]).map(
			(one) => one.name,
		);
		expect(names).toContain("session");
		expect(names).toContain("cart");
		expect(names).toContain(COOKIE);
		for (const cookie of response.cookies as { value: string }[]) {
			expect(cookie.value).toBe("");
		}
		const raw = response.headers["set-cookie"] as string[];
		expect(raw.some((one) => one.startsWith("session=; Path=/; Max-Age=0"))).toBe(true);
	},
);

test.skipIf(skip)("resetting a workspace's previews revokes its sessions", async () => {
	const token = await openPreview(5173);
	const response = await app.inject({
		method: "POST",
		url: `/workspaces/${workspaceId}/preview/reset`,
		headers: csrfHeaders(alice, PUBLIC_URL),
	});
	expect(response.statusCode).toBe(204);
	expect((await authorize(token, previewHostFor(5173))).statusCode).toBe(401);
});

test.skipIf(skip)("reset closes the workspace's loopback forwards", async () => {
	await seedListening([{ port: 3000, previewReachability: "unknown" }]);
	await until(() => agent.listening.get(workspaceId)?.length === 1);
	expect((await grant(alice, workspaceId, 3000)).statusCode).toBe(201);
	expect([...(agent.forwards.get(workspaceId) ?? [])]).toEqual([3000]);

	await until(async () => {
		const seen = await app.inject({
			method: "GET",
			url: `/workspaces/${workspaceId}/listening`,
			headers: { cookie: alice.cookieHeader() },
		});
		return seen.json().services[0]?.previewReachability === "forwarded";
	});

	await app.inject({
		method: "POST",
		url: `/workspaces/${workspaceId}/preview/reset`,
		headers: csrfHeaders(alice, PUBLIC_URL),
	});
	expect([...(agent.forwards.get(workspaceId) ?? [])]).toEqual([]);
});

test.skipIf(skip)("the reset page clears the cookie and stored data", async () => {
	const token = await openPreview(5173);
	const response = await app.inject({
		method: "GET",
		url: "/__portikus/reset",
		headers: {
			"x-forwarded-host": previewHostFor(5173),
			cookie: `${COOKIE}=${token}`,
		},
	});
	expect(response.statusCode).toBe(200);
	expect(response.headers["clear-site-data"]).toBe('"storage"');
	expect(String(response.headers["set-cookie"])).toContain(`${COOKIE}=`);
	expect((await authorize(token, previewHostFor(5173))).statusCode).toBe(401);
});

test.skipIf(skip)(
	"the reset page clears browser data even with no preview cookie",
	async () => {
		// An unauthenticated caller gets the same answer, so the most it can do
		// is clear its own browser's data for this origin
		// (BROWSER-HANDLING.md §16.4).
		const response = await app.inject({
			method: "GET",
			url: "/__portikus/reset",
			headers: { "x-forwarded-host": previewHostFor(5173) },
		});
		expect(response.statusCode).toBe(200);
		expect(response.headers["clear-site-data"]).toBe('"storage"');
		expect(String(response.headers["set-cookie"])).toContain(`${COOKIE}=`);
		expect(response.headers["cache-control"]).toBe("no-store");
		expect(response.headers["referrer-policy"]).toBe("no-referrer");
	},
);

test.skipIf(skip)(
	"a reset with no cookie leaves another browser's session alone",
	async () => {
		const token = await openPreview(5173);
		await app.inject({
			method: "GET",
			url: "/__portikus/reset",
			headers: { "x-forwarded-host": previewHostFor(5173) },
		});
		expect((await authorize(token, previewHostFor(5173))).statusCode).toBe(200);
	},
);

// ── Lifecycle (BROWSER-HANDLING.md §9.2) ──

test.skipIf(skip)("a workspace leaving running revokes its previews", async () => {
	const token = await openPreview(5173);
	await testDb.db
		.updateTable("workspaces")
		.set({ state: "stopped", updated_at: new Date().toISOString() })
		.where("id", "=", workspaceId)
		.execute();
	await until(async () => {
		const rows = await testDb.db
			.selectFrom("preview_sessions")
			.select("revoked_at")
			.execute();
		return rows.every((row) => row.revoked_at !== null);
	});
	// The preview stops working; the student is told why (the stopped page).
	const stopped = await authorize(token, previewHostFor(5173));
	expect(stopped.statusCode).toBe(503);
	expect(stopped.headers["x-portikus-upstream"]).toBeUndefined();

	// Starting the workspace again does not bring the revoked session back.
	await testDb.db
		.updateTable("workspaces")
		.set({ state: "running", updated_at: new Date().toISOString() })
		.where("id", "=", workspaceId)
		.execute();
	expect((await authorize(token, previewHostFor(5173))).statusCode).toBe(401);
});

test.skipIf(skip)("the grant is bound to the session that asked for it", async () => {
	const created = await grant(alice, workspaceId, 5173);
	const grants = await testDb.db
		.selectFrom("preview_grants")
		.select(["session_id", "user_id", "preview_host", "port"])
		.execute();
	expect(grants).toHaveLength(1);
	expect(grants[0]?.preview_host).toBe(previewHostFor(5173));
	expect(grants[0]?.port).toBe(5173);
	// The row carries the hash of the session cookie, never the cookie.
	expect(grants[0]?.session_id).toHaveLength(64);
	expect(grants[0]?.session_id).not.toBe(ticketOf(created.json().bootstrapUrl));
});

test.skipIf(skip)(
	"no request line carries a bootstrap ticket or a preview cookie",
	async () => {
		// A logger of its own, so only this app's lines are read.
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
			const created = await logged.inject({
				method: "POST",
				url: `/workspaces/${workspaceId}/preview-grants`,
				headers: csrfHeaders(jar, PUBLIC_URL),
				payload: { port: 5173, presentation: "embedded" },
			});
			const ticket = ticketOf(created.json().bootstrapUrl);
			const done = await logged.inject({
				method: "GET",
				url: `/__portikus/bootstrap?t=${encodeURIComponent(ticket)}`,
				headers: { "x-forwarded-host": previewHostFor(5173) },
			});
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

			const text = JSON.stringify(lines);
			expect(text).not.toContain(ticket);
			expect(text).not.toContain(token);
			expect(text).not.toContain("?t=");
		} finally {
			await logged.close();
		}
	},
);

test.skipIf(skip)("only the hash of a ticket and a token is stored", async () => {
	const created = await grant(alice, workspaceId, 5173);
	const ticket = ticketOf(created.json().bootstrapUrl);
	const done = await bootstrap(previewHostFor(5173), ticket);
	const token = previewCookie(done);

	const storedTicket = await testDb.db
		.selectFrom("preview_grants")
		.select("ticket_hash")
		.executeTakeFirstOrThrow();
	expect(storedTicket.ticket_hash).toBe(hashToken(ticket));
	expect(storedTicket.ticket_hash).not.toBe(ticket);

	const storedToken = await testDb.db
		.selectFrom("preview_sessions")
		.select("token_hash")
		.executeTakeFirstOrThrow();
	expect(storedToken.token_hash).toBe(hashToken(token));
	expect(storedToken.token_hash).not.toBe(token);
});

// ── The same-origin port bridge (BROWSER-HANDLING.md §14, pattern 2) ──

/** Authorize a request whose path asks the bridge for another port. */
async function bridge(token: string, uri: string) {
	return authorize(token, previewHostFor(5173), {
		extra: { "x-forwarded-uri": uri },
	});
}

/** Wait until the registry lists this many ports for the workspace. */
async function listeningPorts(count: number): Promise<void> {
	await until(async () => {
		const seen = await app.inject({
			method: "GET",
			url: `/workspaces/${workspaceId}/listening`,
			headers: { cookie: alice.cookieHeader() },
		});
		return seen.json().services.length === count;
	});
}

test.skipIf(skip)(
	"the bridge authorizes another port of the same workspace",
	async () => {
		await seedListening([{ port: 5173 }, { port: 8000 }]);
		await listeningPorts(2);
		const token = await openPreview(5173);

		const response = await bridge(token, "/__portikus/ports/8000/api/users?q=1");
		expect(response.statusCode).toBe(200);
		expect(response.headers["x-portikus-upstream"]).toBe("127.0.0.1:8000");
	},
);

test.skipIf(skip)(
	"a request without the prefix still serves the session's own port",
	async () => {
		await seedListening([{ port: 5173 }, { port: 8000 }]);
		await listeningPorts(2);
		const token = await openPreview(5173);

		const response = await bridge(token, "/api/users");
		expect(response.statusCode).toBe(200);
		expect(response.headers["x-portikus-upstream"]).toBe("127.0.0.1:5173");
	},
);

test.skipIf(skip)("the bridge refuses a denied port", async () => {
	await seedListening([{ port: 5173 }, { port: 22 }]);
	await listeningPorts(2);
	const token = await openPreview(5173);

	const response = await bridge(token, "/__portikus/ports/22/");
	expect(response.statusCode).toBe(403);
	expect(response.headers["x-portikus-upstream"]).toBeUndefined();
});

test.skipIf(skip)("the bridge explains a port with nothing listening", async () => {
	const token = await openPreview(5173);
	const response = await bridge(token, "/__portikus/ports/4000/api");
	expect(response.statusCode).toBe(503);
	expect(response.body).toContain("Nothing is currently listening on port 4000");
	expect(response.headers["x-portikus-upstream"]).toBeUndefined();
});

test.skipIf(skip)("the bridge never reaches another workspace's port", async () => {
	const bobWorkspace = (
		await app.inject({
			method: "POST",
			url: "/workspaces",
			headers: csrfHeaders(bob, PUBLIC_URL),
		})
	).json().id;
	await testDb.db
		.updateTable("workspaces")
		.set({
			state: "running",
			agent_address: "127.0.0.1",
			agent_token: `${AGENT_TOKEN}:${bobWorkspace}`,
			updated_at: new Date().toISOString(),
		})
		.where("id", "=", bobWorkspace)
		.execute();
	await fetch(`http://127.0.0.1:${agent.port}/__test/listening`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ key: bobWorkspace, services: [{ port: 9000 }] }),
	});
	await until(async () => {
		const seen = await app.inject({
			method: "GET",
			url: `/workspaces/${bobWorkspace}/listening`,
			headers: { cookie: bob.cookieHeader() },
		});
		return seen.json().services.length === 1;
	});

	const token = await openPreview(5173);
	const response = await bridge(token, "/__portikus/ports/9000/api");
	expect(response.statusCode).toBe(503);
	expect(response.headers["x-portikus-upstream"]).toBeUndefined();
});

test.skipIf(skip)("a malformed bridge path is refused", async () => {
	await seedListening([{ port: 5173 }, { port: 8000 }]);
	await listeningPorts(2);
	const token = await openPreview(5173);

	for (const uri of [
		"/__portikus/ports/08000/api",
		"/__portikus/ports/+8000/api",
		"/__portikus/ports/-8000/api",
		"/__portikus/ports/8000x/api",
		"/__portikus/ports/8e3/api",
		"/__portikus/ports/65536/api",
		"/__portikus/ports/0/api",
		"/__portikus/ports/8000",
		"/__portikus/ports/",
	]) {
		const response = await bridge(token, uri);
		expect({ uri, status: response.statusCode }).toEqual({ uri, status: 403 });
		expect(response.headers["x-portikus-upstream"]).toBeUndefined();
	}
});

test.skipIf(skip)(
	"the bridge upstream still comes only from the workspace row (SPEC 24.7)",
	async () => {
		await seedListening([{ port: 5173 }, { port: 8000 }]);
		await listeningPorts(2);
		const token = await openPreview(5173);

		const response = await authorize(token, previewHostFor(5173), {
			extra: {
				"x-forwarded-uri": "/__portikus/ports/8000/api",
				"x-portikus-upstream": "169.254.169.254:80",
				"x-forwarded-for": "169.254.169.254",
				host: "169.254.169.254",
			},
		});
		expect(response.statusCode).toBe(200);
		expect(response.headers["x-portikus-upstream"]).toBe("127.0.0.1:8000");
	},
);

test.skipIf(skip)("a loopback-only bridge port gets a forward", async () => {
	await seedListening([{ port: 5173 }, { port: 3000, previewReachability: "unknown" }]);
	await listeningPorts(2);
	const token = await openPreview(5173);

	const response = await bridge(token, "/__portikus/ports/3000/api");
	expect(response.statusCode).toBe(200);
	expect(response.headers["x-portikus-upstream"]).toBe("127.0.0.1:3000");
	expect([...(agent.forwards.get(workspaceId) ?? [])]).toEqual([3000]);
});

test.skipIf(skip)("a workspace may not hold open forwards without end", async () => {
	const ports = [3001, 3002, 3003, 3004, 3005, 3006, 3007, 3008, 3009];
	await seedListening([
		{ port: 5173 },
		...ports.map((port) => ({ port, previewReachability: "unknown" as const })),
	]);
	await listeningPorts(ports.length + 1);
	const token = await openPreview(5173);

	for (const port of ports.slice(0, 8)) {
		expect((await bridge(token, `/__portikus/ports/${port}/api`)).statusCode).toBe(200);
	}
	expect([...(agent.forwards.get(workspaceId) ?? [])]).toHaveLength(8);

	// The ninth is refused, and the student is told rather than proxied.
	const refused = await bridge(token, "/__portikus/ports/3009/api");
	expect(refused.statusCode).toBe(503);
	expect(refused.headers["x-portikus-upstream"]).toBeUndefined();

	// A grant for that port is refused the same way.
	const denied = await grant(alice, workspaceId, 3009);
	expect(denied.statusCode).toBe(409);
	expect(denied.json().code).toBe("PREVIEW_FORWARD_FAILED");
	expect([...(agent.forwards.get(workspaceId) ?? [])]).toHaveLength(8);
});

test.skipIf(skip)("a bridge forward closes when the port stops listening", async () => {
	await seedListening([{ port: 5173 }, { port: 3000, previewReachability: "unknown" }]);
	await listeningPorts(2);
	const token = await openPreview(5173);
	expect((await bridge(token, "/__portikus/ports/3000/api")).statusCode).toBe(200);
	expect([...(agent.forwards.get(workspaceId) ?? [])]).toEqual([3000]);

	await seedListening([{ port: 5173 }]);
	await until(() => (agent.forwards.get(workspaceId)?.size ?? 0) === 0);
});

test.skipIf(skip)(
	"a bridge forward stays open while another session is using it",
	async () => {
		await seedListening([
			{ port: 5173 },
			{ port: 3000, previewReachability: "unknown" },
		]);
		await listeningPorts(2);
		const first = await openPreview(5173);
		const second = await openPreview(5173);
		expect((await bridge(first, "/__portikus/ports/3000/api")).statusCode).toBe(200);
		expect((await bridge(second, "/__portikus/ports/3000/api")).statusCode).toBe(200);
		expect([...(agent.forwards.get(workspaceId) ?? [])]).toEqual([3000]);

		// The first session ends; the second is still bridging that port.
		const reset = await app.inject({
			method: "GET",
			url: "/__portikus/reset",
			headers: {
				"x-forwarded-host": previewHostFor(5173),
				cookie: `${COOKIE}=${first}`,
			},
		});
		expect(reset.statusCode).toBe(200);
		expect([...(agent.forwards.get(workspaceId) ?? [])]).toEqual([3000]);
		expect((await bridge(second, "/__portikus/ports/3000/api")).statusCode).toBe(200);
	},
);

test.skipIf(skip)("a bridge forward closes when the preview session ends", async () => {
	await seedListening([{ port: 5173 }, { port: 3000, previewReachability: "unknown" }]);
	await listeningPorts(2);
	const token = await openPreview(5173);
	expect((await bridge(token, "/__portikus/ports/3000/api")).statusCode).toBe(200);
	expect([...(agent.forwards.get(workspaceId) ?? [])]).toEqual([3000]);

	const reset = await app.inject({
		method: "GET",
		url: "/__portikus/reset",
		headers: {
			"x-forwarded-host": previewHostFor(5173),
			cookie: `${COOKIE}=${token}`,
		},
	});
	expect(reset.statusCode).toBe(200);
	expect([...(agent.forwards.get(workspaceId) ?? [])]).toEqual([]);
	expect((await bridge(token, "/__portikus/ports/3000/api")).statusCode).toBe(401);
});
