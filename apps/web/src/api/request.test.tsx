import { afterEach, expect, test, vi } from "vitest";
import { z } from "zod";
import {
	ApiError,
	errorText,
	request,
	SessionEndedError,
	SOMETHING_WENT_WRONG,
	sendJson,
} from "./request.js";

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

test("sendJson sends the body as JSON, by POST unless told otherwise", async () => {
	const fetchStub = stubFetch(json({ ok: true }, 200));
	await expect(sendJson(schema, "/things", { a: 1 })).resolves.toEqual({ ok: true });
	expect(fetchStub).toHaveBeenCalledWith("/things", {
		credentials: "same-origin",
		method: "POST",
		headers: { "content-type": "application/json" },
		body: '{"a":1}',
	});

	const patchStub = stubFetch(json({ ok: true }, 200));
	await sendJson(schema, "/things/1", { a: 2 }, "PATCH");
	expect(patchStub.mock.calls[0]?.[1]?.method).toBe("PATCH");
});

test("errorText shows the API's sentence, or the fallback for anything else", () => {
	expect(errorText(new ApiError(409, "Name taken.", "CONFLICT"))).toBe("Name taken.");
	expect(errorText(new Error("boom"))).toBe(SOMETHING_WENT_WRONG);
	expect(SOMETHING_WENT_WRONG).toBe("Something went wrong. Please try again.");
});

test("errorText never shows a raw exception message, only the caller's fallback", () => {
	const fallback = "The checks could not be saved. Try again.";
	expect(errorText(new TypeError("Failed to fetch"), fallback)).toBe(fallback);
	expect(errorText("boom", fallback)).toBe(fallback);
	expect(errorText(new ApiError(403, "Not yours.", "FORBIDDEN"), fallback)).toBe(
		"Not yours.",
	);
});
