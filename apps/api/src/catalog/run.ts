import type { ApiError } from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import { splitKey } from "../security/route-policy.js";
import { operationByName } from "./index.js";

/** What a caller sends for one operation; the path comes from the catalog, never the caller. */
export interface OperationInputValues {
	path?: Record<string, unknown>;
	query?: Record<string, unknown>;
	body?: unknown;
}

/** Who is running the operation: their own key, and the address they came from. */
export interface RunCaller {
	apiKey: string;
	ip: string;
	userAgent?: string;
}

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

/**
 * Run one catalog operation in process as the caller (SPEC.md sections 24.8
 * and 27). The request goes through the route exactly as an HTTP call with
 * the caller's own key would: its validation, role and course checks, the
 * key's scope gate and the audit all run unchanged. The URL is built only
 * from the catalog's route pattern.
 */
export async function runOperation(
	app: FastifyInstance,
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
	const response = await app.inject({
		method: method as "GET",
		url: `${path.url}${query}`,
		remoteAddress: caller.ip,
		headers: {
			authorization: `Bearer ${caller.apiKey}`,
			...(caller.userAgent === undefined ? {} : { "user-agent": caller.userAgent }),
			...(hasBody ? { "content-type": "application/json" } : {}),
		},
		...(hasBody ? { payload: JSON.stringify(input.body) } : {}),
	});
	return { ok: true, status: response.statusCode, body: response.body };
}
