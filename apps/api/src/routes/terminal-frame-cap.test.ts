import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
	CookieJar,
	csrfHeaders,
	loginAs,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, expect, test } from "vitest";
import { WebSocketServer } from "ws";
import { buildTestServer, PUBLIC_URL } from "../test-support.js";

/**
 * The agent runs as the student, who can replace it (ADR 0009), so a frame
 * it sends on a terminal attach is untrusted and must be size-capped before
 * the API buffers it (SPEC.md §24.1, §9.7).
 */

const skip = !hasTestDb();
const AGENT_TOKEN = "hostile-agent-token";
const MIB = 1024 * 1024;

let testDb: TestDb;
let mock: MockOidcProvider;
let app: FastifyInstance;
let hostileServer: Server;
let hostilePort: number;
/** Terminal ids whose attach answers with one 8 MiB frame; others echo. */
const hostileTerminals = new Set<string>();

function startHostileAgent(): Promise<void> {
	hostileServer = createServer((_req, res) => {
		res.statusCode = 404;
		res.end();
	});
	const sockets = new WebSocketServer({ server: hostileServer });
	sockets.on("connection", (socket, request) => {
		const id = /\/terminals\/([^/]+)\/attach/.exec(request.url ?? "")?.[1] ?? "";
		if (hostileTerminals.has(id)) {
			socket.send("x".repeat(8 * MIB));
			return;
		}
		socket.send("ready");
		socket.on("message", (data) => socket.send(`echo:${data.toString()}`));
	});
	return new Promise((resolve) => {
		hostileServer.listen(0, "127.0.0.1", () => {
			hostilePort = (hostileServer.address() as AddressInfo).port;
			resolve();
		});
	});
}

async function runningWorkspace(jar: CookieJar): Promise<string> {
	const id = (
		await app.inject({
			method: "POST",
			url: "/workspaces",
			headers: csrfHeaders(jar, PUBLIC_URL),
		})
	).json().id;
	await testDb.db
		.updateTable("workspaces")
		.set({ state: "running", agent_address: "127.0.0.1", agent_token: AGENT_TOKEN })
		.where("id", "=", id)
		.execute();
	return id;
}

async function terminalRow(workspaceId: string): Promise<string> {
	const row = await testDb.db
		.insertInto("terminals")
		.values({
			workspace_id: workspaceId,
			name: "t",
			cwd: "/home/student",
			project_id: null,
			agent: null,
			baseline_object_id: null,
			baseline_head: null,
			ended_at: null,
		})
		.returning("id")
		.executeTakeFirstOrThrow();
	return row.id;
}

interface BrowserSocket {
	ws: WebSocket;
	frames: string[];
	next: () => Promise<string>;
	closed: Promise<{ code: number; reason: string }>;
}

async function browserSocket(
	workspaceId: string,
	terminalId: string,
	jar: CookieJar,
): Promise<BrowserSocket> {
	const port = (app.server.address() as AddressInfo).port;
	const ws = new WebSocket(
		`ws://127.0.0.1:${port}/workspaces/${workspaceId}/terminals/${terminalId}/ws?cols=80&rows=24`,
		{
			headers: { origin: new URL(PUBLIC_URL).origin, cookie: jar.cookieHeader() },
		} as unknown as string[],
	);
	const frames: string[] = [];
	const waiting: Array<(frame: string) => void> = [];
	ws.addEventListener("message", (event) => {
		const frame = String(event.data);
		frames.push(frame);
		waiting.shift()?.(frame);
	});
	const closed = new Promise<{ code: number; reason: string }>((resolve) => {
		ws.addEventListener("close", (event) =>
			resolve({ code: event.code, reason: event.reason }),
		);
	});
	await new Promise<void>((resolve, reject) => {
		ws.addEventListener("open", () => resolve(), { once: true });
		ws.addEventListener("error", () => reject(new Error("socket refused")), {
			once: true,
		});
	});
	return {
		ws,
		frames,
		closed,
		next: () => new Promise((resolve) => waiting.push(resolve)),
	};
}

beforeAll(async () => {
	if (skip) return;
	testDb = await createTestDb();
	mock = await startMockOidcProvider({ redirectUris: [`${PUBLIC_URL}/auth/callback`] });
	await startHostileAgent();
});

afterAll(async () => {
	if (skip) return;
	await testDb.close();
	await mock.close();
	await new Promise((resolve) => hostileServer.close(resolve));
});

beforeEach(async () => {
	if (skip) return;
	await testDb.truncate();
	hostileTerminals.clear();
	app = buildTestServer(testDb.db, mock.issuer, { AGENT_PORT: hostilePort });
	await app.listen({ port: 0, host: "127.0.0.1" });
	return async () => {
		await app.close();
	};
});

test.skipIf(skip)(
	"an oversized terminal frame from the agent is not relayed and the API stays up",
	async () => {
		const alice = new CookieJar();
		await loginAs(app, "alice", alice);
		const bob = new CookieJar();
		await loginAs(app, "bob", bob);
		const aliceWorkspace = await runningWorkspace(alice);
		const bobWorkspace = await runningWorkspace(bob);

		// Bob's terminal is open before Alice's agent turns hostile.
		const bobSocket = await browserSocket(
			bobWorkspace,
			await terminalRow(bobWorkspace),
			bob,
		);
		expect(await bobSocket.next()).toBe("ready");

		const hostile = await terminalRow(aliceWorkspace);
		hostileTerminals.add(hostile);
		const socket = await browserSocket(aliceWorkspace, hostile, alice);
		const outcome = await Promise.race([
			socket.closed,
			new Promise((resolve) => setTimeout(() => resolve("still open"), 2000)),
		]);
		expect(socket.frames.every((frame) => frame.length <= MIB)).toBe(true);
		// The same words the events socket uses when its agent frame is too big.
		expect(outcome).toEqual({ code: 1011, reason: "agent unavailable" });

		const health = await app.inject({ method: "GET", url: "/health" });
		expect(health.statusCode).toBe(200);
		bobSocket.ws.send("hi");
		expect(await bobSocket.next()).toBe("echo:hi");
		bobSocket.ws.close();
	},
);
