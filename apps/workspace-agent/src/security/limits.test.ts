import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_CHECKS_PER_PROJECT } from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, expect, test } from "vitest";
import { buildServer } from "../server.js";

/**
 * The workspace agent's own limits that had no direct test (SPEC.md §9.7,
 * §18.1, §24; BROWSER-HANDLING.md §18; Epic 12a Done item 8): the checks
 * count, the JSON body limit on every route that takes one, the 1 MiB frame
 * limit on its sockets, and the one-line limit on the URL broker socket.
 */

const TOKEN = "e".repeat(64);
const MIB = 1024 * 1024;
const SLUG = "essay";

let app: FastifyInstance;
let homeDir: string;
let port: number;
let brokerPath: string;
const routes: { method: string; url: string }[] = [];

beforeAll(async () => {
	homeDir = await mkdtemp(join(tmpdir(), "pk-agent-limits-"));
	await mkdir(join(homeDir, "projects", SLUG), { recursive: true });
	const tokenPath = join(homeDir, "agent.token");
	await writeFile(tokenPath, TOKEN, { mode: 0o600 });
	brokerPath = join(homeDir, "broker.sock");
	app = buildServer({
		tmuxSocketName: "portikus-test",
		tokenPath,
		homeDir,
		brokerSocketPath: brokerPath,
	});
	app.addHook("onRoute", (route) => {
		const methods = Array.isArray(route.method) ? route.method : [route.method];
		for (const method of methods) routes.push({ method, url: route.url });
	});
	await app.listen({ port: 0, host: "127.0.0.1" });
	port = (app.server.address() as { port: number }).port;
});

afterAll(async () => {
	await app.close();
	await rm(homeDir, { recursive: true, force: true });
});

test("a checks file with more than the allowed checks is refused", async () => {
	const checks = Array.from({ length: MAX_CHECKS_PER_PROJECT + 1 }, (_, n) => ({
		id: `c${n}`,
		name: `Check ${n}`,
		command: "true",
	}));
	await mkdir(join(homeDir, "projects", SLUG, ".portikus"), { recursive: true });
	await writeFile(
		join(homeDir, "projects", SLUG, ".portikus", "checks.json"),
		JSON.stringify({ checks }),
	);
	const response = await app.inject({
		method: "GET",
		url: `/projects/${SLUG}/checks`,
		headers: { authorization: `Bearer ${TOKEN}` },
	});
	expect(response.statusCode).toBe(200);
	expect(response.json().checks).toEqual([]);
	expect(response.json().error).not.toBeNull();
});

test("a JSON body over 1 MiB is refused on every route that takes one", async () => {
	// The file write streams raw bytes and has its own cap tests in files.test.ts.
	const withBody = routes.filter(
		(route) =>
			["POST", "PUT", "PATCH", "DELETE"].includes(route.method) &&
			!(route.method === "PUT" && route.url.endsWith("/file")),
	);
	expect(withBody.length).toBeGreaterThan(5);
	const accepted: string[] = [];
	for (const route of withBody) {
		const response = await app.inject({
			method: route.method as "POST",
			url: route.url.replace(":slug", SLUG).replace(/:[a-zA-Z]+/g, "1"),
			headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
			payload: JSON.stringify({ padding: "x".repeat(MIB) }),
		});
		if (response.statusCode !== 413) {
			accepted.push(`${route.method} ${route.url} ${response.statusCode}`);
		}
	}
	expect(accepted).toEqual([]);
});

test("a frame over 1 MiB on the events socket closes it with 1009", async () => {
	// Node's WebSocket takes request headers as its second argument.
	const ws = new WebSocket(`ws://127.0.0.1:${port}/projects/${SLUG}/events`, {
		headers: { authorization: `Bearer ${TOKEN}` },
	} as unknown as string[]);
	const closed = new Promise<number>((resolve) =>
		ws.addEventListener("close", (event) => resolve(event.code)),
	);
	await new Promise<void>((resolve, reject) => {
		ws.addEventListener("open", () => resolve());
		ws.addEventListener("error", reject);
	});
	ws.send("x".repeat(MIB + 1));
	expect(await closed).toBe(1009);
});

test("a broker line over 8 KiB is refused as too long", async () => {
	const socket = connect(brokerPath);
	const reply = new Promise<string>((resolve) => {
		let text = "";
		socket.on("data", (chunk) => {
			text += chunk.toString();
			if (text.includes("\n")) resolve(text.split("\n")[0] ?? "");
		});
	});
	await new Promise<void>((resolve) => socket.on("connect", () => resolve()));
	socket.write("x".repeat(8193));
	expect(JSON.parse(await reply)).toEqual({ ok: false, reason: "too-long" });
	socket.destroy();
});
