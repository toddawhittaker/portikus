import { describe, expect, test } from "vitest";
import { z } from "zod";
import {
	buildOpenApiDocument,
	type JsonSchema,
	type OpenApiDocument,
	type OperationObject,
} from "./openapi.js";
import type { OperationRecords } from "./types.js";

const OPTIONS = { version: "1.2.3", cookieName: "portikus_session" };

/** A small record set in the shapes the real families use. */
const FAKE: OperationRecords = {
	"GET /admin/users": {
		name: "users.list",
		description: "List the people on the site.",
		risk: "read",
		audience: "administrator",
		tool: true,
		input: { query: z.object({ limit: z.coerce.number().int().optional() }) },
		output: z.object({ users: z.array(z.object({ id: z.string() })) }),
	},
	"PUT /admin/users/:id/settings": {
		name: "users.update_settings",
		description: "Change one person's settings.",
		risk: "change",
		audience: "administrator",
		tool: false,
		input: {
			params: z.object({ id: z.string().uuid() }),
			body: z.object({ quotaGb: z.number().min(1) }),
		},
	},
	"POST /courses/:courseId/members/:userId/remove": {
		name: "courses.remove_member",
		description: "Remove a member from a course.",
		risk: "change",
		audience: "instructor",
		tool: false,
		input: {},
	},
};

function document(): OpenApiDocument {
	return buildOpenApiDocument(FAKE, OPTIONS);
}

/** The `properties` of a JSON Schema object. */
function properties(schema: JsonSchema | undefined): Record<string, unknown> {
	return (schema?.properties ?? {}) as Record<string, unknown>;
}

function bodyOf(part: {
	content?: { "application/json": { schema: JsonSchema } };
}): JsonSchema | undefined {
	return part.content?.["application/json"].schema;
}

/** The one operation a path and method holds, or a failed test. */
function operationAt(
	doc: OpenApiDocument,
	path: string,
	method: string,
): OperationObject {
	const found = doc.paths[path]?.[method];
	if (!found) {
		throw new Error(`no ${method} ${path} in the document`);
	}
	return found;
}

describe("buildOpenApiDocument", () => {
	test("is an OpenAPI 3.1 document with the given version", () => {
		const doc = document();
		expect(doc.openapi).toBe("3.1.0");
		expect(doc.info.version).toBe("1.2.3");
	});

	test("declares a bearer scheme and a cookie scheme and requires either", () => {
		const doc = document();
		expect(doc.components.securitySchemes.bearerAuth).toMatchObject({
			type: "http",
			scheme: "bearer",
		});
		expect(doc.components.securitySchemes.cookieAuth).toMatchObject({
			type: "apiKey",
			in: "cookie",
			name: "portikus_session",
		});
		expect(operationAt(doc, "/admin/users", "get").security).toEqual([
			{ bearerAuth: [] },
			{ cookieAuth: [] },
		]);
	});

	test("writes one operation per record, with path syntax and operation ids", () => {
		const doc = document();
		expect(Object.keys(doc.paths).sort()).toEqual([
			"/admin/users",
			"/admin/users/{id}/settings",
			"/courses/{courseId}/members/{userId}/remove",
		]);
		const put = operationAt(doc, "/admin/users/{id}/settings", "put");
		expect(put.operationId).toBe("users.update_settings");
		expect(put["x-portikus-risk"]).toBe("change");
		expect(put["x-portikus-audience"]).toBe("administrator");
	});

	test("shares a path between methods", () => {
		const list = FAKE["GET /admin/users"];
		if (!list) {
			throw new Error("fixture missing");
		}
		const doc = buildOpenApiDocument(
			{ ...FAKE, "POST /admin/users": { ...list, name: "users.add" } },
			OPTIONS,
		);
		expect(Object.keys(doc.paths["/admin/users"] ?? {}).sort()).toEqual([
			"get",
			"post",
		]);
	});

	test("turns params, query and body into parameters and a request body", () => {
		const doc = document();
		const put = operationAt(doc, "/admin/users/{id}/settings", "put");
		expect(put.parameters).toEqual([
			{ name: "id", in: "path", required: true, schema: expect.any(Object) },
		]);
		expect(put.requestBody?.required).toBe(true);
		expect(
			properties(put.requestBody && bodyOf(put.requestBody)).quotaGb,
		).toMatchObject({
			minimum: 1,
		});
		expect(operationAt(doc, "/admin/users", "get").parameters).toEqual([
			{ name: "limit", in: "query", required: false, schema: expect.any(Object) },
		]);
	});

	test("declares every path parameter even when the record has no params schema", () => {
		const post = operationAt(
			document(),
			"/courses/{courseId}/members/{userId}/remove",
			"post",
		);
		expect(post.parameters?.map((p) => p.name)).toEqual(["courseId", "userId"]);
		expect(post.requestBody).toBeUndefined();
	});

	test("attaches the output schema to the 200 answer and an error body as the default", () => {
		const { responses } = operationAt(document(), "/admin/users", "get");
		expect(properties(bodyOf(responses["200"] ?? {})).users).toBeDefined();
		expect(properties(bodyOf(responses.default ?? {})).code).toBeDefined();
	});

	test("converts refined, piped and transformed schemas without throwing", () => {
		const refined = z
			.object({ from: z.number(), to: z.number() })
			.refine((value) => value.from < value.to);
		const piped = z
			.string()
			.transform((value) => value.length)
			.pipe(z.number());
		const doc = buildOpenApiDocument(
			{
				"POST /admin/odd": {
					name: "odd.run",
					description: "Takes schemas that Zod cannot draw exactly.",
					risk: "change",
					audience: "administrator",
					tool: false,
					input: {
						body: refined,
						query: z.object({ when: z.date().optional(), size: piped }),
					},
				},
			},
			OPTIONS,
		);
		const post = operationAt(doc, "/admin/odd", "post");
		expect(properties(post.requestBody && bodyOf(post.requestBody)).from).toBeDefined();
		expect(post.parameters?.map((p) => p.name)).toEqual(["when", "size"]);
	});

	test("leaves an empty path set for an empty catalog", () => {
		expect(buildOpenApiDocument({}, OPTIONS).paths).toEqual({});
	});
});
