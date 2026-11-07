import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	MAX_CHAT_CLIENT_FRAME_BYTES,
	MAX_CHAT_SERVER_FRAME_BYTES,
} from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest";
import { buildServer } from "../server.js";
import { chatSocketPath, readLines } from "./wire.js";

const TOKEN = "d".repeat(64);
const ID = "7a1c2e3f-4b5d-4e6f-8a9b-0c1d2e3f4a5b";

let app: FastifyInstance;
let dir: string;
let port: number;
let fakeHost: Server | null = null;
let hostSockets: Socket[] = [];
let hostLines: string[] = [];

async function startFakeHost(): Promise<void> {
	hostSockets = [];
	hostLines = [];
	fakeHost = createServer((socket) => {
		hostSockets.push(socket);
		readLines(socket, 2 * MAX_CHAT_CLIENT_FRAME_BYTES, (line) => hostLines.push(line));
		socket.write(
			`${JSON.stringify({ type: "turn.started", sessionId: ID, seq: 1 })}\n`,
		);
	});
	await new Promise<void>((resolve) =>
		fakeHost?.listen(chatSocketPath(join(dir, "chat"), ID), resolve),
	);
}

interface Sock {
	ws: WebSocket;
	frames: string[];
	closed: Promise<number>;
}

async function open(id = ID): Promise<Sock> {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/terminals/${id}/chat`, {
		headers: { authorization: `Bearer ${TOKEN}` },
	} as unknown as string[]);
	const frames: string[] = [];
	ws.addEventListener("message", (event) => frames.push(event.data as string));
	const closed = new Promise<number>((resolve) => {
		ws.addEventListener("close", (event) => resolve(event.code), { once: true });
	});
	await new Promise<void>((resolve) => {
		ws.addEventListener("open", () => resolve(), { once: true });
		ws.addEventListener("close", () => resolve(), { once: true });
	});
	return { ws, frames, closed };
}

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "pk-chat-route-"));
	await mkdir(join(dir, "chat"), { mode: 0o700 });
	const tokenPath = join(dir, "agent.token");
	await writeFile(tokenPath, `${TOKEN}\n`, { mode: 0o600 });
	app = buildServer({
		tmuxSocketName: "portikus-test",
		tokenPath,
		homeDir: dir,
		chatSocketDir: join(dir, "chat"),
	});
	await app.listen({ port: 0, host: "127.0.0.1" });
	port = (app.server.address() as { port: number }).port;
});

afterEach(async () => {
	for (const socket of hostSockets) socket.destroy();
	await new Promise<void>((resolve) =>
		fakeHost ? fakeHost.close(() => resolve()) : resolve(),
	);
	fakeHost = null;
});

afterAll(async () => {
	await app.close();
	await rm(dir, { recursive: true, force: true });
});

test("frames pass both ways, one JSON frame per line", async () => {
	await startFakeHost();
	const sock = await open();
	await vi.waitFor(() => expect(sock.frames).toHaveLength(1));
	expect(JSON.parse(sock.frames[0] as string)).toMatchObject({ type: "turn.started" });
	sock.ws.send(JSON.stringify({ type: "interrupt" }));
	await vi.waitFor(() => expect(hostLines).toEqual(['{"type":"interrupt"}']));
	sock.ws.close();
	expect(await sock.closed).toBe(1005);
});

/** The HTTP status an upgrade request gets, read before any upgrade. */
async function upgradeStatus(id: string): Promise<number> {
	const { request } = await import("node:http");
	return new Promise((resolve, reject) => {
		const req = request({
			host: "127.0.0.1",
			port,
			path: `/terminals/${id}/chat`,
			headers: {
				authorization: `Bearer ${TOKEN}`,
				connection: "Upgrade",
				upgrade: "websocket",
				"sec-websocket-version": "13",
				"sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
			},
		});
		req.on("response", (response) => resolve(response.statusCode ?? 0));
		req.on("upgrade", (_response, socket) => {
			socket.destroy();
			resolve(101);
		});
		req.on("error", reject);
		req.end();
	});
}

test("a terminal with no chat host is refused with 404 before the upgrade", async () => {
	expect(await upgradeStatus(ID)).toBe(404);
	expect(await upgradeStatus("not-an-id")).toBe(404);
});

test("a browser frame off the contract closes with 1008", async () => {
	await startFakeHost();
	const sock = await open();
	sock.ws.send(JSON.stringify({ type: "shell", command: "id" }));
	expect(await sock.closed).toBe(1008);
	expect(hostLines).toEqual([]);
});

test("an oversized browser frame closes with 1009", async () => {
	await startFakeHost();
	const sock = await open();
	sock.ws.send(
		JSON.stringify({
			type: "send",
			text: "x".repeat(MAX_CHAT_CLIENT_FRAME_BYTES),
			attachments: [],
		}),
	);
	expect(await sock.closed).toBe(1009);
	expect(hostLines).toEqual([]);
});

test("an oversized host frame closes with 1009", async () => {
	await startFakeHost();
	const sock = await open();
	await vi.waitFor(() => expect(hostSockets).toHaveLength(1));
	hostSockets[0]?.write("x".repeat(MAX_CHAT_SERVER_FRAME_BYTES + 1));
	expect(await sock.closed).toBe(1009);
});

test("the host going away closes the browser socket", async () => {
	await startFakeHost();
	const sock = await open();
	await vi.waitFor(() => expect(hostSockets).toHaveLength(1));
	hostSockets[0]?.destroy();
	expect(await sock.closed).toBe(1000);
});

test("a chat tab's tmux command is the chat host on the agent's own Node", async () => {
	const { chatHostCommand } = await import("../tmux.js");
	const [node, entry, id] = chatHostCommand(ID);
	expect(node).toBe(process.execPath);
	expect(entry).toMatch(/\/chat\/main\.js$/);
	expect(id).toBe(ID);
	expect(() => chatHostCommand("../x")).toThrow();
});

test("a chat resuming an ended one names that session after its own id", async () => {
	const { chatHostCommand } = await import("../tmux.js");
	const old = "7a1c2e3f-4b5d-4e6f-8a9b-0c1d2e3f4a5b";
	expect(chatHostCommand(ID, old).slice(2)).toEqual([ID, old]);
	expect(() => chatHostCommand(ID, "../x")).toThrow();
});

test("a binary browser frame closes with 1003", async () => {
	await startFakeHost();
	const sock = await open();
	sock.ws.send(new Uint8Array([1, 2, 3]));
	expect(await sock.closed).toBe(1003);
});

test("a slow browser pauses the host until it drains", async () => {
	await startFakeHost();
	const sock = await open();
	await vi.waitFor(() => expect(hostSockets).toHaveLength(1));
	const big = `${JSON.stringify({ type: "error", sessionId: ID, seq: 2, message: "x".repeat(1024 * 1024) })}\n`;
	for (let i = 0; i < 4; i++) hostSockets[0]?.write(big);
	await vi.waitFor(() => expect(sock.frames).toHaveLength(5), { timeout: 10_000 });
	sock.ws.close();
	await sock.closed;
});
