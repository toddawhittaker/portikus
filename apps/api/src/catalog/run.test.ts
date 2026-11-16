import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { runOperation } from "./run.js";

/**
 * The in-process runner (SPEC.md sections 24.8 and 27): the URL comes only
 * from the catalog's pattern, every path value is encoded into one segment,
 * and the request carries the caller's own key and address.
 */

interface Seen {
	method: string;
	url: string;
	ip: string;
	authorization: string | undefined;
	userAgent: string | undefined;
	contentType: string | undefined;
	body: unknown;
}

let app: FastifyInstance;
let seen: Seen[];

beforeEach(async () => {
	seen = [];
	app = Fastify();
	app.all("*", async (request) => {
		seen.push({
			method: request.method,
			url: request.url,
			ip: request.ip,
			authorization: request.headers.authorization,
			userAgent: request.headers["user-agent"],
			contentType: request.headers["content-type"],
			body: request.body,
		});
		return { ok: true };
	});
	await app.ready();
});

afterEach(async () => {
	await app.close();
});

const COURSE = "0b9d8a7e-2c1f-4d6a-9f3e-5a4b3c2d1e0f";
const PERSON = "7f1e2d3c-4b5a-4968-8a7b-6c5d4e3f2a1b";
const CALLER = { apiKey: "portikus_secret", ip: "203.0.113.7", userAgent: "agent/1" };

describe("runOperation", () => {
	test("builds the URL from the catalog pattern and sends the caller's key and address", async () => {
		const result = await runOperation(app, CALLER, "courses.members", {
			path: { courseId: COURSE },
		});
		expect(result).toEqual({ ok: true, status: 200, body: '{"ok":true}' });
		expect(seen).toEqual([
			{
				method: "GET",
				url: `/courses/${COURSE}/members`,
				ip: "203.0.113.7",
				authorization: "Bearer portikus_secret",
				userAgent: "agent/1",
				contentType: undefined,
				body: undefined,
			},
		]);
	});

	test.each(["search", "c1", "a b?x=1#y%2F", "1", COURSE.toUpperCase().slice(1)])(
		"a path value of %j is not a uuid, so it is refused without a request",
		async (courseId) => {
			const result = await runOperation(app, CALLER, "courses.members", {
				path: { courseId },
			});
			expect(result).toMatchObject({
				ok: false,
				error: {
					code: "VALIDATION_FAILED",
					message: expect.stringContaining("courseId"),
				},
			});
			expect(seen).toEqual([]);
		},
	);

	test("a fixed route beside /admin/users/:id is never reached with a word for an id", async () => {
		const result = await runOperation(app, CALLER, "users.disable", {
			path: { id: "search" },
		});
		expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
		expect(seen).toEqual([]);
	});

	test.each([".", "..", "../../admin/users", "a/b", "/"])(
		"a path value of %j could name another route, so it is refused without a request",
		async (courseId) => {
			const result = await runOperation(app, CALLER, "courses.members", {
				path: { courseId },
			});
			expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
			expect(seen).toEqual([]);
		},
	);

	test("an id of .. is refused before any request", async () => {
		const result = await runOperation(app, CALLER, "users.disable", {
			path: { id: ".." },
		});
		expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
		expect(seen).toEqual([]);
	});

	test("a path value the operation does not name is refused without a request", async () => {
		const result = await runOperation(app, CALLER, "courses.members", {
			path: { courseId: COURSE, userId: PERSON },
		});
		expect(result).toMatchObject({
			ok: false,
			error: { code: "VALIDATION_FAILED", message: expect.stringContaining("userId") },
		});
		expect(seen).toEqual([]);
	});

	test("query values, lists included, are encoded into the query string", async () => {
		await runOperation(app, CALLER, "users.list", {
			query: { q: "a b&c", page: 2, active: true, tag: ["x", "y"], skip: null },
		});
		expect(seen[0]?.url).toBe("/admin/users?q=a+b%26c&page=2&active=true&tag=x&tag=y");
	});

	test("a JSON body goes with a change, never with a read", async () => {
		await runOperation(app, CALLER, "users.disable", {
			path: { id: PERSON },
			body: { reason: "x" },
		});
		expect(seen[0]).toMatchObject({
			method: "POST",
			url: `/admin/users/${PERSON}/disable`,
			contentType: "application/json",
			body: { reason: "x" },
		});
		await runOperation(app, CALLER, "users.list", { body: { ignored: true } });
		expect(seen[1]).toMatchObject({ method: "GET", contentType: undefined });
	});

	test("an unknown operation is refused without a request", async () => {
		const result = await runOperation(app, CALLER, "nothing.here", {});
		expect(result).toMatchObject({
			ok: false,
			error: { code: "NOT_AVAILABLE_TO_API_KEYS" },
		});
		expect(seen).toEqual([]);
	});

	test.each([{}, { courseId: "" }, { courseId: { nested: 1 } }])(
		"a missing or unusable path value (%j) is refused without a request",
		async (path) => {
			const result = await runOperation(app, CALLER, "courses.members", { path });
			expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
			expect(seen).toEqual([]);
		},
	);

	test("a nested query value is refused without a request", async () => {
		const result = await runOperation(app, CALLER, "users.list", {
			query: { filter: { a: 1 } },
		});
		expect(result).toMatchObject({ ok: false, error: { code: "VALIDATION_FAILED" } });
		expect(seen).toEqual([]);
	});
});
