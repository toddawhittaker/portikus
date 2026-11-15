import type { CallToolResult } from "@modelcontextprotocol/server";
import type { ApiError } from "@portikus/contracts";
import { z } from "zod";
import type { RunResult } from "../catalog/run.js";

const ApiErrorOutline = z.object({ code: z.string(), message: z.string() });

/** About this many characters of an answer reach the client; a model's context is not unlimited. */
export const RESULT_TEXT_LIMIT = 50_000;

function capped(text: string): string {
	if (text.length <= RESULT_TEXT_LIMIT) return text;
	return (
		`${text.slice(0, RESULT_TEXT_LIMIT)}\n[Truncated: the answer was ${text.length} ` +
		`characters and only the first ${RESULT_TEXT_LIMIT} are shown. Ask for less, ` +
		"for example with a narrower query.]"
	);
}

function textResult(text: string, isError: boolean): CallToolResult {
	return {
		content: [{ type: "text", text: capped(text) }],
		...(isError ? { isError } : {}),
	};
}

/** An error in the API's own `{ code, message }` shape. */
function errorResult(
	error: ApiError | z.infer<typeof ApiErrorOutline>,
): CallToolResult {
	return textResult(JSON.stringify(error), true);
}

/** A JSON value as a tool answer, compact. */
export function jsonResult(value: unknown): CallToolResult {
	return textResult(JSON.stringify(value), false);
}

/**
 * The route's answer as a tool result: the body as compact JSON, or for a
 * 4xx or 5xx an error carrying the API's `{ code, message }` (SPEC.md section 27).
 */
export function toolResult(result: RunResult): CallToolResult {
	if (!result.ok) return errorResult(result.error);
	let body: unknown;
	try {
		body = result.body === "" ? null : JSON.parse(result.body);
	} catch {
		body = undefined;
	}
	if (result.status >= 400) {
		// Only the code and message go out, whatever else the error body holds.
		const parsed = ApiErrorOutline.safeParse(body);
		return errorResult(
			parsed.success
				? parsed.data
				: {
						code: "INTERNAL",
						message: `The request failed with status ${result.status}.`,
					},
		);
	}
	if (body === undefined) return textResult(result.body, false);
	return jsonResult(body ?? { status: result.status });
}
