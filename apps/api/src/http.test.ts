import Fastify from "fastify";
import { expect, test } from "vitest";
import {
	escapeHtml,
	parseOr400,
	sendError,
	sendNoStoreError,
	UuidParam,
} from "./http.js";

const ID = "8d0e7f4e-2b8a-4e57-9a3c-1f0c2a7b9d11";

function app() {
	const server = Fastify();
	server.get("/plain", (_request, reply) =>
		sendError(reply, 404, "WORKSPACE_NOT_FOUND", "Workspace not found"),
	);
	server.get("/no-store", (_request, reply) =>
		sendNoStoreError(reply, 503, "LOGS_UNAVAILABLE", "down"),
	);
	server.get("/item/:id", (request, reply) => {
		const params = parseOr400(UuidParam, request.params, reply);
		if (!params) return;
		return reply.send({ id: params.id });
	});
	server.get("/named/:id", (request, reply) => {
		const params = parseOr400(UuidParam, request.params, reply, "invalid entry id");
		if (!params) return;
		return reply.send({ id: params.id });
	});
	return server;
}

test("sendError sends the code and message body with the status", async () => {
	const res = await app().inject({ url: "/plain" });
	expect(res.statusCode).toBe(404);
	expect(res.json()).toEqual({
		code: "WORKSPACE_NOT_FOUND",
		message: "Workspace not found",
	});
	expect(res.headers["cache-control"]).toBeUndefined();
});

test("sendNoStoreError adds cache-control: no-store", async () => {
	const res = await app().inject({ url: "/no-store" });
	expect(res.statusCode).toBe(503);
	expect(res.headers["cache-control"]).toBe("no-store");
	expect(res.json()).toEqual({ code: "LOGS_UNAVAILABLE", message: "down" });
});

test("parseOr400 returns the parsed value", async () => {
	const res = await app().inject({ url: `/item/${ID}` });
	expect(res.json()).toEqual({ id: ID });
});

test("parseOr400 sends a 400 with the validation message by default", async () => {
	const res = await app().inject({ url: "/item/nope" });
	expect(res.statusCode).toBe(400);
	const body = res.json();
	expect(body.code).toBe("VALIDATION_FAILED");
	expect(body.message).toBe(UuidParam.safeParse({ id: "nope" }).error?.message);
});

test("parseOr400 uses the caller's message when given", async () => {
	const res = await app().inject({ url: "/named/nope" });
	expect(res.statusCode).toBe(400);
	expect(res.json()).toEqual({
		code: "VALIDATION_FAILED",
		message: "invalid entry id",
	});
});

test("escapeHtml escapes the five HTML-significant characters", () => {
	expect(escapeHtml(`<a href="x">Tom & Jerry's</a>`)).toBe(
		"&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;",
	);
});
