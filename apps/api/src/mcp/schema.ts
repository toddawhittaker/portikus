import type { StandardSchemaWithJSON } from "@modelcontextprotocol/server";
import type { Operation } from "../catalog/index.js";
import { type JsonSchema, pathParameterNames, toSchema } from "../catalog/openapi.js";
import type { OperationInputValues } from "../catalog/run.js";

/**
 * The JSON Schema of an operation's tool input, `{ path?, query?, body? }`,
 * built from the catalog's own Zod schemas the way the OpenAPI document is.
 */
export function operationInputJson(operation: Operation, url: string): JsonSchema {
	const properties: Record<string, JsonSchema> = {};
	const names = pathParameterNames(url);
	if (names.length > 0) {
		const params = operation.input.params ? toSchema(operation.input.params) : {};
		const given = (params.properties ?? {}) as Record<string, JsonSchema>;
		properties.path = {
			type: "object",
			properties: Object.fromEntries(
				names.map((name) => [name, given[name] ?? { type: "string" }]),
			),
			required: names,
		};
	}
	if (operation.input.query) properties.query = toSchema(operation.input.query);
	if (operation.input.body) properties.body = toSchema(operation.input.body);
	return { type: "object", properties, additionalProperties: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What is wrong with the outline of a tool input, or null. */
function outlineProblem(input: unknown): string | null {
	if (!isRecord(input)) return "The input must be an object.";
	if (Object.keys(input).some((key) => !["path", "query", "body"].includes(key))) {
		return "The input takes only path, query and body.";
	}
	for (const key of ["path", "query"]) {
		if (input[key] !== undefined && !isRecord(input[key]))
			return `${key} must be an object.`;
	}
	return null;
}

/**
 * A tool input schema that shows the client `json` but checks only the
 * outline. The route itself validates the values, so a tool call gets the
 * same answer the HTTP route gives (SPEC.md section 27).
 */
export function outlineSchema(
	json: JsonSchema,
): StandardSchemaWithJSON<OperationInputValues> {
	return {
		"~standard": {
			version: 1,
			vendor: "portikus",
			jsonSchema: { input: () => json, output: () => json },
			validate(value) {
				const input = value ?? {};
				const problem = outlineProblem(input);
				return problem === null
					? { value: input as OperationInputValues }
					: { issues: [{ message: problem }] };
			},
		},
	};
}
