import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { silentLogger } from "@portikus/observability";
import Fastify from "fastify";
import { afterEach, beforeEach, expect, test } from "vitest";
import { TerminalRegistry } from "../terminals.js";
import { terminalsRoutes } from "../terminals-route.js";
import { keepTmuxServerAlive } from "../test-support/tmux-keep-alive.js";
import { closeSession, createSession } from "../tmux.js";
import { askHostToSwitch } from "./switch-request.js";
import { chatSocketPath, readLines, writeLine } from "./wire.js";

const ID = "00000000-0000-4000-8000-000000009030";

let dir: string;
let host: Server | null;
let heard: string[];

beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "pk-switch-"));
	host = null;
	heard = [];
});

afterEach(async () => {
	await new Promise<void>((resolve) =>
		host ? host.close(() => resolve()) : resolve(),
	);
	await rm(dir, { recursive: true, force: true });
});

/** A chat host that answers the swap request as `answer` says. */
async function fakeHost(answer: (socket: Socket) => void): Promise<void> {
	host = createServer((socket) => {
		writeLine(socket, JSON.stringify({ type: "snapshot" }));
		readLines(socket, 1 << 20, (line) => {
			heard.push(line);
			answer(socket);
		});
	});
	await new Promise<void>((resolve) =>
		host?.listen(chatSocketPath(dir, ID), () => resolve()),
	);
}

test("the host closing the connection without an error means the swap is ready", async () => {
	await fakeHost((socket) => socket.end());
	await expect(askHostToSwitch(dir, ID, "codex")).resolves.toBeUndefined();
	expect(heard.map((line) => JSON.parse(line))).toEqual([
		{ type: "agent.switch", agent: "codex" },
	]);
});

test("an error frame is a refusal", async () => {
	await fakeHost((socket) => {
		writeLine(socket, JSON.stringify({ type: "error", message: "busy" }));
		socket.end();
	});
	await expect(askHostToSwitch(dir, ID, "codex")).rejects.toMatchObject({
		code: "CHAT_BUSY",
	});
});

test("a host that never answers is a refusal, and no host at all is a missing chat", async () => {
	await expect(askHostToSwitch(dir, ID, "codex")).rejects.toMatchObject({
		code: "TERMINAL_NOT_FOUND",
	});
	await fakeHost(() => undefined);
	await expect(askHostToSwitch(dir, ID, "codex", 50)).rejects.toMatchObject({
		code: "CHAT_BUSY",
	});
});

const haveTmux = await promisify(execFile)("tmux", ["-V"]).then(
	() => true,
	() => false,
);
const SOCKET_NAME = `portikus-switch-${process.pid}`;
const SERVER = { socketName: SOCKET_NAME, external: false };

test.skipIf(!haveTmux)(
	"the route asks the host, then puts the other agent's host in the same session",
	async () => {
		await keepTmuxServerAlive(SOCKET_NAME);
		const app = Fastify();
		await app.register(terminalsRoutes, {
			homeDir: dir,
			tmuxServer: SERVER,
			registry: new TerminalRegistry(dir, silentLogger(), SERVER),
			chatSocketDir: dir,
		});
		const missing = await app.inject({
			method: "POST",
			url: `/terminals/${ID}/chat-agent`,
			payload: { agent: "codex" },
		});
		expect(missing.statusCode).toBe(404);
		const bad = await app.inject({
			method: "POST",
			url: `/terminals/${ID}/chat-agent`,
			payload: { agent: "gemini" },
		});
		expect(bad.statusCode).toBe(400);

		await createSession(ID, dir, dir, "dark", "UTC", SERVER, {
			command: ["sleep", "60"],
		});
		try {
			await fakeHost((socket) => {
				writeLine(socket, JSON.stringify({ type: "error", message: "busy" }));
			});
			const busy = await app.inject({
				method: "POST",
				url: `/terminals/${ID}/chat-agent`,
				payload: { agent: "codex" },
			});
			expect(busy.statusCode).toBe(409);
			expect(busy.json().error.code).toBe("CHAT_BUSY");

			await new Promise<void>((resolve) => host?.close(() => resolve()));
			await fakeHost((socket) => socket.end());
			const done = await app.inject({
				method: "POST",
				url: `/terminals/${ID}/chat-agent`,
				payload: { agent: "codex", institutionalEnv: { OPENAI_API_KEY: "k" } },
			});
			expect(done.statusCode).toBe(204);
		} finally {
			await closeSession(ID, SERVER).catch(() => undefined);
			await app.close();
		}
	},
);
