import { McpServer, type McpServerFactory } from "@modelcontextprotocol/server";
import { auditArrival, type Database, recordAudit } from "@portikus/db";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { OPERATIONS, type Operation } from "../catalog/index.js";
import { runOperation } from "../catalog/run.js";
import { splitKey } from "../route-policy.js";
import { fromAuthInfo, type McpCaller, mayRun } from "./caller.js";
import { findOperations } from "./find.js";
import { registerPrompts } from "./prompts.js";
import { type Run, registerResources } from "./resources.js";
import { jsonResult, toolResult } from "./result.js";
import { operationInputJson, outlineSchema } from "./schema.js";
import {
	FIND_DESCRIPTION,
	FindArgs,
	RESULTS_ARE_DATA,
	RUN_DESCRIPTION,
	RunArgs,
	toolDescription,
	toolName,
} from "./server.js";

/**
 * The MCP server for one request (SPEC.md section 27): the named tools this
 * key's owner and scope allow, plus `find_operation` and `run_operation` for
 * the rest of the catalog, and the resources and prompts of section 20.4.
 * Every call goes through the route as the key.
 */

const INSTRUCTIONS =
	"Portikus operations, run as your API key with its owner's role and the key's scope. " +
	RESULTS_ARE_DATA;

function annotationsOf(operation: Operation) {
	if (operation.risk === "read") return { readOnlyHint: true };
	return { readOnlyHint: false, destructiveHint: operation.risk === "destructive" };
}

/**
 * Run an operation as the caller. A refusal the runner makes itself never
 * reaches a route, so no route or gate row names it; this writes the one
 * `api_key.used` row every key request gets (SPEC.md section 24.11). A call
 * that does reach a route gets its row from the gate, except when the key was
 * revoked or its owner disabled after the outer request signed in: the route
 * answers 401 without a key, so the gate writes nothing and this writes the
 * row. Either way the row names the operation, so the outer `POST /mcp`
 * request is told to write none.
 */
function runner(app: FastifyInstance, db: Kysely<Database>, caller: McpCaller): Run {
	const audit = async (name: string, metadata: Record<string, unknown>) => {
		try {
			await auditArrival.run({ via: "api_key", apiKeyId: caller.keyId }, () =>
				recordAudit(db, {
					actor: `user:${caller.userId}`,
					target: caller.userId,
					action: "api_key.used",
					result: "denied",
					metadata: {
						operation: name,
						...metadata,
						ip: caller.ip,
						userAgent: caller.userAgent ?? null,
					},
				}),
			);
		} catch (error) {
			app.log.error({ err: error }, "could not audit a refused MCP tool call");
		}
	};
	return async (name, input) => {
		caller.markOperation();
		const result = await runOperation(app, db, caller, name, input);
		if (!result.ok) await audit(name, { code: result.error.code });
		else if (result.status === 401) await audit(name, { status: 401 });
		return toolResult(result);
	};
}

function registerNamedTools(server: McpServer, caller: McpCaller, run: Run) {
	for (const [key, operation] of Object.entries(OPERATIONS)) {
		if (!operation.tool || !mayRun(operation, caller)) continue;
		const json = operationInputJson(operation, splitKey(key).url);
		server.registerTool(
			toolName(operation),
			{
				description: toolDescription(operation),
				inputSchema: outlineSchema(json),
				annotations: annotationsOf(operation),
			},
			async (input) => run(operation.name, input),
		);
	}
}

/** The per-request server factory `createMcpHandler` calls with the key holder in `authInfo`. */
export function mcpServerFactory(
	app: FastifyInstance,
	db: Kysely<Database>,
): McpServerFactory {
	return ({ authInfo }) => {
		const caller = fromAuthInfo(authInfo);
		const run = runner(app, db, caller);
		const server = new McpServer(
			{ name: "portikus", version: "1.0.0" },
			{ instructions: INSTRUCTIONS },
		);
		registerNamedTools(server, caller, run);
		registerResources(server, caller, run, RESULTS_ARE_DATA);
		registerPrompts(server, caller, RESULTS_ARE_DATA);

		server.registerTool(
			"find_operation",
			{
				description: FIND_DESCRIPTION,
				inputSchema: FindArgs,
				annotations: { readOnlyHint: true },
			},
			async ({ query }) => jsonResult(findOperations(query, caller)),
		);

		server.registerTool(
			"run_operation",
			{
				description: RUN_DESCRIPTION,
				inputSchema: RunArgs,
				annotations: { readOnlyHint: false, destructiveHint: true },
			},
			// The scope gate and the route refuse a wrong role or a low scope, and audit it.
			async ({ operation: name, input }) => run(name, input ?? {}),
		);
		return server;
	};
}
