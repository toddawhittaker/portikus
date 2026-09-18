/**
 * The project events WebSocket end to end: a real server, a real watcher,
 * and a real temporary project (SPEC.md §11.4, STACK.md §5).
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FsEvent } from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, test } from "vitest";
import { buildServer } from "./server.js";

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

async function openEvents(slug: string): Promise<Sock> {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/projects/${slug}/events`, {
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

async function waitFor(check: () => boolean, ms = 3000): Promise<void> {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

beforeAll(async () => {
	homeDir = await mkdtemp(join(tmpdir(), "portikus-events-"));
	await mkdir(join(homeDir, "projects", "demo"), { recursive: true });
	const tokenPath = join(homeDir, "agent.token");
	await writeFile(tokenPath, `${TOKEN}\n`, { mode: 0o600 });
	app = buildServer({ tokenPath, homeDir });
	await app.listen({ port: 0, host: "127.0.0.1" });
	port = (app.server.address() as { port: number }).port;
});

afterAll(async () => {
	await app.close();
	await rm(homeDir, { recursive: true, force: true });
});

test("a file written in the project arrives as a frame", async () => {
	const socket = await openEvents("demo");
	// The upgrade completes before the watcher is ready, so keep touching the
	// file until a frame comes back.
	const writing = setInterval(() => {
		void writeFile(join(homeDir, "projects", "demo", "hello.txt"), "hi");
	}, 100);
	await waitFor(() => socket.frames.length > 0);
	clearInterval(writing);
	const event = socket.frames[0] as FsEvent;
	expect(event.type).toBe("fs");
	expect(event.paths).toContain("hello.txt");
	await socket.close();
});

test("a missing project closes the socket with 4404", async () => {
	const socket = await openEvents("absent");
	expect(await socket.closed).toBe(4404);
	expect(socket.frames[0]).toEqual({ type: "error", code: "PROJECT_NOT_FOUND" });
});

test("the upgrade needs the token", async () => {
	const ws = new WebSocket(`ws://127.0.0.1:${port}/projects/demo/events`);
	const code = await new Promise<number>((resolve) => {
		ws.addEventListener("close", (event) => resolve(event.code), { once: true });
		ws.addEventListener("error", () => resolve(-1), { once: true });
	});
	expect(code).not.toBe(1000);
});
