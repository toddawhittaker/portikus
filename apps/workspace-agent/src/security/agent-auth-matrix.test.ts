import { randomBytes } from "node:crypto";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { buildServer } from "../server.js";

/**
 * The workspace agent's side of the authorization matrix (Epic 12a, Done
 * item 6; SPEC.md sections 9.7, 23.5, 24). Every route and socket refuses a
 * caller without this workspace's token, and the URL broker socket is
 * reachable only by its owner.
 */

const TOKEN = "a".repeat(64);
// Another workspace's token: same shape, different value.
const OTHER_TOKEN = "b".repeat(64);

let app: FastifyInstance;
let dir: string;
let brokerSocketPath: string;
const routes: Array<{ method: string; url: string; websocket: boolean }> = [];

beforeAll(async () => {
	dir = await mkdtemp(join(tmpdir(), "portikus-agent-authz-"));
	const tokenPath = join(dir, "agent.token");
	await writeFile(tokenPath, `${TOKEN}\n`, { mode: 0o600 });
	brokerSocketPath = join(dir, "run", "browser.sock");
	app = buildServer({
		tokenPath,
		homeDir: dir,
		tmuxSocketName: `portikus-authz-${process.pid}`,
		brokerSocketPath,
	});
	app.addHook("onRoute", (route) => {
		const methods = Array.isArray(route.method) ? route.method : [route.method];
		for (const method of methods) {
			routes.push({ method, url: route.url, websocket: route.websocket === true });
		}
	});
	await app.listen({ port: 0, host: "127.0.0.1" });
});

afterAll(async () => {
	await app?.close();
	await rm(dir, { recursive: true, force: true });
});

/** A concrete URL for a route pattern; the token check comes before any param. */
function concrete(pattern: string): string {
	return pattern
		.replace(":slug", "project")
		.replace(":id", "check-or-terminal")
		.replace(":port", "5173")
		.replace("*", "x");
}

const wrongCallers: Array<[string, Record<string, string>]> = [
	["no token", {}],
	["another workspace's token", { authorization: `Bearer ${OTHER_TOKEN}` }],
	["the token with a key suffix", { authorization: `Bearer ${TOKEN}:a` }],
	["the token without the Bearer scheme", { authorization: TOKEN }],
];

test("the agent registers routes, and none is a test hook", () => {
	// Only the fake agent in apps/api has /__test routes.
	expect(routes.length).toBeGreaterThan(10);
	expect(routes.filter((route) => route.url.startsWith("/__test"))).toEqual([]);
});

test("a caller without the token is refused before its body is parsed", async () => {
	const posts = routes.filter((route) => route.method === "POST" && !route.websocket);
	expect(posts.length).toBeGreaterThan(0);
	for (const route of posts) {
		// Malformed JSON would be a 400 if it were parsed; the token check comes first.
		const res = await app.inject({
			method: "POST",
			url: concrete(route.url),
			headers: { "content-type": "application/json" },
			payload: `{${"x".repeat(900 * 1024)}`,
		});
		expect(res.statusCode, `POST ${route.url}`).toBe(401);
	}
});

describe("every HTTP route refuses a caller without this workspace's token", () => {
	test("each route and caller", async () => {
		const failures: string[] = [];
		for (const route of routes.filter((one) => !one.websocket)) {
			for (const [who, headers] of wrongCallers) {
				const res = await app.inject({
					method: route.method as "GET",
					url: concrete(route.url),
					headers,
				});
				if (res.statusCode !== 401) {
					failures.push(`${route.method} ${route.url} for ${who}: ${res.statusCode}`);
				}
			}
		}
		expect(failures).toEqual([]);

		const granted = await app.inject({
			method: "GET",
			url: "/health",
			headers: { authorization: `Bearer ${TOKEN}` },
		});
		expect(granted.statusCode).toBe(200);
	});
});

/** Ask for an upgrade by hand: 101 if it was granted, else the refusal's status. */
async function upgradeStatus(path: string, headers: Record<string, string>) {
	const { port } = app.server.address() as AddressInfo;
	const request = httpRequest({
		host: "127.0.0.1",
		port,
		// A fresh connection each time: the agent drops a refused upgrade's socket.
		agent: false,
		path,
		headers: {
			...headers,
			connection: "Upgrade",
			upgrade: "websocket",
			"sec-websocket-version": "13",
			"sec-websocket-key": randomBytes(16).toString("base64"),
		},
	});
	return await new Promise<number>((resolve) => {
		request.once("upgrade", (_response, socket) => {
			socket.destroy();
			resolve(101);
		});
		request.once("response", (response) => {
			response.resume();
			resolve(response.statusCode ?? 0);
		});
		request.once("error", () => resolve(0));
		request.end();
	});
}

describe("every socket refuses the upgrade without this workspace's token", () => {
	test("each socket and caller", async () => {
		const sockets = routes.filter((one) => one.websocket && one.method === "GET");
		expect(sockets.length).toBeGreaterThan(0);
		const failures: string[] = [];
		for (const route of sockets) {
			for (const [who, headers] of wrongCallers) {
				const status = await upgradeStatus(concrete(route.url), headers);
				if (status !== 401) failures.push(`${route.url} for ${who}: ${status}`);
			}
		}
		expect(failures).toEqual([]);

		// The right token does get through, so the refusals are the token's.
		const granted = await upgradeStatus("/listening/events", {
			authorization: `Bearer ${TOKEN}`,
		});
		expect(granted).toBe(101);
	});
});

test("the URL broker socket is readable and writable by its owner only", async () => {
	await expect
		.poll(async () => {
			const info = await stat(brokerSocketPath).catch(() => null);
			return info ? info.mode & 0o777 : null;
		})
		.toBe(0o600);
	expect((await stat(brokerSocketPath)).isSocket()).toBe(true);
});
