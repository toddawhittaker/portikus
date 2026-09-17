import { execFile } from "node:child_process";
import { mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { LogLevel } from "@portikus/observability";
import { collectingLogger } from "@portikus/observability/testing";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, test } from "vitest";
import { buildServer } from "./server.js";
import { hasSession } from "./tmux.js";

const run = promisify(execFile);

const TOKEN = "a".repeat(64);
const SOCKET_NAME = `portikus-test-${process.pid}`;

let app: FastifyInstance;
let homeDir: string;
let port: number;

async function tmuxAvailable(): Promise<boolean> {
	try {
		await run("tmux", ["-V"]);
		return true;
	} catch {
		return false;
	}
}

// skipIf is evaluated when the file is collected, so probe tmux here.
const haveTmux = await tmuxAvailable();

function auth(token = TOKEN) {
	return { authorization: `Bearer ${token}` };
}

let nextId = 0;
function makeId(): string {
	nextId += 1;
	return `00000000-0000-4000-8000-${String(nextId).padStart(12, "0")}`;
}

interface Sock {
	ws: WebSocket;
	output: () => string;
	textFrames: unknown[];
	waitFor: (needle: string, times?: number) => Promise<void>;
	closed: Promise<number>;
	close: () => Promise<void>;
}

async function openSocket(
	id: string,
	token = TOKEN,
	query = "",
	sendOnOpen?: string,
): Promise<Sock> {
	const url = `ws://127.0.0.1:${port}/terminals/${id}/attach${query}`;
	// Node's WebSocket sends extra request headers, but its published type
	// only allows a protocol list as the second argument.
	const ws = new WebSocket(url, {
		headers: { authorization: `Bearer ${token}` },
	} as unknown as string[]);
	ws.binaryType = "arraybuffer";

	let output = "";
	const textFrames: unknown[] = [];
	const decoder = new TextDecoder();

	if (sendOnOpen !== undefined) {
		ws.addEventListener(
			"open",
			() => ws.send(JSON.stringify({ type: "input", data: sendOnOpen })),
			{ once: true },
		);
	}

	ws.addEventListener("message", (event) => {
		if (typeof event.data === "string") {
			try {
				textFrames.push(JSON.parse(event.data));
			} catch {
				textFrames.push(event.data);
			}
			return;
		}
		output += decoder.decode(new Uint8Array(event.data as ArrayBuffer));
	});

	const closed = new Promise<number>((resolve) => {
		ws.addEventListener("close", (event) => resolve(event.code), { once: true });
	});

	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("socket never opened")), 5000);
		ws.addEventListener(
			"open",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
		ws.addEventListener(
			"close",
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});

	async function waitFor(needle: string, times = 1): Promise<void> {
		const deadline = Date.now() + 10000;
		while (Date.now() < deadline) {
			if (output.split(needle).length - 1 >= times) return;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		throw new Error(`never saw ${needle} ${times}x in: ${JSON.stringify(output)}`);
	}

	return {
		ws,
		output: () => output,
		textFrames,
		waitFor,
		closed,
		close: async () => {
			ws.close();
			await closed;
		},
	};
}

beforeAll(async () => {
	if (!haveTmux) return;
	homeDir = await mkdtemp(join(tmpdir(), "portikus-agent-"));
	const tokenPath = join(homeDir, "agent.token");
	await writeFile(tokenPath, `${TOKEN}\n`, { mode: 0o600 });
	app = buildServer({ tokenPath, homeDir, tmuxSocketName: SOCKET_NAME });
	await app.listen({ port: 0, host: "127.0.0.1" });
	port = (app.server.address() as { port: number }).port;
});

afterAll(async () => {
	if (!haveTmux) return;
	await app.close();
	// Kill the whole test server so no pk-* session outlives the run.
	await run("tmux", ["-L", SOCKET_NAME, "kill-server"]).catch(() => undefined);
});

test.skipIf(!haveTmux)("every route needs the bearer token", async () => {
	const noToken = await app.inject({ method: "GET", url: "/health" });
	expect(noToken.statusCode).toBe(401);
	expect(noToken.json().error.code).toBe("UNAUTHORIZED");

	const wrong = await app.inject({
		method: "GET",
		url: "/health",
		headers: auth("b".repeat(64)),
	});
	expect(wrong.statusCode).toBe(401);

	const ok = await app.inject({ method: "GET", url: "/health", headers: auth() });
	expect(ok.statusCode).toBe(200);
	expect(ok.json()).toEqual({ ok: true });
});

test.skipIf(!haveTmux)("the upgrade is rejected without a valid token", async () => {
	const id = makeId();
	const created = await app.inject({
		method: "POST",
		url: "/terminals",
		headers: auth(),
		payload: { id, cwd: homeDir },
	});
	expect(created.statusCode).toBe(201);

	const socket = await openSocket(id, "c".repeat(64));
	expect(socket.ws.readyState).not.toBe(WebSocket.OPEN);

	await app.inject({ method: "DELETE", url: `/terminals/${id}`, headers: auth() });
});

test.skipIf(!haveTmux)(
	"a terminal echoes input and survives detach",
	async () => {
		const id = makeId();
		const created = await app.inject({
			method: "POST",
			url: "/terminals",
			headers: auth(),
			payload: { id, cwd: homeDir },
		});
		expect(created.statusCode).toBe(201);

		const listed = await app.inject({
			method: "GET",
			url: "/terminals",
			headers: auth(),
		});
		expect(listed.json().terminals).toContainEqual(
			expect.objectContaining({ id, attachments: 0 }),
		);

		const first = await openSocket(id, TOKEN, "?cols=100&rows=30");
		await first.waitFor("$", 1);

		const second = await openSocket(id);
		first.ws.send(JSON.stringify({ type: "input", data: "echo hello-portikus\r" }));

		// Both attachments share one tmux session, so both see the same output.
		await first.waitFor("hello-portikus", 2);
		await second.waitFor("hello-portikus", 1);

		// Closing one attachment detaches it; the session and its shell live on.
		await first.close();
		expect(await hasSession(id, SOCKET_NAME)).toBe(true);

		const afterDetach = await app.inject({
			method: "GET",
			url: "/terminals",
			headers: auth(),
		});
		expect(afterDetach.json().terminals).toContainEqual(
			expect.objectContaining({ id, attachments: 1 }),
		);

		second.ws.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));

		const deleted = await app.inject({
			method: "DELETE",
			url: `/terminals/${id}`,
			headers: auth(),
		});
		expect(deleted.statusCode).toBe(204);
		expect(await hasSession(id, SOCKET_NAME)).toBe(false);
		await second.closed;

		const missing = await app.inject({
			method: "DELETE",
			url: `/terminals/${id}`,
			headers: auth(),
		});
		expect(missing.statusCode).toBe(404);
		expect(missing.json().error.code).toBe("TERMINAL_NOT_FOUND");
	},
	30000,
);

test.skipIf(!haveTmux)("a working directory outside the home is refused", async () => {
	const outside = await app.inject({
		method: "POST",
		url: "/terminals",
		headers: auth(),
		payload: { id: makeId(), cwd: "/etc" },
	});
	expect(outside.statusCode).toBe(400);
	expect(outside.json().error.code).toBe("INVALID_CWD");

	const relative = await app.inject({
		method: "POST",
		url: "/terminals",
		headers: auth(),
		payload: { id: makeId(), cwd: "projects" },
	});
	expect(relative.statusCode).toBe(400);
	expect(relative.json().error.code).toBe("INVALID_CWD");
});

test.skipIf(!haveTmux)(
	"a workspace is capped at eight terminals",
	async () => {
		const ids: string[] = [];
		for (let i = 0; i < 8; i += 1) {
			const id = makeId();
			ids.push(id);
			const created = await app.inject({
				method: "POST",
				url: "/terminals",
				headers: auth(),
				payload: { id, cwd: homeDir },
			});
			expect(created.statusCode).toBe(201);
		}

		const duplicate = await app.inject({
			method: "POST",
			url: "/terminals",
			headers: auth(),
			payload: { id: ids[0], cwd: homeDir },
		});
		expect(duplicate.statusCode).toBe(409);
		expect(duplicate.json().error.code).toBe("TERMINAL_EXISTS");

		const ninth = await app.inject({
			method: "POST",
			url: "/terminals",
			headers: auth(),
			payload: { id: makeId(), cwd: homeDir },
		});
		expect(ninth.statusCode).toBe(409);
		expect(ninth.json().error.code).toBe("TERMINAL_LIMIT");

		for (const id of ids) {
			await app.inject({ method: "DELETE", url: `/terminals/${id}`, headers: auth() });
		}
	},
	30000,
);

test.skipIf(!haveTmux)(
	"a terminal is capped at four attachments",
	async () => {
		const id = makeId();
		await app.inject({
			method: "POST",
			url: "/terminals",
			headers: auth(),
			payload: { id, cwd: homeDir },
		});

		const sockets: Sock[] = [];
		for (let i = 0; i < 4; i += 1) {
			sockets.push(await openSocket(id));
		}

		const fifth = await openSocket(id);
		const code = await fifth.closed;
		expect(code).toBe(1008);
		expect(fifth.textFrames).toContainEqual({
			type: "error",
			code: "ATTACHMENT_LIMIT",
		});

		for (const socket of sockets) {
			await socket.close();
		}
		await app.inject({ method: "DELETE", url: `/terminals/${id}`, headers: auth() });
	},
	30000,
);

test.skipIf(!haveTmux)(
	"a malformed frame closes the socket",
	async () => {
		const id = makeId();
		await app.inject({
			method: "POST",
			url: "/terminals",
			headers: auth(),
			payload: { id, cwd: homeDir },
		});

		const socket = await openSocket(id);
		socket.ws.send("not json at all");
		const code = await socket.closed;
		expect(code).toBe(1008);
		expect(socket.textFrames).toContainEqual({ type: "error", code: "BAD_FRAME" });

		await app.inject({ method: "DELETE", url: `/terminals/${id}`, headers: auth() });
	},
	20000,
);

test.skipIf(!haveTmux)(
	"an oversized input frame closes the socket",
	async () => {
		const id = makeId();
		await app.inject({
			method: "POST",
			url: "/terminals",
			headers: auth(),
			payload: { id, cwd: homeDir },
		});

		const socket = await openSocket(id);
		socket.ws.send(JSON.stringify({ type: "input", data: "x".repeat(65537) }));
		expect(await socket.closed).toBe(1009);

		await app.inject({ method: "DELETE", url: `/terminals/${id}`, headers: auth() });
	},
	20000,
);

test.skipIf(!haveTmux)(
	"attaching to a terminal that does not exist fails",
	async () => {
		const socket = await openSocket(makeId());
		expect(await socket.closed).toBe(1008);
		expect(socket.textFrames).toContainEqual({
			type: "error",
			code: "TERMINAL_NOT_FOUND",
		});
	},
);

// Logging (ADR 0012). These need no tmux: they exercise the routes and the
// request logging hook only, so they build their own server.

async function buildLoggingServer(level: LogLevel = "info") {
	const dir = await mkdtemp(join(tmpdir(), "portikus-agent-log-"));
	const tokenPath = join(dir, "agent.token");
	await writeFile(tokenPath, `${TOKEN}\n`, { mode: 0o600 });
	const { logger, lines } = collectingLogger(level);
	const server = buildServer({
		tokenPath,
		homeDir: dir,
		tmuxSocketName: SOCKET_NAME,
		logger,
	});
	await server.ready();
	return {
		server,
		logger,
		lines,
		requests: () => lines.filter((l) => l.msg === "request"),
	};
}

test("PUT /log-level changes the level the agent logs at", async () => {
	// The level has to land on the logger index.ts made, not on Fastify's child
	// of it, or the agent's own debug lines outside a request stay silent.
	const { server, logger, lines } = await buildLoggingServer("info");
	try {
		const res = await server.inject({
			method: "PUT",
			url: "/log-level",
			headers: auth(),
			payload: { level: "debug" },
		});
		expect(res.statusCode).toBe(204);
		expect(logger.level).toBe("debug");
		expect(lines.some((l) => l.msg === "log level changed" && l.to === "debug")).toBe(
			true,
		);

		lines.length = 0;
		logger.debug({ where: "outside a request" }, "now visible");
		expect(lines).toHaveLength(1);

		const cleared = await server.inject({
			method: "PUT",
			url: "/log-level",
			headers: auth(),
			payload: { level: null },
		});
		expect(cleared.statusCode).toBe(204);
		expect(logger.level).toBe("info");
		lines.length = 0;
		logger.debug("silent again");
		expect(lines).toHaveLength(0);
	} finally {
		await server.close();
	}
});

test("PUT /log-level needs the token and a known level", async () => {
	const { server, logger } = await buildLoggingServer();
	try {
		const noToken = await server.inject({
			method: "PUT",
			url: "/log-level",
			payload: { level: "debug" },
		});
		expect(noToken.statusCode).toBe(401);
		expect(logger.level).toBe("info");

		const bad = await server.inject({
			method: "PUT",
			url: "/log-level",
			headers: auth(),
			payload: { level: "verbose" },
		});
		expect(bad.statusCode).toBe(400);
		expect(bad.json().error.code).toBe("BAD_REQUEST");
		expect(logger.level).toBe("info");
	} finally {
		await server.close();
	}
});

test("a null level returns the agent to the level it started with", async () => {
	const { server, logger } = await buildLoggingServer("warn");
	try {
		await server.inject({
			method: "PUT",
			url: "/log-level",
			headers: auth(),
			payload: { level: "debug" },
		});
		expect(logger.level).toBe("debug");

		const cleared = await server.inject({
			method: "PUT",
			url: "/log-level",
			headers: auth(),
			payload: { level: null },
		});
		expect(cleared.statusCode).toBe(204);
		expect(logger.level).toBe("warn");
	} finally {
		await server.close();
	}
});

test("a successful request logs an info line and a 404 logs a warn line", async () => {
	const { server, requests } = await buildLoggingServer();
	try {
		const ok = await server.inject({
			method: "PUT",
			url: "/log-level",
			headers: auth(),
			payload: { level: "info" },
		});
		expect(ok.statusCode).toBe(204);
		const good = requests()[0];
		expect(good?.level).toBe("info");
		expect(good?.status).toBe(204);
		expect(good?.path).toBe("/log-level");

		const missing = await server.inject({
			method: "DELETE",
			url: `/terminals/${makeId()}`,
			headers: auth(),
		});
		expect(missing.statusCode).toBe(404);
		const bad = requests()[1];
		expect(bad?.level).toBe("warn");
		expect(bad?.status).toBe(404);
		expect(bad?.code).toBe("TERMINAL_NOT_FOUND");
	} finally {
		await server.close();
	}
});

test("the bearer token never reaches a log line", async () => {
	const { server, lines } = await buildLoggingServer("debug");
	try {
		await server.inject({
			method: "PUT",
			url: "/log-level",
			headers: auth(),
			payload: { level: "debug" },
		});
		await server.inject({ method: "GET", url: "/health", headers: auth() });
		expect(lines.length).toBeGreaterThan(0);
		expect(JSON.stringify(lines)).not.toContain(TOKEN);
	} finally {
		await server.close();
	}
});

test.skipIf(!haveTmux)(
	"the agent reports the terminal's directory and repeats itself only on a change",
	async () => {
		const id = makeId();
		const created = await app.inject({
			method: "POST",
			url: "/terminals",
			headers: auth(),
			payload: { id, cwd: homeDir },
		});
		expect(created.statusCode).toBe(201);

		const socket = await openSocket(id);
		await socket.waitFor("$", 1);

		function cwdFrames(): string[] {
			return socket.textFrames
				.filter(
					(frame): frame is { type: string; path: string } =>
						typeof frame === "object" &&
						frame !== null &&
						(frame as { type?: unknown }).type === "cwd",
				)
				.map((frame) => frame.path);
		}

		async function waitForCwd(path: string): Promise<void> {
			const deadline = Date.now() + 5000;
			while (Date.now() < deadline) {
				if (cwdFrames().includes(path)) return;
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			throw new Error(`never saw cwd ${path}, only ${JSON.stringify(cwdFrames())}`);
		}

		// The first poll reports where the terminal started.
		await waitForCwd(await realpath(homeDir));

		socket.ws.send(JSON.stringify({ type: "input", data: "cd /tmp\r" }));
		await waitForCwd("/tmp");

		// Nothing moves for two more polls, so nothing more is sent.
		const settled = cwdFrames();
		await new Promise((resolve) => setTimeout(resolve, 4500));
		expect(cwdFrames()).toEqual(settled);
		// And no path was ever sent twice in a row.
		expect(new Set(settled).size).toBe(settled.length);

		await socket.close();
		await app.inject({ method: "DELETE", url: `/terminals/${id}`, headers: auth() });
	},
	30000,
);
test.skipIf(!haveTmux)("input sent before the first output still runs", async () => {
	const id = makeId();
	const created = await app.inject({
		method: "POST",
		url: "/terminals",
		headers: auth(),
		payload: { id, cwd: homeDir },
	});
	expect(created.statusCode).toBe(201);

	// The marker is assembled by the shell, so seeing it proves the command
	// ran rather than merely being echoed back as typed characters.
	const socket = await openSocket(id, TOKEN, "", 'echo EARLY-"IN"PUT-OK\r');
	expect(socket.output()).toBe("");
	await socket.waitFor("EARLY-INPUT-OK");

	await socket.close();
	await app.inject({ method: "DELETE", url: `/terminals/${id}`, headers: auth() });
});
