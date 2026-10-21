import type { AddressInfo } from "node:net";
import type { WebSocket as ServerSocket } from "@fastify/websocket";
import type { Database } from "@portikus/db";
import type { FastifyBaseLogger } from "fastify";
import type { Kysely } from "kysely";
import { afterEach, expect, test, vi } from "vitest";
import WebSocketClient, { WebSocketServer } from "ws";
import type { AgentClient } from "../agent-client.js";
import { pipeMessages } from "./message-pipe.js";
import { pipeTerminal } from "./terminal-pipe.js";

vi.mock("@portikus/auth", () => ({
	loadSession: async () => ({}),
	sessionGate: () => null,
}));

/**
 * Backpressure on the browser-to-agent direction (SPEC.md §24.1): an agent
 * that stops reading must make the API stop reading the browser, or one
 * student's frames pile up in the API's memory.
 */

const FRAME = "x".repeat(512 * 1024);
// Kernel socket buffers soak up tens of megabytes before the pipe sees any pressure.
const SLOW_MS = 20_000;
const log = { info() {}, error() {}, debug() {} } as unknown as FastifyBaseLogger;
const db = {} as Kysely<Database>;

const servers: WebSocketServer[] = [];
const clients: WebSocketClient[] = [];

afterEach(async () => {
	for (const client of clients.splice(0)) client.terminate();
	for (const server of servers.splice(0)) {
		for (const client of server.clients) client.terminate();
		await new Promise((resolve) => server.close(resolve));
	}
});

function listen(): Promise<{ server: WebSocketServer; port: number }> {
	return new Promise((resolve) => {
		const server = new WebSocketServer({
			port: 0,
			host: "127.0.0.1",
			maxPayload: 1024 * 1024,
		});
		servers.push(server);
		server.on("listening", () =>
			resolve({ server, port: (server.address() as AddressInfo).port }),
		);
	});
}

/**
 * An agent that says "ready" and then never reads a byte. The browser hears
 * "ready" only once the pipe's agent socket is open, and flooding before then
 * would trip the pipe's limit on input queued while it is still connecting.
 */
async function nonReadingAgent() {
	const { server, port } = await listen();
	const received: string[] = [];
	let agentSocket: WebSocketClient | null = null;
	server.on("connection", (ws) => {
		agentSocket = ws;
		ws.on("message", (data) => received.push(data.toString()));
		ws.send("ready");
		ws.pause();
	});
	return {
		url: `ws://127.0.0.1:${port}/agent`,
		received,
		readAgain: () => agentSocket?.resume(),
	};
}

/** The API's browser-side socket, once the pipe under test has taken it. */
async function browserSide(pipe: (socket: ServerSocket) => Promise<void>) {
	const { server, port } = await listen();
	const sockets: WebSocketClient[] = [];
	server.on("connection", (ws) => {
		sockets.push(ws);
		void pipe(ws as unknown as ServerSocket).catch(() => {});
	});
	const browser = new WebSocketClient(`ws://127.0.0.1:${port}/`);
	clients.push(browser);
	await new Promise((resolve) => browser.once("message", resolve));
	return { browser, apiSocket: () => sockets[0] as WebSocketClient };
}

/** Keep sending until the API stops reading the browser; returns the frames sent. */
async function sendUntilPaused(
	browser: WebSocketClient,
	apiSocket: WebSocketClient,
): Promise<number> {
	let sent = 0;
	await expect
		.poll(
			() => {
				while (browser.bufferedAmount < 1024 * 1024 && !apiSocket.isPaused) {
					browser.send(FRAME);
					sent += 1;
				}
				return apiSocket.isPaused;
			},
			{ timeout: SLOW_MS, interval: 5 },
		)
		.toBe(true);
	return sent;
}

const pipes: Record<string, (url: string) => (socket: ServerSocket) => Promise<void>> =
	{
		"the language-server pipe": (url) => (socket) =>
			pipeMessages({
				db,
				socket,
				url,
				authHeader: "Bearer t",
				workspaceId: "w1",
				sessionToken: "s",
				log,
				maxAgentFrameBytes: 1024 * 1024,
				forwardBrowserFrames: true,
				closeReason: () => "closed",
				failureMessage: "failed",
			}),
		"the terminal pipe": (url) => (socket) =>
			pipeTerminal({
				db,
				socket,
				agent: {
					attachUrl: () => url,
					authHeader: () => "Bearer t",
				} as unknown as AgentClient,
				workspaceId: "w1",
				terminalId: "t1",
				connectionId: "c1",
				sessionToken: "s",
				log,
				cols: 80,
				rows: 24,
				presence: false,
			}),
	};

for (const [name, makePipe] of Object.entries(pipes)) {
	test(
		`${name} stops reading a browser while the agent is not reading`,
		async () => {
			const agent = await nonReadingAgent();
			const { browser, apiSocket } = await browserSide(makePipe(agent.url));

			await sendUntilPaused(browser, apiSocket());
			expect(apiSocket().isPaused).toBe(true);
		},
		SLOW_MS,
	);

	// The pipe may pause again while it works through the backlog, so the
	// proof of resuming is that every frame sent reaches the agent.
	test(
		`${name} reads the browser again once the agent drains`,
		async () => {
			const agent = await nonReadingAgent();
			const { browser, apiSocket } = await browserSide(makePipe(agent.url));
			const sent = await sendUntilPaused(browser, apiSocket());

			agent.readAgain();
			await expect.poll(() => agent.received.length, { timeout: SLOW_MS }).toBe(sent);
		},
		SLOW_MS,
	);
}
