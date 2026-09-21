import type { LogLevel } from "@portikus/observability";
import { collectingLogger, lineAt } from "@portikus/observability/testing";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, expect, test } from "vitest";
import { FakeWorkspaceProvider } from "./fake-provider.js";
import { buildServer } from "./server.js";

const TOKEN = "test-token-value";
const AGENT_TOKEN = "a".repeat(64);
let provider: FakeWorkspaceProvider;
let app: FastifyInstance;

beforeEach(() => {
	provider = new FakeWorkspaceProvider();
	app = buildServer({ provider, token: TOKEN });
});

afterEach(async () => {
	await app.close();
});

function auth() {
	return { authorization: `Bearer ${TOKEN}` };
}

// Auth tests.

test("401 without token", async () => {
	const res = await app.inject({
		method: "POST",
		url: "/instances",
		payload: { name: "ws-a", homeGiB: 25, dockerGiB: 20 },
	});
	expect(res.statusCode).toBe(401);
	expect(res.json().code).toBe("UNAUTHORIZED");
});

test("401 with wrong-length token", async () => {
	const res = await app.inject({
		method: "POST",
		url: "/instances",
		payload: { name: "ws-a", homeGiB: 25, dockerGiB: 20 },
		headers: { authorization: "Bearer short" },
	});
	expect(res.statusCode).toBe(401);
});

test("401 with wrong token of same length", async () => {
	const res = await app.inject({
		method: "POST",
		url: "/instances",
		payload: { name: "ws-a", homeGiB: 25, dockerGiB: 20 },
		headers: { authorization: "Bearer wrong-token-valu" },
	});
	expect(res.statusCode).toBe(401);
});

test("GET /health does not require auth", async () => {
	const res = await app.inject({ method: "GET", url: "/health" });
	expect(res.statusCode).toBe(200);
	expect(res.json().service).toBe("workspace-controller");
});

test("a path that merely starts with /health still requires auth", async () => {
	const res = await app.inject({ method: "GET", url: "/healthz" });
	// No such route, so it is a 404 rather than a pass through the exemption.
	expect(res.statusCode).not.toBe(200);
});

test("GET /instances still requires auth", async () => {
	const res = await app.inject({ method: "GET", url: "/instances" });
	expect(res.statusCode).toBe(401);
});

// POST /instances

test("create instance happy path", async () => {
	const res = await app.inject({
		method: "POST",
		url: "/instances",
		headers: auth(),
		payload: { name: "ws-abc", homeGiB: 25, dockerGiB: 20 },
	});
	expect(res.statusCode).toBe(201);
	expect(res.json().created).toBe(true);
});

test("create instance already exists returns 200", async () => {
	await app.inject({
		method: "POST",
		url: "/instances",
		headers: auth(),
		payload: { name: "ws-abc", homeGiB: 25, dockerGiB: 20 },
	});
	const res = await app.inject({
		method: "POST",
		url: "/instances",
		headers: auth(),
		payload: { name: "ws-abc", homeGiB: 25, dockerGiB: 20 },
	});
	expect(res.statusCode).toBe(200);
	expect(res.json().created).toBe(false);
});

test("create with invalid name returns 400", async () => {
	const res = await app.inject({
		method: "POST",
		url: "/instances",
		headers: auth(),
		payload: { name: "INVALID!", homeGiB: 25, dockerGiB: 20 },
	});
	expect(res.statusCode).toBe(400);
	expect(res.json().code).toBe("INVALID_NAME");
});

// POST /instances/:name/start

test("start happy path", async () => {
	await app.inject({
		method: "POST",
		url: "/instances",
		headers: auth(),
		payload: { name: "ws-abc", homeGiB: 25, dockerGiB: 20 },
	});
	const res = await app.inject({
		method: "POST",
		url: "/instances/ws-abc/start",
		headers: auth(),
		payload: { timeoutSeconds: 10, agentToken: AGENT_TOKEN, hostname: "tw7" },
	});
	expect(res.statusCode).toBe(200);
	expect(res.json().ipv4).toBe("10.0.0.2");
});

test("start passes the agent token through to the provider", async () => {
	await app.inject({
		method: "POST",
		url: "/instances",
		headers: auth(),
		payload: { name: "ws-abc", homeGiB: 25, dockerGiB: 20 },
	});
	await app.inject({
		method: "POST",
		url: "/instances/ws-abc/start",
		headers: auth(),
		payload: { timeoutSeconds: 10, agentToken: AGENT_TOKEN, hostname: "tw7" },
	});
	expect(provider.instances.get("ws-abc")?.agentToken).toBe(AGENT_TOKEN);
});

test("start without an agent token returns 400", async () => {
	const res = await app.inject({
		method: "POST",
		url: "/instances/ws-abc/start",
		headers: auth(),
		payload: { timeoutSeconds: 10 },
	});
	expect(res.statusCode).toBe(400);
});

test("start not found returns 404", async () => {
	const res = await app.inject({
		method: "POST",
		url: "/instances/ws-missing/start",
		headers: auth(),
		payload: { timeoutSeconds: 10, agentToken: AGENT_TOKEN, hostname: "tw7" },
	});
	expect(res.statusCode).toBe(404);
});

test("start with invalid name returns 400", async () => {
	const res = await app.inject({
		method: "POST",
		url: "/instances/BAD!/start",
		headers: auth(),
		payload: {},
	});
	expect(res.statusCode).toBe(400);
});

// POST /instances/:name/stop

test("stop happy path", async () => {
	await app.inject({
		method: "POST",
		url: "/instances",
		headers: auth(),
		payload: { name: "ws-abc", homeGiB: 25, dockerGiB: 20 },
	});
	await app.inject({
		method: "POST",
		url: "/instances/ws-abc/start",
		headers: auth(),
		payload: { agentToken: AGENT_TOKEN, hostname: "tw7" },
	});
	const res = await app.inject({
		method: "POST",
		url: "/instances/ws-abc/stop",
		headers: auth(),
		payload: { timeoutSeconds: 5 },
	});
	expect(res.statusCode).toBe(200);
	expect(res.json().forced).toBe(false);
});

test("stop with forced path", async () => {
	await app.inject({
		method: "POST",
		url: "/instances",
		headers: auth(),
		payload: { name: "ws-abc", homeGiB: 25, dockerGiB: 20 },
	});
	provider.setStopHangs(true);
	const res = await app.inject({
		method: "POST",
		url: "/instances/ws-abc/stop",
		headers: auth(),
		payload: { timeoutSeconds: 5 },
	});
	expect(res.statusCode).toBe(200);
	expect(res.json().forced).toBe(true);
});

// GET /instances

test("list instances", async () => {
	await app.inject({
		method: "POST",
		url: "/instances",
		headers: auth(),
		payload: { name: "ws-abc", homeGiB: 25, dockerGiB: 20 },
	});
	const res = await app.inject({
		method: "GET",
		url: "/instances",
		headers: auth(),
	});
	expect(res.statusCode).toBe(200);
	const list = res.json();
	expect(list).toHaveLength(1);
	expect(list[0].name).toBe("ws-abc");
});

// Provider error mapping.

test("INCUS_UNAVAILABLE maps to 503", async () => {
	provider.failNext("INCUS_UNAVAILABLE");
	const res = await app.inject({
		method: "GET",
		url: "/instances",
		headers: auth(),
	});
	expect(res.statusCode).toBe(503);
});

// Single-flight.

test("two concurrent starts cause one provider call", async () => {
	let startCount = 0;
	const original = provider.start.bind(provider);
	provider.start = async (name, opts) => {
		startCount++;
		// Add a small delay to ensure both requests arrive.
		await new Promise((r) => setTimeout(r, 50));
		return original(name, opts);
	};

	await app.inject({
		method: "POST",
		url: "/instances",
		headers: auth(),
		payload: { name: "ws-abc", homeGiB: 25, dockerGiB: 20 },
	});

	const [r1, r2] = await Promise.all([
		app.inject({
			method: "POST",
			url: "/instances/ws-abc/start",
			headers: auth(),
			payload: { timeoutSeconds: 10, agentToken: AGENT_TOKEN, hostname: "tw7" },
		}),
		app.inject({
			method: "POST",
			url: "/instances/ws-abc/start",
			headers: auth(),
			payload: { timeoutSeconds: 10, agentToken: AGENT_TOKEN, hostname: "tw7" },
		}),
	]);

	expect(r1.statusCode).toBe(200);
	expect(r2.statusCode).toBe(200);
	expect(startCount).toBe(1);
});

// Logging (ADR 0012).

function buildLogging(level: LogLevel = "info") {
	const { logger, lines } = collectingLogger(level);
	const logged = buildServer({ provider, token: TOKEN, logger });
	return {
		logged,
		logger,
		lines,
		requests: () => lines.filter((l) => l.msg === "request"),
	};
}

test("PUT /log-level changes the level the controller logs at", async () => {
	// The level has to land on the logger index.ts made, not on Fastify's child
	// of it, or the controller's and provider's own debug lines stay silent.
	const { logged, logger, lines } = buildLogging("info");
	try {
		const res = await logged.inject({
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

		// A line logged through the root logger, outside any request, as the
		// provider's polling line is.
		lines.length = 0;
		logger.debug({ attempt: 1 }, "polling the workspace agent");
		expect(lines).toHaveLength(1);
		expect(lineAt(lines, 0).msg).toBe("polling the workspace agent");

		const cleared = await logged.inject({
			method: "PUT",
			url: "/log-level",
			headers: auth(),
			payload: { level: null },
		});
		expect(cleared.statusCode).toBe(204);
		expect(logger.level).toBe("info");
		lines.length = 0;
		logger.debug({ attempt: 2 }, "polling the workspace agent");
		expect(lines).toHaveLength(0);
	} finally {
		await logged.close();
	}
});

test("PUT /log-level needs the token and a known level", async () => {
	const { logged, logger } = buildLogging();
	try {
		const noToken = await logged.inject({
			method: "PUT",
			url: "/log-level",
			payload: { level: "debug" },
		});
		expect(noToken.statusCode).toBe(401);

		const bad = await logged.inject({
			method: "PUT",
			url: "/log-level",
			headers: auth(),
			payload: { level: "verbose" },
		});
		expect(bad.statusCode).toBe(400);
		expect(bad.json().code).toBe("BAD_REQUEST");
		expect(logger.level).toBe("info");
	} finally {
		await logged.close();
	}
});

test("a null level returns the controller to the level it started with", async () => {
	const { logged, logger } = buildLogging("warn");
	try {
		await logged.inject({
			method: "PUT",
			url: "/log-level",
			headers: auth(),
			payload: { level: "debug" },
		});
		expect(logger.level).toBe("debug");

		const cleared = await logged.inject({
			method: "PUT",
			url: "/log-level",
			headers: auth(),
			payload: { level: null },
		});
		expect(cleared.statusCode).toBe(204);
		expect(logger.level).toBe("warn");
	} finally {
		await logged.close();
	}
});

test("a request logs one line, and an Incus failure names the reason", async () => {
	const { logged, requests } = buildLogging();
	try {
		const ok = await logged.inject({
			method: "GET",
			url: "/instances",
			headers: auth(),
		});
		expect(ok.statusCode).toBe(200);
		expect(requests()[0]?.level).toBe("info");

		provider.failNext("INCUS_UNAVAILABLE");
		const failed = await logged.inject({
			method: "POST",
			url: "/instances",
			headers: auth(),
			payload: { name: "ws-abc", homeGiB: 25, dockerGiB: 20 },
		});
		expect(failed.statusCode).toBe(503);
		const line = requests()[1];
		expect(line?.level).toBe("error");
		expect(line?.code).toBe("INCUS_UNAVAILABLE");
		expect(line?.error).toBe("fake error: INCUS_UNAVAILABLE");
	} finally {
		await logged.close();
	}
});
