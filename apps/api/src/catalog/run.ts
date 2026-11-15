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

/** The route's own pattern with each parameter filled in and encoded, or the name of a missing one. */
function fillPath(
	pattern: string,
	values: Record<string, unknown>,
): { url: string } | { missing: string } {
	let missing: string | undefined;
	const url = pattern.replace(/:([A-Za-z0-9_]+)/g, (_match, name: string) => {
		const value = values[name];
		if (!isQueryValue(value) || String(value) === "") {
			missing ??= name;
			return "";
		}
		return encodeURIComponent(String(value));
	});
	return missing === undefined ? { url } : { missing };
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
		return refused("NOT_FOUND", `There is no operation named ${operationName}.`);
	}
	const { method, url: pattern } = splitKey(found.key);
	const path = fillPath(pattern, input.path ?? {});
	if ("missing" in path) {
		return refused("VALIDATION_FAILED", `The path value "${path.missing}" is missing.`);
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
