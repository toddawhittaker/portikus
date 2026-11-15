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

const CALLER = { apiKey: "portikus_secret", ip: "203.0.113.7", userAgent: "agent/1" };

describe("runOperation", () => {
	test("builds the URL from the catalog pattern and sends the caller's key and address", async () => {
		const result = await runOperation(app, CALLER, "courses.members", {
			path: { courseId: "c1" },
		});
		expect(result).toEqual({ ok: true, status: 200, body: '{"ok":true}' });
		expect(seen).toEqual([
			{
				method: "GET",
				url: "/courses/c1/members",
				ip: "203.0.113.7",
				authorization: "Bearer portikus_secret",
				userAgent: "agent/1",
				contentType: undefined,
				body: undefined,
			},
		]);
	});

	test("a path value is encoded, so it can never name another route", async () => {
		await runOperation(app, CALLER, "courses.members", {
			path: { courseId: "../../admin/users?x=1#y" },
		});
		expect(seen[0]?.url).toBe(
			`/courses/${encodeURIComponent("../../admin/users?x=1#y")}/members`,
		);
	});

	test("query values, lists included, are encoded into the query string", async () => {
		await runOperation(app, CALLER, "users.list", {
			query: { q: "a b&c", page: 2, active: true, tag: ["x", "y"], skip: null },
		});
		expect(seen[0]?.url).toBe("/admin/users?q=a+b%26c&page=2&active=true&tag=x&tag=y");
	});

	test("a JSON body goes with a change, never with a read", async () => {
		await runOperation(app, CALLER, "users.disable", {
			path: { id: "u1" },
			body: { reason: "x" },
		});
		expect(seen[0]).toMatchObject({
			method: "POST",
			url: "/admin/users/u1/disable",
			contentType: "application/json",
			body: { reason: "x" },
		});
		await runOperation(app, CALLER, "users.list", { body: { ignored: true } });
		expect(seen[1]).toMatchObject({ method: "GET", contentType: undefined });
	});

	test("an unknown operation is refused without a request", async () => {
		const result = await runOperation(app, CALLER, "nothing.here", {});
		expect(result).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
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
