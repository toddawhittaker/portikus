import type { ApiError } from "@portikus/contracts";
import { ASSISTANT_MARK, auditArrival, type Database, recordAudit } from "@portikus/db";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import type { Kysely } from "kysely";
import { splitKey } from "../route-policy.js";
import { operationByName } from "./index.js";

/** What a caller sends for one operation; the path comes from the catalog, never the caller. */
export interface OperationInputValues {
	path?: Record<string, unknown>;
	query?: Record<string, unknown>;
	body?: unknown;
}

/**
 * Who is running the operation, and the address they came from: a key
 * holder over MCP, or a signed-in person through the built-in assistant
 * with the session of the socket that asked (SPEC.md section 20.4).
 */
export type RunCaller =
	| { kind: "api_key"; apiKey: string; ip: string; userAgent?: string }
	| { kind: "assistant"; sessionToken: string; ip: string; userAgent?: string };

export type RunResult =
	| { ok: true; status: number; body: string }
	| { ok: false; error: ApiError };

type QueryValue = string | number | boolean;

function isQueryValue(value: unknown): value is QueryValue {
	return ["string", "number", "boolean"].includes(typeof value);
}

function refused(code: ApiError["code"], message: string): RunResult {
	return { ok: false, error: { code, message } };
}

const PARAM = /:([A-Za-z0-9_]+)/g;

/**
 * A value that could step out of its segment once a client or proxy decodes
 * the URL, so it is refused rather than encoded (SPEC.md section 24.1).
 */
function leavesSegment(value: string): boolean {
	return value === "." || value === ".." || value.includes("/");
}

/**
 * The route's own pattern with each parameter filled in and encoded, or why
 * it cannot be. The catalog test pins each operation's params schema to
 * exactly these pattern names, so a name outside them is not the operation's.
 */
function fillPath(
	pattern: string,
	values: Record<string, unknown>,
): { url: string } | { refusal: string } {
	const names = new Set([...pattern.matchAll(PARAM)].map((match) => match[1]));
	const extra = Object.keys(values).find((name) => !names.has(name));
	if (extra !== undefined) {
		return { refusal: `This operation takes no path value named "${extra}".` };
	}
	let refusal: string | undefined;
	const url = pattern.replace(PARAM, (_match, name: string) => {
		const value = values[name];
		if (!isQueryValue(value) || String(value) === "") {
			refusal ??= `The path value "${name}" is missing.`;
			return "";
		}
		if (leavesSegment(String(value))) {
			refusal ??= `The path value "${name}" cannot be ".", ".." or contain "/".`;
			return "";
		}
		return encodeURIComponent(String(value));
	});
	return refusal === undefined ? { url } : { refusal };
}

function queryString(values: Record<string, unknown>): string | null {
	const query = new URLSearchParams();
	for (const [name, value] of Object.entries(values)) {
		if (value === undefined || value === null) continue;
		const list = Array.isArray(value) ? value : [value];
		for (const item of list) {
			if (!isQueryValue(item)) return null;
			query.append(name, String(item));
		}
	}
	const text = query.toString();
	return text === "" ? "" : `?${text}`;
}

/** The refusal code a route answered with, if its body names one. */
function refusalCode(response: LightMyRequestResponse): string | null {
	if (response.statusCode < 400) return null;
	try {
		const body: unknown = JSON.parse(response.body);
		const code = (body as { code?: unknown } | null)?.code;
		return typeof code === "string" ? code : null;
	} catch {
		return null;
	}
}

/**
 * One `assistant.used` row per call the assistant makes, like `api_key.used`
 * (SPEC.md section 24.11): the operation, the status and any refusal code,
 * never the inputs or the conversation. A call whose session did not resolve
 * has no person to name, so it writes none, as for an unknown key.
 */
async function auditAssistantCall(
	app: FastifyInstance,
	db: Kysely<Database>,
	caller: RunCaller,
	operation: string,
	response: LightMyRequestResponse,
): Promise<void> {
	const userId = response.headers[ASSISTANT_MARK.header];
	if (typeof userId !== "string") return;
	const status = response.statusCode;
	try {
		await auditArrival.run({ via: "assistant", apiKeyId: null }, () =>
			recordAudit(db, {
				actor: `user:${userId}`,
				target: userId,
				action: "assistant.used",
				result: status < 400 ? "ok" : status < 500 ? "denied" : "failed",
				metadata: {
					operation,
					status,
					code: refusalCode(response),
					ip: caller.ip,
					userAgent: caller.userAgent ?? null,
				},
			}),
		);
	} catch (error) {
		app.log.error({ err: error }, "could not audit an assistant call");
	}
}

/**
 * Run one catalog operation in process as the caller (SPEC.md sections 24.8
 * and 27). The request goes through the route exactly as an HTTP call with
 * the caller's own key or session cookie would: its validation, role and
 * course checks, the key's scope gate or the session's gates, and the audit
 * all run unchanged, with the session looked up fresh each time. The URL is
 * built only from the catalog's route pattern.
 */
export async function runOperation(
	app: FastifyInstance,
	db: Kysely<Database>,
	caller: RunCaller,
	operationName: string,
	input: OperationInputValues,
): Promise<RunResult> {
	const found = operationByName(operationName);
	if (!found) {
		return refused(
			"NOT_AVAILABLE_TO_API_KEYS",
			`There is no operation named ${operationName} that an API key may run.`,
		);
	}
	const { method, url: pattern } = splitKey(found.key);
	const path = fillPath(pattern, input.path ?? {});
	if ("refusal" in path) return refused("VALIDATION_FAILED", path.refusal);
	// The operation's own schema decides what a path value may be, so "search"
	// cannot stand in for an id and reach a neighbouring fixed route.
	const params = found.operation.input.params?.safeParse(input.path ?? {});
	if (params && !params.success) {
		return refused(
			"VALIDATION_FAILED",
			`A path value is not valid: ${params.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}.`,
		);
	}
	const query = queryString(input.query ?? {});
	if (query === null) {
		return refused(
			"VALIDATION_FAILED",
			"Each query value must be a string, number or boolean, or a list of them.",
		);
	}
	const hasBody = input.body !== undefined && method !== "GET";
	// A browser on our own page sends same-origin; the session needs it to pass
	// the CSRF check on a state-changing route (SPEC.md section 24.1).
	const identity =
		caller.kind === "api_key"
			? { authorization: `Bearer ${caller.apiKey}` }
			: {
					"sec-fetch-site": "same-origin",
					[ASSISTANT_MARK.header]: ASSISTANT_MARK.value,
				};
	const response = await app.inject({
		method: method as "GET",
		url: `${path.url}${query}`,
		remoteAddress: caller.ip,
		headers: {
			...identity,
			...(caller.userAgent === undefined ? {} : { "user-agent": caller.userAgent }),
			...(hasBody ? { "content-type": "application/json" } : {}),
		},
		...(caller.kind === "assistant"
			? { cookies: { [app.sessionCookieName]: caller.sessionToken } }
			: {}),
		...(hasBody ? { payload: JSON.stringify(input.body) } : {}),
	});
	if (caller.kind === "assistant")
		await auditAssistantCall(app, db, caller, operationName, response);
	return { ok: true, status: response.statusCode, body: response.body };
}
