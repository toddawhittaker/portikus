import Fastify from "fastify";
import { expect, test } from "vitest";
import { quietLogController, registerRequestLogging } from "./fastify.js";
import type { LogLevel } from "./logger.js";
import { collectingLogger, lineAt } from "./testing.js";

function buildApp(level: LogLevel = "info") {
	const { logger, lines } = collectingLogger(level);
	const app = Fastify({ loggerInstance: logger, logController: quietLogController() });
	registerRequestLogging(app, { debugPaths: ["/health"] });

	app.get("/health", async () => ({ status: "ok" }));
	app.get("/ok", async () => ({ ok: true }));
	app.get("/x", async () => ({ ok: true }));
	app.get("/forbidden", async (_request, reply) =>
		reply.code(403).send({ code: "FORBIDDEN", message: "no" }),
	);
	app.get("/agent-shaped", async (_request, reply) =>
		reply.code(409).send({ error: { code: "CONFLICT", message: "already running" } }),
	);
	app.get("/boom", async () => {
		throw new Error("kaboom");
	});
	app.get("/workspaces/:id", async () => ({ ok: true }));
	app.get("/admin/users/:id/settings", async () => ({ ok: true }));
	app.get("/long", async (_request, reply) =>
		reply.code(400).send({ code: "BAD_REQUEST", message: "x".repeat(500) }),
	);
	app.get("/whoami", async (request) => {
		(request as { user?: { id: string } }).user = { id: "user-1" };
		return { ok: true };
	});

	const requests = () => lines.filter((line) => line.msg === "request");
	return { app, lines, requests };
}

test("a successful request logs one info line with the request id", async () => {
	const { app, requests } = buildApp();
	await app.inject({ method: "GET", url: "/ok" });
	expect(requests()).toHaveLength(1);
	const line = lineAt(requests(), 0);
	expect(line.level).toBe("info");
	expect(line.method).toBe("GET");
	expect(line.route).toBe("/ok");
	expect(line.path).toBe("/ok");
	expect(line.status).toBe(200);
	expect(typeof line.durationMs).toBe("number");
	expect(typeof line.reqId).toBe("string");
});

test("a debug path is silent at info and logged at debug", async () => {
	const quiet = buildApp("info");
	await quiet.app.inject({ method: "GET", url: "/health" });
	expect(quiet.requests()).toHaveLength(0);

	const loud = buildApp("debug");
	await loud.app.inject({ method: "GET", url: "/health" });
	expect(lineAt(loud.requests(), 0).level).toBe("debug");
});

test("an unmatched route logs a warn line with Fastify's own message", async () => {
	const { app, requests } = buildApp();
	await app.inject({ method: "GET", url: "/nope" });
	const line = lineAt(requests(), 0);
	expect(line.level).toBe("warn");
	expect(line.status).toBe(404);
	expect(line.route).toBeNull();
	expect(line.error).toContain("Route GET:/nope not found");
});

test("an error body's code and message reach the line", async () => {
	const { app, requests } = buildApp();
	await app.inject({ method: "GET", url: "/forbidden" });
	const line = lineAt(requests(), 0);
	expect(line.level).toBe("warn");
	expect(line.status).toBe(403);
	expect(line.code).toBe("FORBIDDEN");
	expect(line.error).toBe("no");
});

test("the agent's nested error shape is extracted too", async () => {
	const { app, requests } = buildApp();
	await app.inject({ method: "GET", url: "/agent-shaped" });
	const line = lineAt(requests(), 0);
	expect(line.code).toBe("CONFLICT");
	expect(line.error).toBe("already running");
});

test("a thrown error logs at error level with status 500", async () => {
	const { app, requests } = buildApp();
	await app.inject({ method: "GET", url: "/boom" });
	const line = lineAt(requests(), 0);
	expect(line.level).toBe("error");
	expect(line.status).toBe(500);
});

test("a query string never reaches the line", async () => {
	const { app, lines, requests } = buildApp();
	await app.inject({ method: "GET", url: "/x?token=abc" });
	expect(lineAt(requests(), 0).path).toBe("/x");
	expect(JSON.stringify(lines)).not.toContain("abc");
});

test("an id outside a workspace route is not labelled as a workspace", async () => {
	const { app, requests } = buildApp();
	await app.inject({ method: "GET", url: "/admin/users/u-1/settings" });
	expect(lineAt(requests(), 0).workspaceId).toBeUndefined();
});

test("a very long error message is cut to 200 characters", async () => {
	const { app, requests } = buildApp();
	await app.inject({ method: "GET", url: "/long" });
	const error = lineAt(requests(), 0).error as string;
	expect(error).toHaveLength(201);
	expect(error.endsWith("\u2026")).toBe(true);
});

test("the workspace id and the signed-in user are named when known", async () => {
	const { app, requests } = buildApp();
	await app.inject({ method: "GET", url: "/workspaces/w-1" });
	expect(lineAt(requests(), 0).workspaceId).toBe("w-1");

	await app.inject({ method: "GET", url: "/whoami" });
	expect(lineAt(requests(), 1).userId).toBe("user-1");
});
