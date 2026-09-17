import { afterEach, expect, test, vi } from "vitest";
import { z } from "zod";
import { ApiError, request, SessionEndedError } from "./request.js";

const schema = z.object({ ok: z.boolean() });

function stubFetch(response: Response) {
	const fetchStub = vi.fn().mockResolvedValue(response);
	vi.stubGlobal("fetch", fetchStub);
	return fetchStub;
}

function json(body: unknown, status: number): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

afterEach(() => {
	vi.unstubAllGlobals();
});

test("parses a 200 body through the schema and sends the session cookie", async () => {
	const fetchStub = stubFetch(json({ ok: true }, 200));

	await expect(request(schema, "/workspaces/1/projects")).resolves.toEqual({
		ok: true,
	});
	expect(fetchStub).toHaveBeenCalledWith("/workspaces/1/projects", {
		credentials: "same-origin",
	});
});

test("passes init through and keeps same-origin credentials", async () => {
	const fetchStub = stubFetch(json({ ok: true }, 200));

	await request(schema, "/x", { method: "POST", body: "{}" });

	expect(fetchStub).toHaveBeenCalledWith("/x", {
		credentials: "same-origin",
		method: "POST",
		body: "{}",
	});
});

test("a 204 resolves to undefined without touching the schema", async () => {
	stubFetch(new Response(null, { status: 204 }));

	await expect(request(schema, "/x", { method: "DELETE" })).resolves.toBeUndefined();
});

test("a 401 throws SessionEndedError", async () => {
	stubFetch(json({ code: "UNAUTHORIZED", message: "no session" }, 401));

	await expect(request(schema, "/x")).rejects.toBeInstanceOf(SessionEndedError);
});

test("another error carries the status, code and message", async () => {
	stubFetch(json({ code: "WORKSPACE_NOT_FOUND", message: "Workspace not found" }, 404));

	await expect(request(schema, "/x")).rejects.toMatchObject({
		name: "ApiError",
		status: 404,
		code: "WORKSPACE_NOT_FOUND",
		message: "Workspace not found",
	});
});

test("an error body that is not the API shape still throws ApiError", async () => {
	stubFetch(new Response("<html>gateway</html>", { status: 502 }));

	const error = await request(schema, "/x").catch((caught) => caught);
	expect(error).toBeInstanceOf(ApiError);
	expect(error.status).toBe(502);
	expect(error.code).toBeUndefined();
});

test("a 200 body that does not match the schema rejects", async () => {
	stubFetch(json({ ok: "yes" }, 200));

	await expect(request(schema, "/x")).rejects.toThrow();
});
