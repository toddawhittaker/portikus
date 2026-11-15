import { McpServer, type McpServerFactory } from "@modelcontextprotocol/server";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { riskWithinScope, scopeRequiredMessage } from "../api-keys/scope.js";
import { OPERATIONS, type Operation, operationByName } from "../catalog/index.js";
import { runOperation } from "../catalog/run.js";
import { splitKey } from "../security/route-policy.js";
import { fromAuthInfo, inAudience, type McpCaller, mayRun } from "./caller.js";
import { findOperations } from "./find.js";
import { errorResult, jsonResult, toolResult } from "./result.js";
import { operationInputJson, outlineSchema } from "./schema.js";

/**
 * The MCP server for one request (SPEC.md section 27): the named tools this
 * key's owner and scope allow, plus `find_operation` and `run_operation` for
 * the rest of the catalog. Every call goes through the route as the key.
 */

/** A tool name keeps to letters, digits and underscores, which every model client accepts. */
export function toolName(operation: Operation): string {
	return operation.name.replace(".", "_");
}

function annotationsOf(operation: Operation) {
	if (operation.risk === "read") return { readOnlyHint: true };
	return { readOnlyHint: false, destructiveHint: operation.risk === "destructive" };
}

const OperationInputShape = z
	.object({
		path: z.record(z.string(), z.unknown()).optional(),
		query: z.record(z.string(), z.unknown()).optional(),
		body: z.unknown().optional(),
	})
	.strict();

const RunArgs = z.object({
	operation: z.string().describe("The operation's name, as find_operation gives it."),
	input: OperationInputShape.optional().describe(
		"The operation's input: path values, query values and a JSON body, as its input schema says.",
	),
});

const FindArgs = z.object({
	query: z.string().describe("Words to look for in operation names and descriptions."),
});

function registerNamedTools(
	server: McpServer,
	app: FastifyInstance,
	caller: McpCaller,
) {
	for (const [key, operation] of Object.entries(OPERATIONS)) {
		if (!operation.tool || !mayRun(operation, caller)) continue;
		const json = operationInputJson(operation, splitKey(key).url);
		server.registerTool(
			toolName(operation),
			{
				description: operation.description,
				inputSchema: outlineSchema(json),
				annotations: annotationsOf(operation),
			},
			async (input) =>
				toolResult(await runOperation(app, caller, operation.name, input)),
		);
	}
}

/** The per-request server factory `createMcpHandler` calls with the key holder in `authInfo`. */
export function mcpServerFactory(app: FastifyInstance): McpServerFactory {
	return ({ authInfo }) => {
		const caller = fromAuthInfo(authInfo);
		const server = new McpServer({ name: "portikus", version: "1.0.0" });
		registerNamedTools(server, app, caller);

		server.registerTool(
			"find_operation",
			{
				description:
					"Finds up to 10 Portikus operations your key may run that match some words, " +
					"with each one's name, description, risk and input schema. Run one with run_operation.",
				inputSchema: FindArgs,
				annotations: { readOnlyHint: true },
			},
			async ({ query }) => jsonResult(findOperations(query, caller)),
		);

		server.registerTool(
			"run_operation",
			{
				description:
					"Runs one Portikus operation by name, with the input its schema describes. " +
					"Use find_operation to learn the names.",
				inputSchema: RunArgs,
				annotations: { readOnlyHint: false, destructiveHint: true },
			},
			async ({ operation: name, input }) => {
				// Refused here, before any request, with the answer the HTTP route would give.
				const operation = operationByName(name)?.operation;
				if (!operation) {
					return errorResult({
						code: "NOT_AVAILABLE_TO_API_KEYS",
						message: `There is no operation named ${name} that an API key may run.`,
					});
				}
				if (!inAudience(operation, caller.role)) {
					return errorResult({ code: "FORBIDDEN", message: "insufficient role" });
				}
				if (!riskWithinScope(operation.risk, caller.scope)) {
					return errorResult({
						code: "SCOPE_REQUIRED",
						message: scopeRequiredMessage(operation.risk),
					});
				}
				return toolResult(await runOperation(app, caller, name, input ?? {}));
			},
		);
		return server;
	};
}
