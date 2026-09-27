/**
 * The project events WebSocket end to end: a real server, a real watcher,
 * and a real temporary project (SPEC.md §11.4, STACK.md §5).
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FsEvent } from "@portikus/contracts";
import type { FSWatcher } from "chokidar";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, test, vi } from "vitest";
import { buildServer } from "./server.js";
import { ProjectWatchers } from "./watch.js";

const TOKEN = "c".repeat(64);

let app: FastifyInstance;
let homeDir: string;
let port: number;

interface Sock {
	ws: WebSocket;
	frames: unknown[];
	closed: Promise<number>;
	close: () => Promise<void>;
}

async function openEvents(slug: string, at = port): Promise<Sock> {
	const ws = new WebSocket(`ws://127.0.0.1:${at}/projects/${slug}/events`, {
		headers: { authorization: `Bearer ${TOKEN}` },
	} as unknown as string[]);
	const frames: unknown[] = [];
	ws.addEventListener("message", (event) => {
		frames.push(JSON.parse(event.data as string));
	});
	const closed = new Promise<number>((resolve) => {
		ws.addEventListener("close", (event) => resolve(event.code), { once: true });
	});
	await new Promise<void>((resolve) => {
		ws.addEventListener("open", () => resolve(), { once: true });
		ws.addEventListener("close", () => resolve(), { once: true });
	});
	return {
		ws,
		frames,
		closed,
		close: async () => {
			ws.close();
			await closed;
		},
	};
}

/** The frame the agent sends once the watcher is live (SPEC.md §11.4). */
async function waitForReady(socket: Sock): Promise<void> {
	await vi.waitFor(() => expect(socket.frames.length).toBeGreaterThan(0), {
		timeout: 5000,
	});
	expect(socket.frames[0]).toEqual({
		type: "fs",
		paths: [],
		git: true,
		truncated: true,
	});
}

beforeAll(async () => {
	homeDir = await mkdtemp(join(tmpdir(), "portikus-events-"));
	await mkdir(join(homeDir, "projects", "demo"), { recursive: true });
	const tokenPath = join(homeDir, "agent.token");
	await writeFile(tokenPath, `${TOKEN}\n`, { mode: 0o600 });
	app = buildServer({ tmuxSocketName: "portikus-test", tokenPath, homeDir });
	await app.listen({ port: 0, host: "127.0.0.1" });
	port = (app.server.address() as { port: number }).port;
});

afterAll(async () => {
	await app.close();
	await rm(homeDir, { recursive: true, force: true });
});

test("a file written in the project arrives as a frame", async () => {
	const socket = await openEvents("demo");
	// The ready frame says the watcher is live, so one write is enough.
	await waitForReady(socket);
	await writeFile(join(homeDir, "projects", "demo", "hello.txt"), "hi");
	await vi.waitFor(() => expect(socket.frames.length).toBeGreaterThan(1), {
		timeout: 5000,
	});
	const event = socket.frames[1] as FsEvent;
	expect(event.type).toBe("fs");
	expect(event.paths).toContain("hello.txt");
	await socket.close();
});

test("a bad slug closes the socket with 1008", async () => {
	const socket = await openEvents("Bad_Slug");
	expect(await socket.closed).toBe(1008);
	expect(socket.frames[0]).toEqual({ type: "error", code: "INVALID_SLUG" });
});

test("a socket beyond the cap is refused", async () => {
	const other = buildServer({
		tmuxSocketName: "portikus-test",
		tokenPath: join(homeDir, "agent.token"),
		homeDir,
		maxEventSockets: 1,
	});
	await other.listen({ port: 0, host: "127.0.0.1" });
	const otherPort = (other.server.address() as { port: number }).port;
	try {
		const first = await openEvents("demo", otherPort);
		await waitForReady(first);
		const second = await openEvents("demo", otherPort);
		expect(await second.closed).toBe(1008);
		expect(second.frames[0]).toEqual({
			type: "error",
			code: "EVENT_SOCKET_LIMIT",
		});
		await first.close();
	} finally {
		await other.close();
	}
});

test("a missing project closes the socket with 4404", async () => {
	const socket = await openEvents("absent");
	expect(await socket.closed).toBe(4404);
	expect(socket.frames[0]).toEqual({ type: "error", code: "PROJECT_NOT_FOUND" });
});

test("a watcher that fails after start closes the socket with 1011", async () => {
	const watchers = new ProjectWatchers(app.log);
	const other = buildServer({
		tmuxSocketName: "portikus-test",
		tokenPath: join(homeDir, "agent.token"),
		homeDir,
		watchers,
	});
	await other.listen({ port: 0, host: "127.0.0.1" });
	const otherPort = (other.server.address() as { port: number }).port;
	try {
		const socket = await openEvents("demo", otherPort);
		await waitForReady(socket);
		const entries = (
			watchers as unknown as { entries: Map<string, { watcher: FSWatcher }> }
		).entries;
		const broken = [...entries.values()][0]?.watcher;
		broken?.emit("error", Object.assign(new Error("boom"), { code: "EIO" }));
		// The browser retries a 1011 and refetches everything on reopen.
		expect(await socket.closed).toBe(1011);
		expect(socket.frames.at(-1)).toEqual({ type: "error", code: "WATCH_FAILED" });
	} finally {
		await other.close();
	}
});

test("the upgrade needs the token", async () => {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/projects/demo/events`);
	const code = await new Promise<number>((resolve) => {
		ws.addEventListener("close", (event) => resolve(event.code), { once: true });
		ws.addEventListener("error", () => resolve(-1), { once: true });
	});
	expect(code).not.toBe(1000);
});

test("a project past the folder cap sends one watch_limited frame and closes normally", async () => {
	const watchers = new ProjectWatchers(app.log, 0);
	const other = buildServer({
		tmuxSocketName: "portikus-test",
		tokenPath: join(homeDir, "agent.token"),
		homeDir,
		watchers,
	});
	await other.listen({ port: 0, host: "127.0.0.1" });
	const otherPort = (other.server.address() as { port: number }).port;
	try {
		const socket = await openEvents("demo", otherPort);
		expect(await socket.closed).toBe(1000);
		expect(socket.frames).toEqual([{ type: "watch_limited" }]);
	} finally {
		await other.close();
	}
});
