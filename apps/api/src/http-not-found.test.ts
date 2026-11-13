import Fastify from "fastify";
import { expect, test } from "vitest";
import { sendWorkspaceNotFound } from "./http.js";

test("sendWorkspaceNotFound sends the standard 404 body, cacheable as before", async () => {
	const server = Fastify();
	server.get("/gone", (_request, reply) => sendWorkspaceNotFound(reply));
	const res = await server.inject({ url: "/gone" });
	expect(res.statusCode).toBe(404);
	expect(res.json()).toEqual({
		code: "WORKSPACE_NOT_FOUND",
		message: "Workspace not found",
	});
	expect(res.headers["cache-control"]).toBeUndefined();
});
