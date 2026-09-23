import websocket from "@fastify/websocket";
import {
	CookieJar,
	csrfHeaders,
	loginAs,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import {
	MAX_CHECKS_PER_PROJECT,
	MAX_SEARCH_MATCHES,
	MAX_UPLOAD_BYTES,
} from "@portikus/contracts";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import Fastify, { type FastifyInstance } from "fastify";
import {
	afterAll,
	beforeAll,
	beforeEach,
	expect,
	onTestFinished,
	test,
	vi,
} from "vitest";
import WebSocketClient from "ws";
import { AGENT_TIMEOUT_MS } from "../agent-client.js";
import { buildTestServer, PUBLIC_URL } from "../test-support.js";

/**
 * The API against a hostile workspace agent. The agent runs as the student
 * and its token is readable by that user, so anything it says is untrusted
 * (ADR 0009, BROWSER-HANDLING.md §11.2, SPEC.md §24.1). Each test sets how
 * this small agent misbehaves and checks the API neither crashes, hangs past
 * its timeouts, buffers past its limits, reaches another user, nor names a
 * preview upstream other than the workspace's own address.
 */

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 });

const skip = !hasTestDb();
const TOKEN = "hostile-agent-token";
const MIB = 1024 * 1024;
const SUFFIX = "preview.localhost";

/** What the hostile agent answers. Each test sets only what it needs. */
interface Behaviour {
	createTerminal: "ok" | "slow" | "huge";
	checks: unknown;
	search: unknown;
	/** Sent once to every terminal attachment. */
	attachFrame: string | null;
	/** Sent once to every project events socket. */
	eventsFrame: string | null;
	/** Sent over and over on the listening events socket. */
	listeningFrame: string | null;
	forwardAddress: string;
}

function calm(): Behaviour {
	return {
		createTerminal: "ok",
		checks: { checks: [], error: null, runs: [] },
		search: { matches: [], truncated: false },
		attachFrame: null,
		eventsFrame: null,
		listeningFrame: null,
		forwardAddress: "127.0.0.1",
	};
}

interface HostileAgent {
	app: FastifyInstance;
	port: number;
	behaviour: Behaviour;
	/** Paths the agent was called on, newest last. */
	calls: string[];
}

/** A tiny agent on `host`, speaking just enough of the agent API to lie. */
async function startHostileAgent(host: string, port = 0): Promise<HostileAgent> {
	const app = Fastify();
	const agent: HostileAgent = { app, port: 0, behaviour: calm(), calls: [] };
	// Slow answers are left hanging; close them with the server.
	const hanging = new Set<() => void>();
	app.addHook("onClose", async () => {
		for (const finish of hanging) finish();
	});
	app.addHook("onRequest", async (request, reply) => {
		agent.calls.push(request.url);
		if (request.headers.authorization !== `Bearer ${TOKEN}`) {
			return reply.status(401).send();
		}
	});
	await app.register(websocket, { options: { maxPayload: 64 * MIB } });

	app.post("/terminals", async (_request, reply) => {
		switch (agent.behaviour.createTerminal) {
			case "slow":
				await new Promise<void>((resolve) => hanging.add(resolve));
				return reply.status(204).send();
			case "huge":
				return reply
					.header("content-type", "application/json")
					.send(`{"baselineObjectId":"${"a".repeat(2 * MIB)}"}`);
			default:
				return reply.status(201).send({});
		}
	});
	app.delete("/terminals/:id", async (_request, reply) => reply.status(204).send());
	app.get("/projects/:slug/checks", async (_request, reply) => {
		const body = agent.behaviour.checks;
		if (typeof body !== "string") return body;
		return reply.header("content-type", "application/json").send(body);
	});
	app.get("/projects/:slug/search", async () => agent.behaviour.search);
	app.get("/projects/:slug/archive", async (_request, reply) =>
		reply.header("content-type", "application/zip").send(Buffer.alloc(64 * MIB)),
	);
	app.post("/forwards", async (request) => ({
		port: (request.body as { port: number }).port,
		address: agent.behaviour.forwardAddress,
		state: "open",
	}));
	app.get("/terminals/:id/attach", { websocket: true }, (socket) => {
		if (agent.behaviour.attachFrame !== null) socket.send(agent.behaviour.attachFrame);
	});
	app.get("/projects/:slug/events", { websocket: true }, (socket) => {
		if (agent.behaviour.eventsFrame !== null) socket.send(agent.behaviour.eventsFrame);
	});
	app.get("/listening/events", { websocket: true }, (socket) => {
		// The API may connect before a test sets the list, so keep repeating it.
		const timer = setInterval(() => {
			if (agent.behaviour.listeningFrame !== null) {
				socket.send(agent.behaviour.listeningFrame);
			}
		}, 50);
		socket.on("close", () => clearInterval(timer));
	});

	await app.listen({ port, host });
	const address = app.server.address();
	agent.port = typeof address === "object" && address ? address.port : 0;
	return agent;
}

let testDb: TestDb;
let mock: MockOidcProvider;
let hostile: HostileAgent;
let app: FastifyInstance;
let alice: CookieJar;
let bob: CookieJar;
let workspaceId: string;
let projectId: string;

async function createWorkspace(jar: CookieJar, address: string): Promise<string> {
	const id = (
		await app.inject({
			method: "POST",
			url: "/workspaces",
			headers: csrfHeaders(jar, PUBLIC_URL),
		})
	).json().id as string;
	await testDb.db
		.updateTable("workspaces")
		.set({
			state: "running",
			agent_address: address,
			agent_token: TOKEN,
			updated_at: new Date().toISOString(),
		})
		.where("id", "=", id)
		.execute();
	return id;
}

async function createProject(id: string, slug: string): Promise<string> {
	const row = await testDb.db
		.insertInto("projects")
		.values({
			workspace_id: id,
			slug,
			name: slug,
			path: `/home/student/projects/${slug}`,
			source: "new",
		})
		.returning("id")
		.executeTakeFirstOrThrow();
	return row.id;
}

/** A terminal row the API believes in, without asking the agent. */
async function createTerminalRow(id: string): Promise<string> {
	const row = await testDb.db
		.insertInto("terminals")
		.values({ workspace_id: id, name: "Terminal", cwd: "/home/student" })
		.returning("id")
		.executeTakeFirstOrThrow();
	return row.id;
}

async function healthy(): Promise<void> {
	const response = await app.inject({ method: "GET", url: "/health" });
	expect(response.statusCode).toBe(200);
}

interface BrowserSocket {
	frames: Buffer[];
	closed: Promise<number>;
	ws: WebSocketClient;
}

/** A browser socket through the API. Resolves once open, or with its close. */
async function browserSocket(path: string, jar: CookieJar): Promise<BrowserSocket> {
	const address = app.server.address();
	const port = typeof address === "object" && address ? address.port : 0;
	const ws = new WebSocketClient(`ws://127.0.0.1:${port}${path}`, {
		headers: { origin: new URL(PUBLIC_URL).origin, cookie: jar.cookieHeader() },
		// The browser side accepts anything, so the test sees what the API sent.
		maxPayload: 64 * MIB,
	});
	const frames: Buffer[] = [];
	ws.on("message", (data) => frames.push(Buffer.from(data as Buffer)));
	const closed = new Promise<number>((resolve) => ws.on("close", resolve));
	await new Promise<void>((resolve, reject) => {
		ws.on("open", () => resolve());
		ws.on("error", reject);
	});
	return { frames, closed, ws };
}

beforeAll(async () => {
	if (skip) return;
	testDb = await createTestDb();
	mock = await startMockOidcProvider({
		redirectUris: [`${PUBLIC_URL}/auth/callback`],
	});
	hostile = await startHostileAgent("127.0.0.1");
});

afterAll(async () => {
	if (skip) return;
	await hostile.app.close();
	await testDb.close();
	await mock.close();
});

beforeEach(async () => {
	if (skip) return;
	await testDb.truncate();
	hostile.behaviour = calm();
	hostile.calls.length = 0;
	app = buildTestServer(testDb.db, mock.issuer, { AGENT_PORT: hostile.port });
	await app.listen({ port: 0, host: "127.0.0.1" });
	alice = new CookieJar();
	bob = new CookieJar();
	await loginAs(app, "alice", alice);
	await loginAs(app, "bob", bob);
	workspaceId = await createWorkspace(alice, "127.0.0.1");
	projectId = await createProject(workspaceId, "essay");
	return async () => {
		await app.close();
	};
});

function createTerminal() {
	return app.inject({
		method: "POST",
		url: `/workspaces/${workspaceId}/terminals`,
		headers: csrfHeaders(alice, PUBLIC_URL),
		payload: {},
	});
}

test.skipIf(skip)("an oversized agent answer is refused, not buffered", async () => {
	hostile.behaviour.createTerminal = "huge";
	const response = await createTerminal();
	expect(response.statusCode).toBe(503);
	expect(response.body).not.toContain("aaaa");
	await healthy();
});

test.skipIf(skip)("a malformed agent answer is refused", async () => {
	hostile.behaviour.checks = "{not json";
	const response = await app.inject({
		method: "GET",
		url: `/workspaces/${workspaceId}/projects/${projectId}/checks`,
		headers: { cookie: alice.cookieHeader() },
	});
	expect(response.statusCode).toBe(503);
	expect(response.body).not.toContain("not json");
	await healthy();
});

test.skipIf(skip)("a silent agent is given up on after the call timeout", async () => {
	hostile.behaviour.createTerminal = "slow";
	const started = Date.now();
	const response = await createTerminal();
	const took = Date.now() - started;
	expect(response.statusCode).toBe(503);
	expect(took).toBeGreaterThanOrEqual(AGENT_TIMEOUT_MS - 100);
	expect(took).toBeLessThan(AGENT_TIMEOUT_MS + 3000);
	await healthy();
});

test.skipIf(skip)("checks the contract refuses become a 503", async () => {
	hostile.behaviour.checks = { checks: "all of them", error: null, runs: [] };
	const response = await app.inject({
		method: "GET",
		url: `/workspaces/${workspaceId}/projects/${projectId}/checks`,
		headers: { cookie: alice.cookieHeader() },
	});
	expect(response.statusCode).toBe(503);
	expect(response.body).not.toContain("all of them");
});

test.skipIf(skip)(
	"the API relays at most MAX_CHECKS_PER_PROJECT checks from an agent (SPEC.md §18.1, §24.1)",
	async () => {
		const check = (n: number) => ({ id: `c${n}`, name: `Check ${n}`, command: "true" });
		hostile.behaviour.checks = {
			checks: Array.from({ length: MAX_CHECKS_PER_PROJECT + 1 }, (_, n) => check(n)),
			error: null,
			runs: [],
		};
		const response = await app.inject({
			method: "GET",
			url: `/workspaces/${workspaceId}/projects/${projectId}/checks`,
			headers: { cookie: alice.cookieHeader() },
		});
		// More than MAX_CHECKS_PER_PROJECT fails the response schema, so the
		// API refuses the whole answer rather than relaying it.
		expect(response.statusCode).toBe(503);
	},
);

test.skipIf(skip)(
	"the API relays at most MAX_SEARCH_MATCHES matches from an agent (SPEC.md §11.5, §24.1)",
	async () => {
		const match = (n: number) => ({
			path: "a.txt",
			line: n + 1,
			column: 1,
			text: "x",
			before: [],
			after: [],
		});
		hostile.behaviour.search = {
			matches: Array.from({ length: 2000 }, (_, n) => match(n)),
			truncated: false,
		};
		const response = await app.inject({
			method: "GET",
			url: `/workspaces/${workspaceId}/projects/${projectId}/search?q=x`,
			headers: { cookie: alice.cookieHeader() },
		});
		expect(response.statusCode).toBe(200);
		expect(response.json().matches).toHaveLength(MAX_SEARCH_MATCHES);
		expect(response.json().truncated).toBe(true);
	},
);

test.skipIf(skip)(
	"an oversized events frame from the agent closes the pipe",
	async () => {
		hostile.behaviour.eventsFrame = "x".repeat(2 * MIB);
		const socket = await browserSocket(
			`/workspaces/${workspaceId}/projects/${projectId}/events`,
			alice,
		);
		await socket.closed;
		expect(socket.frames.every((frame) => frame.length <= MIB)).toBe(true);
		await healthy();
	},
);

test.skipIf(skip)(
	"a listening list cannot name another workspace or address",
	async () => {
		// Bob's workspace has its own, quiet agent on another loopback address.
		const bobAgent = await startHostileAgent("127.0.0.2", hostile.port);
		onTestFinished(() => bobAgent.app.close());
		const bobWorkspace = await createWorkspace(bob, "127.0.0.2");
		hostile.behaviour.listeningFrame = JSON.stringify({
			type: "workspace.listening-services.changed",
			observedAt: new Date().toISOString(),
			services: [
				{
					// The agent is never told a workspace id; one it makes up is dropped.
					workspaceId: bobWorkspace,
					port: 5173,
					addresses: ["10.9.9.9"],
					protocolHint: "http",
					previewReachability: "reachable",
					observedAt: new Date().toISOString(),
				},
				{
					port: 22,
					addresses: ["0.0.0.0"],
					protocolHint: "unknown",
					previewReachability: "reachable",
					observedAt: new Date().toISOString(),
				},
			],
		});
		const listed = async (jar: CookieJar, id: string) =>
			(
				await app.inject({
					method: "GET",
					url: `/workspaces/${id}/listening`,
					headers: { cookie: jar.cookieHeader() },
				})
			).json().services as {
				workspaceId: string;
				port: number;
				previewReachability: string;
			}[];

		await expect
			.poll(async () => (await listed(alice, workspaceId)).length, { timeout: 5000 })
			.toBe(2);
		const services = await listed(alice, workspaceId);
		for (const service of services) expect(service.workspaceId).toBe(workspaceId);
		expect(services.find((service) => service.port === 22)?.previewReachability).toBe(
			"denied",
		);

		// Alice's preview, opened through the grant and bootstrap, has the
		// workspace row's address as its upstream, whatever the agent claimed.
		await testDb.db
			.updateTable("workspaces")
			.set({ label: "tw7" })
			.where("id", "=", workspaceId)
			.execute();
		const grant = await app.inject({
			method: "POST",
			url: `/workspaces/${workspaceId}/preview-grants`,
			headers: csrfHeaders(alice, PUBLIC_URL),
			payload: { port: 5173, presentation: "embedded" },
		});
		expect(grant.statusCode).toBe(201);
		const ticket = new URL(grant.json().bootstrapUrl).searchParams.get("t") ?? "";
		const host = `tw7-5173.${SUFFIX}`;
		const booted = await app.inject({
			method: "GET",
			url: `/__portikus/bootstrap?t=${encodeURIComponent(ticket)}`,
			headers: { "x-forwarded-host": host },
		});
		expect(booted.statusCode).toBe(303);
		const cookie = (booted.cookies as { name: string; value: string }[]).find(
			(one) => one.name === "portikus-preview",
		);
		const authorized = await app.inject({
			method: "GET",
			url: "/preview/authorize",
			remoteAddress: "127.0.0.1",
			headers: {
				"x-forwarded-host": host,
				"x-forwarded-proto": "https",
				cookie: `portikus-preview=${cookie?.value}`,
			},
		});
		expect(authorized.statusCode).toBe(200);
		expect(authorized.headers["x-portikus-upstream"]).toBe("127.0.0.1:5173");

		// Bob's workspace heard nothing from Alice's agent's list.
		expect(await listed(bob, bobWorkspace)).toEqual([]);
	},
);

test.skipIf(skip)(
	"a forward the agent claims on another address changes no upstream",
	async () => {
		hostile.behaviour.forwardAddress = "10.9.9.9";
		hostile.behaviour.listeningFrame = JSON.stringify({
			type: "workspace.listening-services.changed",
			observedAt: new Date().toISOString(),
			services: [
				{
					port: 3000,
					addresses: ["127.0.0.1"],
					protocolHint: "http",
					previewReachability: "unknown",
					observedAt: new Date().toISOString(),
				},
			],
		});
		await testDb.db
			.updateTable("workspaces")
			.set({ label: "tw7" })
			.where("id", "=", workspaceId)
			.execute();
		await expect
			.poll(
				async () =>
					(
						await app.inject({
							method: "GET",
							url: `/workspaces/${workspaceId}/listening`,
							headers: { cookie: alice.cookieHeader() },
						})
					).json().services.length,
				{ timeout: 5000 },
			)
			.toBe(1);
		const grant = await app.inject({
			method: "POST",
			url: `/workspaces/${workspaceId}/preview-grants`,
			headers: csrfHeaders(alice, PUBLIC_URL),
			payload: { port: 3000, presentation: "embedded" },
		});
		expect(hostile.calls.some((path) => path.startsWith("/forwards"))).toBe(true);
		expect(grant.statusCode).toBe(201);
		const host = `tw7-3000.${SUFFIX}`;
		const ticket = new URL(grant.json().bootstrapUrl).searchParams.get("t") ?? "";
		const booted = await app.inject({
			method: "GET",
			url: `/__portikus/bootstrap?t=${encodeURIComponent(ticket)}`,
			headers: { "x-forwarded-host": host },
		});
		const cookie = (booted.cookies as { name: string; value: string }[]).find(
			(one) => one.name === "portikus-preview",
		);
		const authorized = await app.inject({
			method: "GET",
			url: "/preview/authorize",
			remoteAddress: "127.0.0.1",
			headers: {
				"x-forwarded-host": host,
				"x-forwarded-proto": "https",
				cookie: `portikus-preview=${cookie?.value}`,
			},
		});
		expect(authorized.statusCode).toBe(200);
		expect(authorized.headers["x-portikus-upstream"]).toBe("127.0.0.1:3000");
	},
);

test.skipIf(skip)(
	"terminal frames reach only the socket the API opened for them",
	async () => {
		// Bob's workspace has its own agent on another loopback address.
		const bobAgent = await startHostileAgent("127.0.0.2", hostile.port);
		try {
			const bobWorkspace = await createWorkspace(bob, "127.0.0.2");
			const bobTerminal = await createTerminalRow(bobWorkspace);
			const aliceTerminal = await createTerminalRow(workspaceId);
			hostile.behaviour.attachFrame = JSON.stringify({
				type: "output",
				terminalId: bobTerminal,
				workspaceId: bobWorkspace,
				data: "from alice's agent",
			});
			const bobSocket = await browserSocket(
				`/workspaces/${bobWorkspace}/terminals/${bobTerminal}/ws?cols=80&rows=24`,
				bob,
			);
			const aliceSocket = await browserSocket(
				`/workspaces/${workspaceId}/terminals/${aliceTerminal}/ws?cols=80&rows=24`,
				alice,
			);
			await expect.poll(() => aliceSocket.frames.length, { timeout: 5000 }).toBe(1);
			await new Promise((resolve) => setTimeout(resolve, 200));
			expect(bobSocket.frames).toEqual([]);
			expect(bobAgent.calls.some((path) => path.includes(aliceTerminal))).toBe(false);
			aliceSocket.ws.close();
			bobSocket.ws.close();
		} finally {
			await bobAgent.app.close();
		}
	},
);

test.fails("KNOWN-VULN #399: a download past the size cap is not relayed in full (SPEC.md §24.1)", async () => {
	if (skip) throw new Error("needs a test database");
	const response = await app.inject({
		method: "GET",
		url: `/workspaces/${workspaceId}/projects/${projectId}/download`,
		headers: { cookie: alice.cookieHeader() },
	});
	// No download cap is chosen yet; the upload cap stands in for one.
	expect(response.rawPayload.length).toBeLessThanOrEqual(MAX_UPLOAD_BYTES);
});
