import {
	MOCK_USERS,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type FakeAgent, startFakeAgent } from "../fake-agent.js";
import {
	buildMatrixWorld,
	buildTestServer,
	DISABLED_MOCK_USER,
	type MatrixWorld,
	PUBLIC_URL,
} from "../test-support.js";
import { type AccessClass, ROUTE_POLICY, splitKey } from "./route-policy.js";

/**
 * The authorization matrix (Epic 12a, "The matrix"; SPEC.md sections 5.2,
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
 * Allowed-caller checks that fail today, with the issue that tracks each
 * (Epic 12a, Part 3). The refusal checks of these routes still run normally.
 */
const KNOWN_VULN: Record<string, string> = {
	"HEAD /workspaces/:id/ws":
		"KNOWN-VULN #402: HEAD on a socket route answers 500, not a clean refusal",
	"HEAD /workspaces/:id/terminals/:tid/ws":
		"KNOWN-VULN #402: HEAD on a socket route answers 500, not a clean refusal",
	"HEAD /workspaces/:id/projects/:pid/events":
		"KNOWN-VULN #402: HEAD on a socket route answers 500, not a clean refusal",
	"HEAD /workspaces/:id/projects/:pid/checks/:checkId/runs/current":
		"KNOWN-VULN #402: HEAD on a socket route answers 500, not a clean refusal",
};

// The smallest PNG: one transparent pixel.
const PIXEL_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
	"base64",
);

let testDb: TestDb;
let mock: MockOidcProvider;
let agent: FakeAgent;

beforeAll(async () => {
	if (skip) return;
	testDb = await createTestDb();
	mock = await startMockOidcProvider({
		users: { ...MOCK_USERS, [DISABLED_MOCK_USER.sub]: DISABLED_MOCK_USER },
	});
	agent = await startFakeAgent(AGENT_TOKEN);
});

afterAll(async () => {
	if (skip) return;
	await testDb.close();
	await mock.close();
	await agent.close();
});

/** A fresh server and world, so one route's writes cannot reach the next. */
async function withWorld(
	run: (app: FastifyInstance, world: MatrixWorld) => Promise<void>,
): Promise<void> {
	await testDb.truncate();
	const app = buildTestServer(testDb.db, mock.issuer, { AGENT_PORT: agent.port });
	await app.ready();
	try {
		await run(app, await buildMatrixWorld(app, testDb.db, AGENT_TOKEN));
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

const QUERIES: Record<string, string> = {
	"/workspaces/:id/projects/:pid/file": "?path=notes.txt",
	"/workspaces/:id/projects/:pid/git/diff": "?path=notes.txt",
	"/workspaces/:id/projects/:pid/baseline-status": `?object=${"a".repeat(40)}`,
	"/workspaces/:id/projects/:pid/baseline-diff": `?object=${"a".repeat(40)}&path=notes.txt`,
	"/workspaces/:id/projects/:pid/search": "?q=secret",
	"/workspaces/:id/preview/embeddable": "?port=5173",
	"/__portikus/bootstrap": "?t=forged-ticket",
};

const PAYLOADS: Record<string, object> = {
	"PUT /me/settings": { timezone: "America/New_York" },
	"PUT /me/profile": { github: null },
	"PUT /admin/settings": { logLevel: null },
	"PUT /admin/users/:id/settings": { shutdownGraceSeconds: null },
	"POST /workspaces/:id/terminals": { name: "another" },
	"PATCH /workspaces/:id/terminals/:tid": { name: "renamed" },
	"POST /workspaces/:id/projects": { name: "another", source: "new" },
	"PATCH /workspaces/:id/projects/:pid": { name: "renamed" },
	"POST /workspaces/:id/projects/:pid/duplicate": { name: "copy" },
	"PUT /workspaces/:id/projects/:pid/layout": {
		tabs: [{ id: "tab-1", root: { type: "leaf", terminalId: crypto.randomUUID() } }],
	},
	"POST /workspaces/:id/projects/:pid/mkdir": { path: "made" },
	"POST /workspaces/:id/projects/:pid/move": { from: "notes.txt", to: "moved.txt" },
	"POST /workspaces/:id/preview-grants": { port: 5173, presentation: "embedded" },
};

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
		.replace(":pid", ids.projectId)
		.replace(":tid", ids.terminalId)
		.replace(":checkId", "lint")
		.replace(":port", "5173")
		.replace("*", "index.html");
	url = pattern.startsWith("/admin/users/:id")
		? url.replace(":id", world.a.userId)
		: url.replace(":id", ids.workspaceId);

	const sample: Sample = { url: `${url}${QUERIES[pattern] ?? ""}`, headers: {} };
	if (pattern.startsWith("/__portikus/") || pattern === "/preview/authorize") {
		// Aim at A's real preview host, so only a session could open it.
		sample.headers.host = `${world.a.label}-5173.preview.localhost`;
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

function actorsOf(world: MatrixWorld) {
	return {
		anonymous: { name: "anonymous", headers: {} },
		a: { name: "student A", headers: { cookie: world.a.jar.cookieHeader() } },
		b: { name: "student B", headers: { cookie: world.b.jar.cookieHeader() } },
		admin: { name: "administrator", headers: { cookie: world.admin.cookieHeader() } },
		disabled: {
			name: "disabled user",
			headers: { cookie: world.disabled.cookieHeader() },
		},
		bearer: {
			name: "A's agent token, no cookie",
			headers: { authorization: `Bearer ${world.a.agentToken}` },
		},
	} satisfies Record<string, Actor>;
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
	expect(res.statusCode < 400 || calls.length > 0, why).toBe(true);
	return res;
}

// --- Done item 1: every route is classified, every class names a route ----

test.skipIf(skip)("every registered route has an access class, and back", async () => {
	const app = buildTestServer(testDb.db, mock.issuer, { AGENT_PORT: agent.port });
	const seen = new Map<string, boolean>();
	app.addHook("onRoute", (route) => {
		const methods = Array.isArray(route.method) ? route.method : [route.method];
		for (const method of methods) {
			seen.set(`${method} ${route.url}`, route.websocket === true);
		}
	});
	await app.ready();
	try {
		const unclassified = [...seen.keys()].filter((key) => !(key in ROUTE_POLICY));
		expect(unclassified, "routes with no class in security/route-policy.ts").toEqual(
			[],
		);

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

// --- Done items 2 and 5: every caller gets its class's answer --------------

const httpKeys = Object.keys(ROUTE_POLICY).filter((key) => {
	// A socket's upgrade is probed in ws-authz-matrix.test.ts.
	return !(ROUTE_POLICY[key]?.websocket && key.startsWith("GET "));
});

const signedInOnly: AccessClass[] = [
	"self",
	"owner",
	"owner-or-admin",
	"admin",
	"inert",
];

describe.skipIf(skip)("refused callers get the class's refusal", () => {
	for (const key of httpKeys) {
		const access = ROUTE_POLICY[key]?.access as AccessClass;

		test(`${key} (${access})`, () =>
			withWorld(async (app, world) => {
				const actors = actorsOf(world);
				const own = sampleFor(key, world, world.a);

				if (UNSAFE.has(splitKey(key).method)) {
					const cookie = world.a.jar.cookieHeader();
					const preview = `https://${world.a.label}-5173.preview.localhost`;
					const noOrigin = { name: "A with no Origin", headers: { cookie } };
					const fromPreview = {
						name: "A from a preview Origin",
						headers: { cookie, origin: preview },
					};
					await expectRefused(app, world, key, own, noOrigin, 403);
					await expectRefused(app, world, key, own, fromPreview, 403);
				}

				if (signedInOnly.includes(access)) {
					for (const actor of [actors.anonymous, actors.disabled, actors.bearer]) {
						await expectRefused(app, world, key, own, withOrigin(key, actor), 401);
					}
				}

				const a = withOrigin(key, actors.a);
				const b = withOrigin(key, actors.b);
				const admin = withOrigin(key, actors.admin);
				if (access === "owner" || access === "owner-or-admin") {
					await expectRefused(app, world, key, own, b, 404);
				}
				if (access === "owner") {
					await expectRefused(app, world, key, own, admin, 404);
				}
				if (access === "admin") {
					await expectRefused(app, world, key, own, a, 403);
					await expectRefused(app, world, key, own, b, 403);
				}
				if (access === "inert") {
					for (const actor of [a, b, admin]) {
						const { res, calls } = await send(app, key, own, actor.headers);
						expect(res.statusCode, `${key} for ${actor.name}`).toBe(501);
						expect(calls).toEqual([]);
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
						expect(
							[stranger.res.statusCode, 401],
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
	return access !== "public" && access !== "preview-edge" && access !== "inert";
});

describe.skipIf(skip)("allowed callers get through", () => {
	for (const key of allowedKeys) {
		const access = ROUTE_POLICY[key]?.access as AccessClass;
		const known = KNOWN_VULN[key];
		const run = known ? test.fails : test;

		run(known ? `${known} (${key})` : `${key} (${access})`, () =>
			withWorld(async (app, world) => {
				const actors = actorsOf(world);
				const own = sampleFor(key, world, world.a);
				const a = withOrigin(key, actors.a);
				const b = withOrigin(key, actors.b);
				const admin = withOrigin(key, actors.admin);

				if (key.includes("/me/picture") && !key.startsWith("PUT ")) {
					// Give every caller a picture of their own to read or remove.
					const put = sampleFor("PUT /me/picture", world, world.a);
					for (const actor of [a, b, admin]) {
						await send(app, "PUT /me/picture", put, withOrigin("PUT x", actor).headers);
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
						await expectAllowed(app, key, own, a);
						break;
					}
					case "owner":
						await expectAllowed(app, key, own, a);
						break;
					case "owner-or-admin":
						await expectAllowed(app, key, own, admin);
						await expectAllowed(app, key, own, a);
						break;
					case "admin":
						await expectAllowed(app, key, own, admin);
						break;
				}
			}),
		);
	}
});

// --- Done item 3: A's workspace with B's child id is a 404 -----------------

const childKeys = httpKeys.filter((key) => /:(pid|tid|checkId)/.test(key));

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
