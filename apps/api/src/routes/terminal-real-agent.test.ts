import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
	CookieJar,
	csrfHeaders,
	loginAs,
	type MockOidcProvider,
	startMockOidcProvider,
} from "@portikus/auth/testing";
import { AgentTerminalList, MAX_INPUT_FRAME_BYTES } from "@portikus/contracts";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import { TerminalServerMessage } from "@portikus/events";
// @ts-expect-error apps/api does not depend on the agent package; the vitest
// alias in vitest.config.ts resolves it from source for this test only.
import { buildServer as buildAgentServer } from "@portikus/workspace-agent";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, expect, test, vi } from "vitest";
import WebSocketClient, { type WebSocket as WsSocket } from "ws";
import { buildTestServer, PUBLIC_URL } from "../test-support.js";

/**
 * The API in front of the REAL workspace agent: a browser socket, the API's
 * byte pipe, the agent, tmux, and a shell (SPEC.md §9.1, §9.2, §9.5, §9.7;
 * ADR 0009). Everything else in the suite runs against the in-memory fake, so
 * this file is the only place the whole chain is exercised.
 */

// Real tmux, real shells, and a real database: slower than the default 5 s.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });

const run = promisify(execFile);

const TOKEN = "b".repeat(64);
// The agent is given this socket name, and the test runs its own tmux
// commands against it, so both share one tmux server that is not the
// developer's own.
const SOCKET_NAME = `portikus-real-${process.pid}`;

async function tmuxAvailable(): Promise<boolean> {
	try {
		await run("tmux", ["-V"]);
		return true;
	} catch {
		return false;
	}
}

const haveTmux = await tmuxAvailable();
const skip = !hasTestDb() || !haveTmux;

let testDb: TestDb;
let mock: MockOidcProvider;
let app: FastifyInstance;
let alice: CookieJar;
let workspaceId: string;
let homeDir: string;
let tokenPath: string;
let agentPort: number;
let agentApp: FastifyInstance;

/** tmux on the test server, so a developer's own sessions are never touched. */
async function tmux(args: string[]): Promise<string> {
	const { stdout } = await run("tmux", ["-L", SOCKET_NAME, ...args]);
	return stdout;
}

async function sessionExists(id: string): Promise<boolean> {
	try {
		await tmux(["has-session", "-t", `pk-${id}`]);
		return true;
	} catch {
		return false;
	}
}

/**
 * Start the real agent: its own Fastify server on a real port, reading its
 * token from a real file, with tmux behind it (ADR 0009). Only the process
 * boundary is missing, and the API still reaches it over TCP.
 */
async function startRealAgent(): Promise<void> {
	agentApp = buildAgentServer({
		tokenPath,
		homeDir,
		tmuxSocketName: SOCKET_NAME,
	}) as FastifyInstance;
	await agentApp.listen({ port: 0, host: "127.0.0.1" });
	agentPort = (agentApp.server.address() as AddressInfo).port;
}

async function makeRunningWorkspace(jar: CookieJar): Promise<string> {
	const id = (
		await app.inject({
			method: "POST",
			url: "/workspaces",
			headers: csrfHeaders(jar, PUBLIC_URL),
		})
	).json().id;
	await testDb.db
		.updateTable("workspaces")
		.set({
			state: "running",
			agent_address: "127.0.0.1",
			agent_token: TOKEN,
			updated_at: new Date().toISOString(),
		})
		.where("id", "=", id)
		.execute();
	return id;
}

async function createTerminal(cwd: string = homeDir) {
	return await app.inject({
		method: "POST",
		url: `/workspaces/${workspaceId}/terminals`,
		headers: csrfHeaders(alice, PUBLIC_URL),
		payload: { cwd },
	});
}

interface Browser {
	ws: WebSocket;
	/** Everything received on binary frames, decoded as text. */
	output: () => string;
	text: unknown[];
	waitFor: (needle: string) => Promise<void>;
	closed: Promise<{ code: number; reason: string }>;
	close: () => Promise<void>;
}

/** Open the browser end of the pipe, on the API, as a signed-in student. */
async function openBrowser(
	tid: string,
	jar: CookieJar = alice,
	query = "?cols=100&rows=30",
): Promise<Browser> {
	const { port } = app.server.address() as AddressInfo;
	const ws = new WebSocket(
		`ws://127.0.0.1:${port}/workspaces/${workspaceId}/terminals/${tid}/ws${query}`,
		{
			headers: { origin: new URL(PUBLIC_URL).origin, cookie: jar.cookieHeader() },
		} as unknown as string[],
	);
	ws.binaryType = "arraybuffer";

	let output = "";
	const text: unknown[] = [];
	const decoder = new TextDecoder();
	const listeners: Array<() => void> = [];

	ws.addEventListener("message", (event) => {
		if (typeof event.data === "string") {
			try {
				text.push(JSON.parse(event.data));
			} catch {
				text.push(event.data);
			}
		} else {
			output += decoder.decode(new Uint8Array(event.data as ArrayBuffer), {
				stream: true,
			});
		}
		for (const notify of listeners.splice(0)) notify();
	});

	const closed = new Promise<{ code: number; reason: string }>((resolve) => {
		ws.addEventListener(
			"close",
			(event) => resolve({ code: event.code, reason: event.reason }),
			{
				once: true,
			},
		);
	});

	await new Promise<void>((resolve, reject) => {
		ws.addEventListener("open", () => resolve(), { once: true });
		ws.addEventListener("error", () => reject(new Error("upgrade refused")), {
			once: true,
		});
	});

	const browser: Browser = {
		ws,
		text,
		output: () => output,
		closed,
		waitFor: (needle) =>
			new Promise<void>((resolve, reject) => {
				const timer = setTimeout(
					() => reject(new Error(`never saw ${needle} in: ${output.slice(-400)}`)),
					10_000,
				);
				const check = () => {
					if (!output.includes(needle)) {
						listeners.push(check);
						return;
					}
					clearTimeout(timer);
					resolve();
				};
				check();
			}),
		close: () =>
			new Promise<void>((resolve) => {
				if (ws.readyState === WebSocket.CLOSED) return resolve();
				ws.addEventListener("close", () => resolve(), { once: true });
				ws.close();
			}),
	};

	// Wait for the shell prompt: input typed while tmux and bash are still
	// starting is swallowed by the terminal, not by the transport.
	await browser.waitFor("$");
	return browser;
}

function type(browser: Browser, data: string): void {
	browser.ws.send(JSON.stringify({ type: "input", data }));
}

beforeAll(async () => {
	if (skip) return;
	homeDir = await mkdtemp(join(tmpdir(), "portikus-real-home-"));
	tokenPath = join(homeDir, "agent.token");
	await writeFile(tokenPath, `${TOKEN}\n`, { mode: 0o600 });
	testDb = await createTestDb();
	mock = await startMockOidcProvider({
		redirectUris: [`${PUBLIC_URL}/auth/callback`],
	});
	await startRealAgent();
});

afterAll(async () => {
	if (skip) return;
	await agentApp.close();
	try {
		await tmux(["kill-server"]);
	} catch {
		// no server left is the normal case
	}
	await testDb.close();
	await mock.close();
});

beforeEach(async () => {
	if (skip) return;
	// The token may have been rotated by a previous test.
	await writeFile(tokenPath, `${TOKEN}\n`, { mode: 0o600 });
	await testDb.truncate();
	app = buildTestServer(testDb.db, mock.issuer, { AGENT_PORT: agentPort });
	await app.listen({ port: 0, host: "127.0.0.1" });
	alice = new CookieJar();
	await loginAs(app, "alice", alice);
	workspaceId = await makeRunningWorkspace(alice);
	return async () => {
		await app.close();
		// Leave no tmux session behind for the next test.
		try {
			const list = await tmux(["list-sessions", "-F", "#{session_name}"]);
			for (const name of list.split("\n")) {
				if (name.startsWith("pk-")) await tmux(["kill-session", "-t", name]);
			}
		} catch {
			// no server running
		}
	};
});

// --- the chain end to end (SPEC.md §9.1, §9.2, §9.5) ---

test.skipIf(skip)(
	"a command typed in the browser runs in the workspace shell",
	async () => {
		const created = await createTerminal();
		expect(created.statusCode).toBe(201);
		const browser = await openBrowser(created.json().id);
		const marker = `MARK-${Math.random().toString(36).slice(2, 10)}`;

		type(browser, `echo ${marker}\r`);
		await browser.waitFor(marker);

		await browser.close();
	},
);

test.skipIf(skip)(
	"a terminal outlives its browser socket and the screen is redrawn on reconnect",
	async () => {
		const id = (await createTerminal()).json().id;
		const marker = `MARK-${Math.random().toString(36).slice(2, 10)}`;

		const first = await openBrowser(id);
		type(first, `echo ${marker}\r`);
		await first.waitFor(marker);
		await first.close();

		// SPEC.md §9.2: the WebSocket does not own the shell, so the session is
		// still there. §9.7 replays no output, but tmux redraws its live screen,
		// which still holds the marker.
		expect(await sessionExists(id)).toBe(true);

		const second = await openBrowser(id);
		await second.waitFor(marker);
		await second.close();
	},
);

test.skipIf(skip)(
	"two browsers share one terminal and one shell process (SPEC.md §9.5)",
	async () => {
		const id = (await createTerminal()).json().id;
		const first = await openBrowser(id);
		const second = await openBrowser(id);
		const marker = `MARK-${Math.random().toString(36).slice(2, 10)}`;

		type(first, `echo ${marker}\r`);
		await first.waitFor(marker);
		await second.waitFor(marker);

		// One tmux pane means one shell: attaching twice must not fork a second
		// process behind what the student sees as one terminal.
		const panes = (await tmux(["list-panes", "-t", `pk-${id}`, "-F", "#{pane_id}"]))
			.trim()
			.split("\n");
		expect(panes).toHaveLength(1);

		const listed = await fetch(`http://127.0.0.1:${agentPort}/terminals`, {
			headers: { authorization: `Bearer ${TOKEN}` },
		});
		const listing = AgentTerminalList.parse(await listed.json());
		expect(listing.terminals[0]?.attachments).toBe(2);

		await first.close();
		await second.close();
	},
);

test.skipIf(skip)("DELETE through the API kills the tmux session", async () => {
	const id = (await createTerminal()).json().id;
	expect(await sessionExists(id)).toBe(true);

	const response = await app.inject({
		method: "DELETE",
		url: `/workspaces/${workspaceId}/terminals/${id}`,
		headers: csrfHeaders(alice, PUBLIC_URL),
	});
	expect(response.statusCode).toBe(204);
	expect(await sessionExists(id)).toBe(false);

	// Closing is a user action, so the row goes with the session (SPEC.md 9.3).
	const row = await testDb.db
		.selectFrom("terminals")
		.selectAll()
		.where("id", "=", id)
		.executeTakeFirst();
	expect(row).toBeUndefined();
});

test.skipIf(skip)(
	"a working directory outside the workspace home is a 400 with no row and no session",
	async () => {
		const response = await createTerminal("/etc");
		expect(response.statusCode).toBe(400);
		expect(response.json().code).toBe("VALIDATION_FAILED");

		const rows = await testDb.db.selectFrom("terminals").selectAll().execute();
		expect(rows).toHaveLength(0);

		const sessions = await fetch(`http://127.0.0.1:${agentPort}/terminals`, {
			headers: { authorization: `Bearer ${TOKEN}` },
		});
		expect(AgentTerminalList.parse(await sessions.json()).terminals).toHaveLength(0);
	},
);

test.skipIf(skip)(
	"rotating the token file locks the control plane out of the agent (ADR 0009)",
	async () => {
		expect((await createTerminal()).statusCode).toBe(201);

		// The agent re-reads the file per request, so the next call fails without
		// the agent restarting.
		await writeFile(tokenPath, `${"c".repeat(64)}\n`, { mode: 0o600 });

		const refused = await createTerminal();
		expect(refused.statusCode).toBe(503);
		expect(refused.json().code).toBe("AGENT_UNAVAILABLE");
	},
);

// --- adversarial frames (SPEC.md §9.7 limits, §24.2) ---

test.skipIf(skip)("an input frame of exactly 64 KiB is accepted", async () => {
	const id = (await createTerminal()).json().id;
	const browser = await openBrowser(id);
	const marker = `MARK-${Math.random().toString(36).slice(2, 10)}`;

	// Fill the frame to the limit exactly. The shell only echoes the marker;
	// what matters is that the socket survives.
	const filler = "#".repeat(MAX_INPUT_FRAME_BYTES - marker.length - 8);
	type(browser, `echo ${marker} ${filler}\r`);
	await browser.waitFor(marker);
	expect(browser.ws.readyState).toBe(WebSocket.OPEN);

	await browser.close();
});

test.skipIf(skip)(
	"an input frame one byte over the limit closes with 1009",
	async () => {
		const id = (await createTerminal()).json().id;
		const browser = await openBrowser(id);

		type(browser, "x".repeat(MAX_INPUT_FRAME_BYTES + 1));
		expect((await browser.closed).code).toBe(1009);
	},
);

test.skipIf(skip)(
	"a text frame that is valid JSON of the wrong shape closes with 1008",
	async () => {
		const id = (await createTerminal()).json().id;
		const browser = await openBrowser(id);

		browser.ws.send(JSON.stringify({ type: "input", data: 42 }));
		expect((await browser.closed).code).toBe(1008);
	},
);

test.skipIf(skip)("a resize outside the allowed range closes with 1008", async () => {
	for (const size of [
		{ cols: 0, rows: 24 },
		{ cols: 5000, rows: 24 },
	]) {
		const id = (await createTerminal()).json().id;
		const browser = await openBrowser(id);
		browser.ws.send(JSON.stringify({ type: "resize", ...size }));
		expect((await browser.closed).code).toBe(1008);
	}
});

test.skipIf(skip)(
	"a binary frame from the browser is treated as its UTF-8 text, not as raw input",
	async () => {
		const id = (await createTerminal()).json().id;
		const browser = await openBrowser(id);
		const marker = `MARK-${Math.random().toString(36).slice(2, 10)}`;

		// SPEC.md §9.7 defines client-to-server frames as text. The agent decodes
		// whatever arrives, so a binary frame carrying the same JSON is accepted.
		// Recorded here so a future change to reject binary input is a deliberate
		// one.
		browser.ws.send(
			Buffer.from(JSON.stringify({ type: "input", data: `echo ${marker}\r` })),
		);
		await browser.waitFor(marker);

		// And binary rubbish is rejected as a malformed frame, not written to the
		// shell.
		browser.ws.send(Buffer.from([0xff, 0xfe, 0x00, 0x01]));
		expect((await browser.closed).code).toBe(1008);
	},
);

test.skipIf(skip)("a tmux-hostile terminal id never reaches tmux", async () => {
	const hostile = "pk-x; kill-server";

	// Through the API: the route validates the id as a UUID before any work.
	const refusedByApi = await app.inject({
		method: "DELETE",
		url: `/workspaces/${workspaceId}/terminals/${encodeURIComponent(hostile)}`,
		headers: csrfHeaders(alice, PUBLIC_URL),
	});
	expect(refusedByApi.statusCode).toBe(400);

	// Straight at the agent, skipping the control plane entirely.
	const created = await fetch(`http://127.0.0.1:${agentPort}/terminals`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${TOKEN}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({ id: hostile, cwd: homeDir }),
	});
	expect(created.status).toBe(400);

	const deleted = await fetch(
		`http://127.0.0.1:${agentPort}/terminals/${encodeURIComponent(hostile)}`,
		{ method: "DELETE", headers: { authorization: `Bearer ${TOKEN}` } },
	);
	expect(deleted.status).toBe(404);

	// The tmux server is still answering and holds no session: nothing was
	// injected into it and `kill-server` was never run.
	const sessions = await tmux(["list-sessions", "-F", "#{session_name}"]).catch(
		() => "",
	);
	expect(sessions).not.toContain("pk-x");
});

// --- error frames must match the published protocol (SPEC.md §9.7) ---

test.skipIf(skip)("a malformed frame gets an error the contract allows", async () => {
	const id = (await createTerminal()).json().id;
	const browser = await openBrowser(id);

	browser.ws.send("not json at all");
	await browser.closed;

	// SPEC.md §9.7 says server-to-client text frames are {"type":"error",
	// "code":"…"}, and TerminalServerMessage in packages/events is the contract
	// for that code. BAD_FRAME is now part of it.
	expect(TerminalServerMessage.safeParse(browser.text[0]).success).toBe(true);
});

// --- backpressure (SPEC.md §9.7) ---

test.skipIf(skip)(
	"a runaway process does not fill the API while the browser stalls",
	async () => {
		const id = (await createTerminal()).json().id;

		// The `ws` client is used here, not the global WebSocket, because only it
		// exposes the TCP socket this test has to stall.
		const { port } = app.server.address() as AddressInfo;
		const browser = new WebSocketClient(
			`ws://127.0.0.1:${port}/workspaces/${workspaceId}/terminals/${id}/ws?cols=200&rows=50`,
			{ headers: { origin: new URL(PUBLIC_URL).origin, cookie: alice.cookieHeader() } },
		);
		let seen = "";
		browser.on("message", (data: Buffer) => {
			seen += data.toString();
		});
		await new Promise<void>((resolve) => browser.once("open", resolve));
		await waitUntil(() => seen.includes("$"), 15_000, "shell prompt");

		// Stop reading. From here the only thing that can hold the flow back is
		// backpressure, and SPEC.md §9.7 puts a 1 MiB ceiling on buffered output.
		const raw = browser as unknown as {
			_socket: { pause: () => void; resume: () => void };
		};
		raw._socket.pause();

		const before = process.memoryUsage().rss;
		browser.send(JSON.stringify({ type: "input", data: "yes | head -c 20000000\r" }));

		let peakBuffered = 0;
		const deadline = Date.now() + 15_000;
		while (Date.now() < deadline) {
			for (const client of apiClients()) {
				peakBuffered = Math.max(peakBuffered, client.bufferedAmount);
			}
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		const grew = process.memoryUsage().rss - before;
		const stalledLength = seen.length;

		expect(apiClients()).toHaveLength(1);
		// SPEC.md §9.7 caps buffered terminal output at 1 MiB. Well under that
		// here, because tmux is a screen and not a pipe: 20 MB of `yes` becomes a
		// few redraws of a 200x50 window, whatever the shell produced.
		expect(peakBuffered).toBeLessThan(2 * 1024 * 1024);
		// A loose bound on process memory, since API, agent, and client all share
		// this process.
		expect(grew).toBeLessThan(200 * 1024 * 1024);

		// The shell really did run: output resumes once the browser reads again.
		raw._socket.resume();
		await waitUntil(() => seen.length > stalledLength, 15_000, "output after resume");
		browser.terminate();
	},
);

/** Poll until a condition holds, so a test does not race a real shell. */
async function waitUntil(
	condition: () => boolean,
	timeoutMs: number,
	what: string,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) return;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error(`never saw ${what}`);
}

/** The API's browser-facing sockets, so a test can read their buffers. */
function apiClients(): WsSocket[] {
	const server = (app as unknown as { websocketServer?: { clients: Set<WsSocket> } })
		.websocketServer;
	return server ? [...server.clients] : [];
}

// --- secrets (SPEC.md §24.8) ---

test.skipIf(skip)(
	"neither the agent nor the API ever logs the agent token",
	async () => {
		// Both loggers write JSON lines to the console (apps/api/src/log.ts and
		// apps/workspace-agent/src/log.ts), and both run in this process here.
		const logged: string[] = [];
		const record = (...args: unknown[]) => {
			logged.push(args.map(String).join(" "));
		};
		const spies = [
			vi.spyOn(console, "log").mockImplementation(record),
			vi.spyOn(console, "error").mockImplementation(record),
			vi.spyOn(console, "warn").mockImplementation(record),
		];

		const id = (await createTerminal()).json().id;
		const browser = await openBrowser(id);
		type(browser, "echo hello\r");
		await browser.waitFor("hello");

		// Provoke the error paths too: a bad frame, a refused create, and a
		// rejected upgrade all log.
		browser.ws.send("not json");
		await browser.closed;
		await createTerminal("/etc");
		await fetch(`http://127.0.0.1:${agentPort}/terminals`, {
			headers: { authorization: "Bearer wrong" },
		});

		await new Promise((resolve) => setTimeout(resolve, 300));
		for (const spy of spies) spy.mockRestore();

		for (const line of logged) {
			expect(line).not.toContain(TOKEN);
		}
		// A vacuous pass would be worse than a failure: prove something was logged.
		expect(logged.length).toBeGreaterThan(0);
	},
);
