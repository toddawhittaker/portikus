import { type ApiKeyHooks, touchApiKey } from "@portikus/auth";
import type { ApiError, ApiKeyScope } from "@portikus/contracts";
import { auditArrival, type Database, recordAudit } from "@portikus/db";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Kysely } from "kysely";
import { operationByKey, type Risk } from "../catalog/index.js";
import { apiKeyLimit } from "../rate-limit.js";
import { requestMetadata } from "../sessions/start-session.js";

/**
 * The scope gate for API key requests (SPEC.md sections 24.8 and 24.13). A
 * key may run only an operation the catalog exposes, and only one whose risk
 * its scope covers; every other route answers 403. Each key request counts
 * against the key's own limit and writes one `api_key.used` audit row.
 */

/** Routes any valid key may reach whatever its scope: the MCP server and the OpenAPI document. */
const KEY_ROUTES: ReadonlySet<string> = new Set([
	"GET /mcp",
	"POST /mcp",
	"GET /openapi.json",
]);

/** Scope is one ordered level: destructive includes write includes read. */
const SCOPE_LEVEL: Record<ApiKeyScope, number> = { read: 0, write: 1, destructive: 2 };
const RISK_LEVEL: Record<Risk, number> = { read: 0, change: 1, destructive: 2 };

/** The route a request matched, as `"METHOD url"`; a HEAD counts as its GET. */
function routeKeyOf(request: FastifyRequest): string {
	const method = request.method === "HEAD" ? "GET" : request.method;
	// An unmatched path has no route; the raw URL could carry anything, so it is not used.
	return `${method} ${request.routeOptions.url ?? ""}`;
}

/** What the request ran, for its audit row: the operation's name, or the route. */
function operationNameOf(request: FastifyRequest): string {
	const key = routeKeyOf(request);
	return operationByKey(key)?.name ?? key;
}

async function refuse(
	reply: FastifyReply,
	code: ApiError["code"],
	message: string,
): Promise<boolean> {
	const body: ApiError = { code, message };
	await reply.status(403).send(body);
	return false;
}

/**
 * Register the per-request audit row and return the `authorize` hook the auth
 * plugin calls for each request signed in by a key.
 */
export function registerApiKeyGate(
	app: FastifyInstance,
	deps: { db: Kysely<Database> },
): ApiKeyHooks["authorize"] {
	const { db } = deps;
	const allowKey = apiKeyLimit();

	// Written when the response is done, so it holds the status the caller got.
	app.addHook("onResponse", async (request, reply) => {
		const key = request.apiKey;
		const user = request.user;
		if (!key || !user) return;
		// The limiter logs the first refusal; a row for each would let a runaway
		// client fill the audit table at no cost to itself.
		if (reply.statusCode === 429) return;
		try {
			await auditArrival.run({ via: "api_key", apiKeyId: key.id }, () =>
				recordAudit(db, {
					actor: `user:${user.id}`,
					target: user.id,
					action: "api_key.used",
					result:
						reply.statusCode < 400
							? "ok"
							: reply.statusCode < 500
								? "denied"
								: "failed",
					metadata: {
						operation: operationNameOf(request),
						status: reply.statusCode,
						...requestMetadata(request),
					},
				}),
			);
		} catch (error) {
			request.log.error({ err: error }, "could not audit an API key request");
		}
	});

	return async function authorize(request, reply) {
		const key = request.apiKey;
		if (!key) return true;
		if (!(await allowKey(request, reply))) return false;
		const routeKey = routeKeyOf(request);
		if (!KEY_ROUTES.has(routeKey)) {
			// Not exposed, still waiting for its record, or no route at all.
			const operation = operationByKey(routeKey);
			if (!operation) {
				return refuse(
					reply,
					"NOT_AVAILABLE_TO_API_KEYS",
					"This action is not available to API keys.",
				);
			}
			if (RISK_LEVEL[operation.risk] > SCOPE_LEVEL[key.scope]) {
				return refuse(
					reply,
					"SCOPE_REQUIRED",
					`This action needs a key with ${operation.risk === "destructive" ? "destructive" : "write"} scope.`,
				);
			}
		}
		await touchApiKey(db, key.id);
		return true;
	};
}
