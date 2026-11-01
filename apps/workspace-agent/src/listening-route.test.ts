/**
 * The agent's listening and forward routes end to end, against a fake /proc
 * tree and a real echo server (SPEC.md §14.7, §18.2, BROWSER-HANDLING.md
 * §11.1, §17).
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { type AddressInfo, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentCodingAgentsChanged, AgentLimitsReport } from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { AgentLimitsStore } from "./agent-limits-route.js";
import { CodingAgentBoard } from "./coding-agent-status.js";
import { buildServer } from "./server.js";

const TOKEN = "d".repeat(64);
const FORWARD_ADDRESS = "127.0.0.2";
const HEADER =
	"  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";

let app: FastifyInstance;
const board = new CodingAgentBoard();
const limits = new AgentLimitsStore();
const AGENT_TERMINAL = "4f7d2a8e-3b1c-4d5e-9f60-718293a4b5c6";
let procRoot: string;
let port: number;
let echo: Server;
let echoPort: number;

function row(local: string): string {
	return `   0: ${local} 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1 1 0000000000000000 100 0 0 10 0`;
}

function hexLoopback(target: number): string {
	return `0100007F:${target.toString(16).toUpperCase().padStart(4, "0")}`;
}

async function writeProcNet(tcp: string): Promise<void> {
	await writeFile(join(procRoot, "net", "tcp"), tcp);
}

beforeAll(async () => {
	const dir = await mkdtemp(join(tmpdir(), "portikus-listen-route-"));
	procRoot = dir;
	await mkdir(join(procRoot, "net"), { recursive: true });
	await writeFile(join(procRoot, "net", "tcp6"), HEADER);

	echo = createServer((socket) => {
		socket.on("data", (chunk) => socket.write(chunk));
	});
	await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
	echoPort = (echo.address() as AddressInfo).port;
	await writeProcNet([HEADER, row(hexLoopback(echoPort))].join("\n"));

	const tokenPath = join(dir, "agent.token");
	await writeFile(tokenPath, TOKEN);
	app = buildServer({
		tmuxSocketName: "portikus-test",
		tokenPath,
		homeDir: dir,
		listening: {
			procRoot,
			interfaceAddress: FORWARD_ADDRESS,
			docker: null,
			intervalMs: 50,
		},
		codingAgents: board,
		agentLimits: limits,
	});
	await app.listen({ host: "127.0.0.1", port: 0 });
	port = (app.server.address() as AddressInfo).port;
});

afterAll(async () => {
	await app.close();
	echo.close();
	await rm(procRoot, { recursive: true, force: true });
});

function auth() {
	return { authorization: `Bearer ${TOKEN}` };
}

test("GET /listening lists what is listening", async () => {
	const response = await app.inject({
		method: "GET",
		url: "/listening",
		headers: auth(),
	});
	expect(response.statusCode).toBe(200);
	const body = response.json() as { services: { port: number }[] };
	expect(body.services.map((service) => service.port)).toEqual([echoPort]);
});

test("GET /listening needs the token", async () => {
	const response = await app.inject({ method: "GET", url: "/listening" });
	expect(response.statusCode).toBe(401);
});

test("the events socket sends the whole list on connect", async () => {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/listening/events`, {
		headers: auth(),
	} as unknown as string[]);
	const first = await new Promise<Record<string, unknown>>((resolve, reject) => {
		ws.addEventListener("message", (event) =>
			resolve(JSON.parse(event.data as string)),
		);
		ws.addEventListener("error", () => reject(new Error("socket failed")));
	});
	expect(first.type).toBe("workspace.listening-services.changed");
	expect((first.services as { port: number }[]).map((s) => s.port)).toEqual([echoPort]);
	ws.close();
});

test("an open events socket keeps the timer scanning", async () => {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/listening/events`, {
		headers: auth(),
	} as unknown as string[]);
	const frames: { port: number }[][] = [];
	ws.addEventListener("message", (event) => {
		const frame = JSON.parse(event.data as string);
		if (frame.type === "workspace.listening-services.changed")
			frames.push(frame.services);
	});
	await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0));
	// A new port reaches the socket through the timer alone.
	await writeProcNet(
		[HEADER, row(hexLoopback(echoPort)), row(hexLoopback(4999))].join("\n"),
	);
	try {
		await vi.waitFor(() =>
			expect(frames.at(-1)?.map((s) => s.port)).toEqual(
				[4999, echoPort].sort((a, b) => a - b),
			),
		);
	} finally {
		ws.close();
		await writeProcNet([HEADER, row(hexLoopback(echoPort))].join("\n"));
	}
});

test("the events socket sends coding-agent states on connect and on each change", async () => {
	board.set(AGENT_TERMINAL, "claude", "working");
	const ws = new WebSocket(`ws://127.0.0.1:${port}/listening/events`, {
		headers: auth(),
	} as unknown as string[]);
	const frames: unknown[] = [];
	ws.addEventListener("message", (event) => {
		const frame = JSON.parse(event.data as string);
		if (frame.type === "workspace.coding-agents.changed") frames.push(frame);
	});
	try {
		await vi.waitFor(() => expect(frames).toHaveLength(1));
		expect(AgentCodingAgentsChanged.parse(frames[0]).terminals).toEqual([
			expect.objectContaining({ terminalId: AGENT_TERMINAL, state: "working" }),
		]);
		board.set(AGENT_TERMINAL, "claude", "needs-input");
		await vi.waitFor(() => expect(frames).toHaveLength(2));
		expect(AgentCodingAgentsChanged.parse(frames[1]).terminals).toEqual([
			expect.objectContaining({ terminalId: AGENT_TERMINAL, state: "needs-input" }),
		]);
		board.remove(AGENT_TERMINAL);
		await vi.waitFor(() => expect(frames).toHaveLength(3));
		expect(AgentCodingAgentsChanged.parse(frames[2]).terminals).toEqual([]);
	} finally {
		ws.close();
	}
});

test("GET /agent-limits answers the report, and only with the token", async () => {
	const anonymous = await app.inject({ method: "GET", url: "/agent-limits" });
	expect(anonymous.statusCode).toBe(401);
	const empty = await app.inject({
		method: "GET",
		url: "/agent-limits",
		headers: auth(),
	});
	expect(empty.statusCode).toBe(200);
	expect(AgentLimitsReport.parse(empty.json())).toEqual({ claude: null, codex: null });
	const claude = {
		windows: [
			{
				name: "5h",
				usedPercent: 42,
				resetsAt: new Date(Date.now() + 3_600_000).toISOString(),
				windowMinutes: 300,
			},
		],
		observedAt: new Date().toISOString(),
	};
	limits.setClaude(claude);
	const filled = await app.inject({
		method: "GET",
		url: "/agent-limits",
		headers: auth(),
	});
	expect(AgentLimitsReport.parse(filled.json())).toEqual({ claude, codex: null });
});

test("a forward opens, lists, and closes", async () => {
	const opened = await app.inject({
		method: "POST",
		url: "/forwards",
		headers: auth(),
		payload: { port: echoPort },
	});
	expect(opened.statusCode).toBe(200);
	expect(opened.json()).toEqual({
		port: echoPort,
		address: FORWARD_ADDRESS,
		state: "open",
	});

	const listed = await app.inject({
		method: "GET",
		url: "/forwards",
		headers: auth(),
	});
	expect(listed.json()).toEqual({
		forwards: [{ port: echoPort, address: FORWARD_ADDRESS, state: "open" }],
	});

	const closed = await app.inject({
		method: "DELETE",
		url: `/forwards/${echoPort}`,
		headers: auth(),
	});
	expect(closed.statusCode).toBe(204);
	const gone = await app.inject({
		method: "DELETE",
		url: `/forwards/${echoPort}`,
		headers: auth(),
	});
	expect(gone.statusCode).toBe(404);
});

test("stopping a port nothing is listening on is a 404", async () => {
	const response = await app.inject({
		method: "POST",
		url: "/listening/4321/stop",
		headers: auth(),
	});
	expect(response.statusCode).toBe(404);
	expect(response.json().error.code).toBe("LISTENER_NOT_FOUND");
});

test("a probe request settles the port's protocol", async () => {
	const response = await app.inject({
		method: "POST",
		url: `/listening/${echoPort}/probe`,
		headers: auth(),
	});
	expect(response.statusCode).toBe(200);
	expect(response.json().service).toMatchObject({
		port: echoPort,
		protocolHint: "unknown",
		protocolKnown: true,
	});
});

test("probing a port nothing is listening on is a 404", async () => {
	const response = await app.inject({
		method: "POST",
		url: "/listening/4321/probe",
		headers: auth(),
	});
	expect(response.statusCode).toBe(404);
	expect(response.json().error.code).toBe("LISTENER_NOT_FOUND");
});

test("a probe request needs the token and a valid port", async () => {
	const anonymous = await app.inject({
		method: "POST",
		url: `/listening/${echoPort}/probe`,
	});
	expect(anonymous.statusCode).toBe(401);
	const invalid = await app.inject({
		method: "POST",
		url: "/listening/nope/probe",
		headers: auth(),
	});
	expect(invalid.statusCode).toBe(400);
});

test("stopping a port nothing is listening on keeps its exact body", async () => {
	const response = await app.inject({
		method: "POST",
		url: "/listening/4321/stop",
		headers: auth(),
	});
	expect(response.statusCode).toBe(404);
	expect(response.json()).toEqual({
		error: { code: "LISTENER_NOT_FOUND", message: "nothing is listening on that port" },
	});
});

test("a stop request without a valid port is refused", async () => {
	const response = await app.inject({
		method: "POST",
		url: "/listening/nope/stop",
		headers: auth(),
	});
	expect(response.statusCode).toBe(400);
});

test("a port nothing is listening on cannot be forwarded", async () => {
	const response = await app.inject({
		method: "POST",
		url: "/forwards",
		headers: auth(),
		payload: { port: 4321 },
	});
	expect(response.statusCode).toBe(409);
	expect(response.json()).toEqual({
		error: {
			code: "FORWARD_NOT_LOOPBACK",
			message: "no service is listening on loopback only at that port",
		},
	});
});

test("a request without a valid port is refused", async () => {
	const response = await app.inject({
		method: "POST",
		url: "/forwards",
		headers: auth(),
		payload: { port: 0 },
	});
	expect(response.statusCode).toBe(400);
	const bad = await app.inject({
		method: "DELETE",
		url: "/forwards/nope",
		headers: auth(),
	});
	expect(bad.statusCode).toBe(404);
});
