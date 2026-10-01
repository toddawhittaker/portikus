import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
	AGENT_JSON_LIMIT_BYTES,
	AgentCallError,
	callAgent,
	readJson,
	throwOnRedirect,
} from "./index.js";

/**
 * The agent runs in the student's container, so its replies are untrusted:
 * capped bodies, no redirects, and a broken body is a failed agent
 * (SPEC.md §24.6).
 */

let handler: http.RequestListener = () => {};
let server: http.Server;
let port: number;

beforeEach(async () => {
	server = http.createServer((req, res) => handler(req, res));
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	port = (server.address() as AddressInfo).port;
});

afterEach(async () => {
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
});

function call(method = "GET", body?: unknown, timeoutMs = 5000): Promise<unknown> {
	return callAgent(
		{ address: "127.0.0.1", port, token: "secret" },
		method,
		"/x",
		body,
		timeoutMs,
	);
}

function failure(promise: Promise<unknown>): Promise<AgentCallError> {
	return promise.then(
		() => {
			throw new Error("expected a failure");
		},
		(error: unknown) => {
			expect(error).toBeInstanceOf(AgentCallError);
			return error as AgentCallError;
		},
	);
}

test("a call sends the bearer token and JSON body and returns the parsed reply", async () => {
	let seen: { auth?: string; type?: string; body: string; method?: string } = {
		body: "",
	};
	handler = (req, res) => {
		let body = "";
		req.on("data", (chunk) => {
			body += chunk;
		});
		req.on("end", () => {
			seen = {
				auth: req.headers.authorization,
				type: req.headers["content-type"],
				body,
				method: req.method,
			};
			res.writeHead(200, { "content-type": "application/json" });
			res.end('{"ok":true}');
		});
	};
	await expect(call("POST", { a: 1 })).resolves.toEqual({ ok: true });
	expect(seen).toEqual({
		auth: "Bearer secret",
		type: "application/json",
		body: '{"a":1}',
		method: "POST",
	});
});

test("a call without a body sends no content type", async () => {
	let type: string | undefined = "unset";
	handler = (req, res) => {
		type = req.headers["content-type"];
		res.writeHead(204);
		res.end();
	};
	await expect(call("DELETE")).resolves.toBeUndefined();
	expect(type).toBeUndefined();
});

test("a redirect is refused and never followed", async () => {
	let followed = false;
	handler = (req, res) => {
		if (req.url === "/elsewhere") followed = true;
		res.writeHead(307, { location: "/elsewhere" });
		res.end();
	};
	const error = await failure(call());
	expect(error.code).toBe("AGENT_UNAVAILABLE");
	expect(error.message).toBe("The workspace agent redirected");
	expect(followed).toBe(false);
});

test("throwOnRedirect passes any non-3xx answer", () => {
	expect(() => throwOnRedirect(new Response(null, { status: 200 }))).not.toThrow();
	expect(() => throwOnRedirect(new Response(null, { status: 404 }))).not.toThrow();
	expect(() => throwOnRedirect(new Response(null, { status: 302 }))).toThrow(
		AgentCallError,
	);
});

test("a reply past the cap is refused, not buffered", async () => {
	handler = (_req, res) => {
		res.writeHead(200, { "content-type": "application/json" });
		res.end(`"${"x".repeat(AGENT_JSON_LIMIT_BYTES + 10)}"`);
	};
	const error = await failure(call());
	expect(error.code).toBe("AGENT_UNAVAILABLE");
	expect(error.message).toBe("agent response too large");
});

test("readJson honours a caller's larger cap", async () => {
	const big = `"${"x".repeat(AGENT_JSON_LIMIT_BYTES + 10)}"`;
	await expect(
		readJson(new Response(big), 2 * AGENT_JSON_LIMIT_BYTES),
	).resolves.toHaveLength(AGENT_JSON_LIMIT_BYTES + 10);
});

test("a body that breaks mid-stream throws", async () => {
	const broken = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(new TextEncoder().encode('{"a":'));
			controller.error(new Error("reset"));
		},
	});
	const error = await failure(readJson(new Response(broken)));
	expect(error.code).toBe("AGENT_UNAVAILABLE");
	expect(error.message).toBe("The workspace agent could not be reached");
});

test("a connection dropped mid-body throws", async () => {
	handler = (_req, res) => {
		res.writeHead(200, {
			"content-type": "application/json",
			"content-length": "1000",
		});
		res.write('{"a":');
		setTimeout(() => res.destroy(), 20);
	};
	expect((await failure(call())).code).toBe("AGENT_UNAVAILABLE");
});

test("an empty body, no body, or a non-JSON body reads as undefined", async () => {
	await expect(readJson(new Response(""))).resolves.toBeUndefined();
	await expect(readJson(new Response(null))).resolves.toBeUndefined();
	await expect(readJson(new Response("not json"))).resolves.toBeUndefined();
});

test("an error reply keeps the agent's code and the HTTP status", async () => {
	handler = (_req, res) => {
		res.writeHead(404, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: { code: "PROJECT_NOT_FOUND", message: "gone" } }));
	};
	const error = await failure(call());
	expect(error.code).toBe("PROJECT_NOT_FOUND");
	expect(error.message).toBe("gone");
	expect(error.status).toBe(404);
});

test("an error reply without an agent error body is unavailable", async () => {
	handler = (_req, res) => {
		res.writeHead(500);
		res.end("oops");
	};
	const error = await failure(call());
	expect(error.code).toBe("AGENT_UNAVAILABLE");
	expect(error.message).toBe("The workspace agent failed");
	expect(error.status).toBe(500);
});

test("an unreachable or hanging agent is unavailable", async () => {
	handler = () => {};
	const hung = await failure(call("GET", undefined, 100));
	expect(hung.code).toBe("AGENT_UNAVAILABLE");

	const closed = port;
	server.closeAllConnections();
	await new Promise((resolve) => server.close(resolve));
	const down = await failure(
		callAgent(
			{ address: "127.0.0.1", port: closed, token: "t" },
			"GET",
			"/x",
			undefined,
			1000,
		),
	);
	expect(down.message).toBe("The workspace agent could not be reached");
	server = http.createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
});
