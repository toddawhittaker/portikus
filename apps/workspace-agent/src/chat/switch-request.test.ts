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
import { failingTmux } from "../test-support/failing-tmux.js";
import { keepTmuxServerAlive } from "../test-support/tmux-keep-alive.js";
import { closeSession, createSession } from "../tmux.js";
import { SWITCH_SAME_AGENT_MESSAGE } from "./core.js";
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

test("a host that already runs that agent says so, apart from being busy", async () => {
	await fakeHost((socket) => {
		writeLine(
			socket,
			JSON.stringify({ type: "error", message: SWITCH_SAME_AGENT_MESSAGE }),
		);
		socket.end();
	});
	await expect(askHostToSwitch(dir, ID, "codex")).rejects.toMatchObject({
		code: "CHAT_SAME_AGENT",
	});
});

test("a host that never answers timed out, and no host at all is a missing chat", async () => {
	await expect(askHostToSwitch(dir, ID, "codex")).rejects.toMatchObject({
		code: "TERMINAL_NOT_FOUND",
	});
	await fakeHost(() => undefined);
	await expect(askHostToSwitch(dir, ID, "codex", 50)).rejects.toMatchObject({
		code: "CHAT_SWITCH_TIMEOUT",
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
		// The hosts do not run here; keep the pane to read what was started.
		await promisify(execFile)("tmux", [
			"-L",
			SOCKET_NAME,
			"set-option",
			"-t",
			`pk-${ID}`,
			"remain-on-exit",
			"on",
		]);
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
			const codexPid = await pane("#{pane_pid}");

			// The host prepared the swap but the new one could not start: the
			// same agent comes back with its own key, so the chat is not stuck.
			const restore = await failingTmux("ANTHROPIC_API_KEY=a");
			try {
				const failed = await app.inject({
					method: "POST",
					url: `/terminals/${ID}/chat-agent`,
					payload: {
						agent: "claude",
						institutionalEnv: { ANTHROPIC_API_KEY: "a" },
						previousInstitutionalEnv: { OPENAI_API_KEY: "k" },
					},
				});
				expect(failed.statusCode).toBe(500);
			} finally {
				restore();
			}
			expect(await pane("#{pane_start_command}")).toContain("--agent=codex");
			expect(await pane("#{pane_pid}")).not.toBe(codexPid);
		} finally {
			await closeSession(ID, SERVER).catch(() => undefined);
			await app.close();
		}
	},
);

/** One fact about the chat's pane, in tmux's format. */
async function pane(format: string): Promise<string> {
	const { stdout } = await promisify(execFile)("tmux", [
		"-L",
		SOCKET_NAME,
		"display-message",
		"-p",
		"-t",
		`pk-${ID}`,
		format,
	]);
	return stdout.trim();
}
