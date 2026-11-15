import { ApiError } from "@portikus/contracts";
import { z } from "zod";
import { splitKey } from "../security/route-policy.js";
import type { Audience, Operation, OperationRecords, Risk } from "./types.js";

/** A JSON Schema object as Zod writes it. */
export type JsonSchema = Record<string, unknown>;

interface Parameter {
	name: string;
	in: "path" | "query";
	required: boolean;
	schema: JsonSchema;
}

interface JsonContent {
	content?: { "application/json": { schema: JsonSchema } };
}

export interface OperationObject {
	operationId: string;
	summary: string;
	tags: string[];
	parameters?: Parameter[];
	requestBody?: JsonContent & { required: boolean };
	responses: Record<string, JsonContent & { description: string }>;
	security: Record<string, string[]>[];
	"x-portikus-risk": Risk;
	"x-portikus-audience": Audience;
}

export interface OpenApiDocument {
	openapi: "3.1.0";
	info: { title: string; version: string; description: string };
	paths: Record<string, Record<string, OperationObject>>;
	components: { securitySchemes: Record<string, Record<string, string>> };
}

export interface OpenApiOptions {
	/** The document's own version, normally the build's. */
	version: string;
	/** The name of the session cookie the site uses (it changes with HTTPS). */
	cookieName: string;
}

function toSchema(schema: z.ZodType): JsonSchema {
	// The input side is what a caller sends; `any` keeps a transform or date from failing.
	const { $schema: _ignored, ...rest } = z.toJSONSchema(schema, {
		io: "input",
		unrepresentable: "any",
	}) as JsonSchema;
	return rest;
}

/** `/courses/:courseId/members` becomes `/courses/{courseId}/members`. */
function openApiPath(url: string): string {
	return url.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

function pathParameterNames(url: string): string[] {
	return [...url.matchAll(/:([A-Za-z0-9_]+)/g)].map((match) => match[1] as string);
}

/** Turn an object schema's properties into parameters of one kind. */
function parametersOf(
	where: "path" | "query",
	schema: z.ZodType | undefined,
	forcedNames: readonly string[] = [],
): Parameter[] {
	const json = schema === undefined ? {} : toSchema(schema);
	const properties = (json.properties ?? {}) as Record<string, JsonSchema>;
	const required = new Set((json.required ?? []) as string[]);
	const names = [...new Set([...forcedNames, ...Object.keys(properties)])];
	return names.map((name) => ({
		name,
		in: where,
		// An OpenAPI path parameter is always required.
		required: where === "path" || required.has(name),
		schema: properties[name] ?? { type: "string" },
	}));
}

function operationObject(operation: Operation, url: string): OperationObject {
	const parameters = [
		...parametersOf("path", operation.input.params, pathParameterNames(url)),
		...parametersOf("query", operation.input.query),
	];
	const success = {
		description: "The operation's result.",
		...(operation.output
			? { content: { "application/json": { schema: toSchema(operation.output) } } }
			: {}),
	};
	return {
		operationId: operation.name,
		summary: operation.description,
		tags: [operation.name.split(".")[0] ?? operation.name],
		...(parameters.length > 0 ? { parameters } : {}),
		...(operation.input.body
			? {
					requestBody: {
						required: true,
						content: {
							"application/json": { schema: toSchema(operation.input.body) },
						},
					},
				}
			: {}),
		responses: {
			"200": success,
			default: {
				description: "An error, with a code and a message.",
				content: { "application/json": { schema: toSchema(ApiError) } },
			},
		},
		security: [{ bearerAuth: [] }, { cookieAuth: [] }],
		"x-portikus-risk": operation.risk,
		"x-portikus-audience": operation.audience,
	};
}

/**
 * The OpenAPI 3.1 document for the exposed operations (SPEC.md section 27).
 * Only operations in the catalog appear; every other route is left out.
 */
export function buildOpenApiDocument(
	operations: OperationRecords,
	options: OpenApiOptions,
): OpenApiDocument {
	const paths: OpenApiDocument["paths"] = {};
	for (const [key, operation] of Object.entries(operations)) {
		const { method, url } = splitKey(key);
		const path = openApiPath(url);
		paths[path] = {
			...paths[path],
			[method.toLowerCase()]: operationObject(operation, url),
		};
	}
	return {
		openapi: "3.1.0",
		info: {
			title: "Portikus API",
			version: options.version,
			description:
				"The operations an administrator's or instructor's API key may run. " +
				"A key sends `Authorization: Bearer portikus_...`.",
		},
		paths,
		components: {
			securitySchemes: {
				bearerAuth: { type: "http", scheme: "bearer", description: "An API key." },
				cookieAuth: {
					type: "apiKey",
					in: "cookie",
					name: options.cookieName,
					description: "The browser session.",
				},
			},
		},
	};
}
