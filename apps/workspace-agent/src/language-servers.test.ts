/**
 * The language-server lifecycle against a scripted server (SPEC.md §13.6):
 * real processes, real sockets, short timings.
 */
import { mkdir, mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import websocket from "@fastify/websocket";
import { CloseCode, type LanguageServerId } from "@portikus/contracts";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	LANGUAGE_SERVERS,
	type LanguageServerEntry,
	pythonPath,
} from "./language-server-table.js";
import {
	type LanguageServerHostOptions,
	mergeOver,
	rewriteInitialize,
} from "./language-servers.js";
import { languageServersRoute } from "./language-servers-route.js";
import {
	initializeRequest,
	type LspSocket,
	openLspSocket,
} from "./test-support/lsp-socket.js";
import { userTaskCount } from "./test-support/user-tasks.js";

const FAKE = fileURLToPath(
	new URL("./test-support/fake-language-server.mjs", import.meta.url),
);

function fakeEntry(
	id: LanguageServerId,
	counted: boolean,
	env: Record<string, string> = {},
): LanguageServerEntry {
	return {
		id,
		languages: [id],
		features: ["completion"],
		counted,
		initializationOptions: { ours: { a: 1 }, flag: true },
		clientCapabilities: { workspace: { configuration: false } },
		resolve: async (projectPath) => ({
			command: process.execPath,
			args: [FAKE],
			env: { ...env, PATH: await pythonPath(projectPath, process.env.PATH ?? "") },
		}),
	};
}

let app: FastifyInstance;
let homeDir: string;
let port: number;
let env: Record<string, string>;
const sockets: LspSocket[] = [];

async function start(overrides: Partial<Omit<LanguageServerHostOptions, "log">> = {}) {
	app = Fastify();
	await app.register(websocket);
	const table = {
		python: fakeEntry("python", true, env),
		typescript: fakeEntry("typescript", true, env),
		ruff: fakeEntry("ruff", false, env),
	};
	await app.register(async (instance) => {
		await instance.register(languageServersRoute, {
			homeDir,
			host: {
				table,
				maxProcesses: (await userTaskCount()) + 2000,
				stopGraceMs: 300,
				...overrides,
			},
		});
	});
	await app.listen({ port: 0, host: "127.0.0.1" });
	const address = app.server.address();
	port = typeof address === "object" && address ? address.port : 0;
}

async function open(slug: string, server: string): Promise<LspSocket> {
	const socket = await openLspSocket(
		`ws://127.0.0.1:${port}/projects/${slug}/language-servers/${server}`,
	);
	sockets.push(socket);
	return socket;
}

/** Open and initialize; returns the params the server received. */
async function ready(
	slug: string,
	server: string,
): Promise<{ socket: LspSocket; received: Record<string, unknown> }> {
	const socket = await open(slug, server);
	socket.send(
		initializeRequest({ initializationOptions: { ours: { a: 2, b: 3 }, theirs: 1 } }),
	);
	const response = await socket.response(1);
	const result = response.result as { received: Record<string, unknown> };
	return { socket, received: result.received };
}

/** The server's pid, from the echo of its environment. */
async function serverPid(socket: LspSocket, id: number): Promise<number> {
	socket.send({ jsonrpc: "2.0", id, method: "test/env" });
	await socket.response(id);
	return Number(await readFile(env.FAKE_PID_FILE as string, "utf8"));
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

beforeEach(async () => {
	homeDir = await mkdtemp(join(tmpdir(), "portikus-lsp-"));
	for (const slug of ["alpha", "beta", "gamma", "delta"]) {
		await mkdir(join(homeDir, "projects", slug), { recursive: true });
	}
	env = { FAKE_PID_FILE: join(homeDir, "pid") };
});

afterEach(async () => {
	for (const socket of sockets.splice(0)) socket.ws.close();
	await app?.close();
	await rm(homeDir, { recursive: true, force: true });
});

describe("initialize", () => {
	test("is pointed at the real project and the agent's pid, with our options winning", async () => {
		await start();
		const { received } = await ready("alpha", "python");
		const root = join(homeDir, "projects", "alpha");
		const uri = pathToFileURL(root).href;
		expect(received.processId).toBe(process.pid);
		expect(received.rootUri).toBe(uri);
		expect(received.rootPath).toBe(root);
		expect(received.workspaceFolders).toEqual([{ uri, name: "alpha" }]);
		expect(received.initializationOptions).toEqual({
			ours: { a: 1, b: 3 },
			theirs: 1,
			flag: true,
		});
		expect(received.capabilities).toEqual({ workspace: { configuration: false } });
	});

	test("everything after it passes through unchanged, both ways", async () => {
		await start();
		const { socket } = await ready("alpha", "python");
		const params = { text: "ünïcode 😀", nested: { rootUri: "file:///left/alone" } };
		socket.send({ jsonrpc: "2.0", id: 2, method: "test/echo", params });
		expect((await socket.response(2)).result).toEqual(params);
		// Nothing from stderr ever reaches the socket.
		expect(JSON.stringify(socket.frames)).not.toContain("noise");
	});

	test("a first message that is not initialize closes the socket", async () => {
		await start();
		const socket = await open("alpha", "python");
		socket.send({ jsonrpc: "2.0", id: 1, method: "test/echo" });
		expect((await socket.closed).code).toBe(CloseCode.POLICY);
	});

	test("a binary frame closes the socket", async () => {
		await start();
		const socket = await open("alpha", "python");
		socket.ws.send(new Uint8Array([1, 2, 3]));
		expect((await socket.closed).code).toBe(CloseCode.POLICY);
	});
});

describe("symlinked home", () => {
	test("keeps the unresolved root for the browser, and runs in the real path", async () => {
		const realHome = homeDir;
		const linkParent = await mkdtemp(join(tmpdir(), "portikus-lsp-link-"));
		homeDir = join(linkParent, "home");
		await symlink(realHome, homeDir);
		try {
			await start();
			const { socket, received } = await ready("alpha", "python");
			const root = join(homeDir, "projects", "alpha");
			expect(received.rootUri).toBe(pathToFileURL(root).href);
			expect(received.rootPath).toBe(root);
			expect(received.workspaceFolders).toEqual([
				{ uri: pathToFileURL(root).href, name: "alpha" },
			]);
			socket.send({ jsonrpc: "2.0", id: 2, method: "test/env" });
			const result = (await socket.response(2)).result as { cwd: string };
			expect(result.cwd).toBe(await realpath(join(realHome, "projects", "alpha")));
		} finally {
			await rm(linkParent, { recursive: true, force: true });
			homeDir = realHome;
		}
	});
});

describe("environment", () => {
	test("runs in the project with its .venv/bin first on PATH", async () => {
		await mkdir(join(homeDir, "projects", "alpha", ".venv", "bin"), {
			recursive: true,
		});
		await start();
		const { socket } = await ready("alpha", "python");
		socket.send({ jsonrpc: "2.0", id: 2, method: "test/env" });
		const result = (await socket.response(2)).result as { path: string; cwd: string };
		expect(result.cwd).toBe(join(homeDir, "projects", "alpha"));
		expect(result.path.split(":")[0]).toBe(
			join(homeDir, "projects", "alpha", ".venv", "bin"),
		);
	});

	test("starts under prlimit and choom", async () => {
		await start();
		const { socket } = await ready("alpha", "python");
		const pid = await serverPid(socket, 2);
		const score = (await readFile(`/proc/${pid}/oom_score_adj`, "utf8")).trim();
		expect(score).toBe("500");
		const limits = await readFile(`/proc/${pid}/limits`, "utf8");
		expect(limits).toMatch(/Max processes\s+(\d+)\s+\1\s+processes/);
	});
});

describe("one window at a time", () => {
	test("a second socket replaces the first and restarts the server", async () => {
		await start();
		const first = await ready("alpha", "python");
		const firstPid = await serverPid(first.socket, 2);
		const second = await ready("alpha", "python");
		expect((await first.socket.closed).code).toBe(CloseCode.LANGUAGE_SERVER_REPLACED);
		const secondPid = await serverPid(second.socket, 3);
		expect(secondPid).not.toBe(firstPid);
		await vi.waitFor(() => expect(alive(firstPid)).toBe(false), { timeout: 3000 });
	});
});

describe("stopping", () => {
	test("the server stops a while after its last socket closes", async () => {
		await start({ lingerMs: 200 });
		const { socket } = await ready("alpha", "python");
		const pid = await serverPid(socket, 2);
		socket.ws.close();
		await socket.closed;
		expect(alive(pid)).toBe(true);
		await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 3000 });
	});

	test("a server that ignores shutdown and exit is killed with its tree", async () => {
		env.FAKE_IGNORE_EXIT = "1";
		await start({ lingerMs: 50, stopGraceMs: 200 });
		const { socket } = await ready("alpha", "python");
		const pid = await serverPid(socket, 2);
		socket.ws.close();
		await socket.closed;
		await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 3000 });
	});

	test("a socket with no browser message closes with IDLE, then the server stops", async () => {
		await start({ idleMs: 300, lingerMs: 50 });
		const { socket } = await ready("alpha", "python");
		const pid = await serverPid(socket, 2);
		expect((await socket.closed).code).toBe(CloseCode.LANGUAGE_SERVER_IDLE);
		await vi.waitFor(() => expect(alive(pid)).toBe(false), { timeout: 3000 });
	});

	test("browser messages keep the socket open", async () => {
		await start({ idleMs: 400 });
		const { socket } = await ready("alpha", "python");
		for (let id = 2; id < 8; id += 1) {
			await new Promise((resolve) => setTimeout(resolve, 150));
			socket.send({ jsonrpc: "2.0", id, method: "test/echo" });
			await socket.response(id);
		}
		expect(socket.ws.readyState).toBe(WebSocket.OPEN);
	});
});

describe("the cap of three", () => {
	test("a fourth counted server stops the least recently used one with IDLE", async () => {
		await start();
		const alpha = await ready("alpha", "python");
		const beta = await ready("beta", "typescript");
		const gamma = await ready("gamma", "python");
		// alpha is used again, so beta is now the least recently used.
		alpha.socket.send({ jsonrpc: "2.0", id: 2, method: "test/echo" });
		await alpha.socket.response(2);
		const delta = await ready("delta", "python");
		expect((await beta.socket.closed).code).toBe(CloseCode.LANGUAGE_SERVER_IDLE);
		for (const { socket } of [alpha, gamma, delta]) {
			expect(socket.ws.readyState).toBe(WebSocket.OPEN);
		}
	});

	test("ruff is not counted", async () => {
		await start();
		const counted = [
			await ready("alpha", "python"),
			await ready("beta", "python"),
			await ready("gamma", "typescript"),
		];
		const ruffs = [await ready("alpha", "ruff"), await ready("beta", "ruff")];
		for (const { socket } of [...counted, ...ruffs]) {
			expect(socket.ws.readyState).toBe(WebSocket.OPEN);
		}
	});
});

describe("crashes", () => {
	test("an exit the agent did not cause closes with CRASHED", async () => {
		await start();
		const { socket } = await ready("alpha", "python");
		socket.send({ jsonrpc: "2.0", id: 2, method: "test/crash" });
		expect(await socket.closed).toEqual({
			code: CloseCode.LANGUAGE_SERVER_CRASHED,
			reason: "crashed",
		});
	});

	test("a kill the agent did not send says it may have run out of memory", async () => {
		await start();
		const { socket } = await ready("alpha", "python");
		socket.send({ jsonrpc: "2.0", id: 2, method: "test/selfKill" });
		const closed = await socket.closed;
		expect(closed.code).toBe(CloseCode.LANGUAGE_SERVER_CRASHED);
		expect(closed.reason).toBe("crashed: may have run out of memory");
	});

	test("three crashes in the window make it UNAVAILABLE for a while", async () => {
		await start({ unavailableMs: 500 });
		for (const expected of [
			CloseCode.LANGUAGE_SERVER_CRASHED,
			CloseCode.LANGUAGE_SERVER_CRASHED,
			CloseCode.LANGUAGE_SERVER_UNAVAILABLE,
		]) {
			const { socket } = await ready("alpha", "python");
			socket.send({ jsonrpc: "2.0", id: 2, method: "test/crash" });
			expect((await socket.closed).code).toBe(expected);
		}
		const refused = await open("alpha", "python");
		expect((await refused.closed).code).toBe(CloseCode.LANGUAGE_SERVER_UNAVAILABLE);
		// Another project's server is not affected.
		const other = await ready("beta", "python");
		expect(other.socket.ws.readyState).toBe(WebSocket.OPEN);

		await new Promise((resolve) => setTimeout(resolve, 600));
		const again = await ready("alpha", "python");
		expect(again.socket.ws.readyState).toBe(WebSocket.OPEN);
	});

	test("crashes outside the window do not add up", async () => {
		await start({ crashWindowMs: 200 });
		for (let round = 0; round < 3; round += 1) {
			const { socket } = await ready("alpha", "python");
			socket.send({ jsonrpc: "2.0", id: 2, method: "test/crash" });
			expect((await socket.closed).code).toBe(CloseCode.LANGUAGE_SERVER_CRASHED);
			await new Promise((resolve) => setTimeout(resolve, 250));
		}
	});

	test("a server that is not installed is UNAVAILABLE", async () => {
		app = Fastify();
		await app.register(websocket);
		await app.register(languageServersRoute, {
			homeDir,
			host: {
				table: {
					...LANGUAGE_SERVERS,
					python: { ...LANGUAGE_SERVERS.python, resolve: async () => null },
				},
			},
		});
		await app.listen({ port: 0, host: "127.0.0.1" });
		const address = app.server.address();
		port = typeof address === "object" && address ? address.port : 0;
		const socket = await open("alpha", "python");
		expect((await socket.closed).code).toBe(CloseCode.LANGUAGE_SERVER_UNAVAILABLE);
	});
});

describe("frame limit", () => {
	test("an oversized response becomes an error for the same id", async () => {
		await start({ maxFrameBytes: 10_000 });
		const { socket } = await ready("alpha", "python");
		socket.send({
			jsonrpc: "2.0",
			id: 2,
			method: "test/big",
			params: { bytes: 50_000 },
		});
		const response = await socket.response(2);
		expect(response.error).toMatchObject({ code: -32803 });
		expect(response.result).toBeUndefined();
		// An oversized notification is dropped, and the socket carries on.
		socket.send({
			jsonrpc: "2.0",
			id: 3,
			method: "test/bigNotification",
			params: { bytes: 50_000 },
		});
		await socket.response(3);
		expect(socket.frames.some((frame) => frame.method === "test/note")).toBe(false);
	});
});

describe("route", () => {
	test("an unknown server id is UNAVAILABLE", async () => {
		await start();
		const socket = await open("alpha", "clangd");
		expect((await socket.closed).code).toBe(CloseCode.LANGUAGE_SERVER_UNAVAILABLE);
	});

	test("a missing project is NOT_FOUND", async () => {
		await start();
		const socket = await open("nope", "python");
		expect((await socket.closed).code).toBe(CloseCode.NOT_FOUND);
	});

	test("shutting the agent down stops every server", async () => {
		await start();
		const { socket } = await ready("alpha", "python");
		const pid = await serverPid(socket, 2);
		await app.close();
		expect(alive(pid)).toBe(false);
	});
});

describe("helpers", () => {
	test("mergeOver merges objects and lets ours replace other values", () => {
		expect(
			mergeOver({ a: { b: 1, c: 2 }, d: [1] }, { a: { b: 9 }, d: { e: 1 } }),
		).toEqual({
			a: { b: 9, c: 2 },
			d: { e: 1 },
		});
		expect(mergeOver(null, { a: 1 })).toEqual({ a: 1 });
	});

	test("rewriteInitialize refuses what is not an initialize request", () => {
		const options = {
			rootPath: "/home/s/projects/p",
			slug: "p",
			entry: LANGUAGE_SERVERS.python,
			pid: 1,
		};
		expect(rewriteInitialize("not json", options)).toBeNull();
		expect(rewriteInitialize('{"method":"initialize"}', options)).toBeNull();
		expect(rewriteInitialize('{"id":1,"method":"initialized"}', options)).toBeNull();
		const rewritten = JSON.parse(
			rewriteInitialize(
				'{"jsonrpc":"2.0","id":1,"method":"initialize"}',
				options,
			) as string,
		);
		expect(rewritten.params.rootUri).toBe("file:///home/s/projects/p");
	});
});
