import { describe, expect, test } from "vitest";
import { RESULT_TEXT_LIMIT, toolResult } from "./result.js";

/** Tool answers (SPEC.md section 27): compact JSON, errors as `{ code, message }`, size capped. */

function text(result: ReturnType<typeof toolResult>): string {
	return (result.content[0] as { text: string }).text;
}

describe("toolResult", () => {
	test("a success is the body as compact JSON", () => {
		const result = toolResult({ ok: true, status: 200, body: '{ "a" : [1, 2] }' });
		expect(result.isError).toBeUndefined();
		expect(text(result)).toBe('{"a":[1,2]}');
	});

	test("an empty success says its status", () => {
		expect(text(toolResult({ ok: true, status: 204, body: "" }))).toBe(
			'{"status":204}',
		);
	});

	test("a body that is not JSON goes through as text", () => {
		expect(text(toolResult({ ok: true, status: 200, body: "plain" }))).toBe("plain");
	});

	test("a 4xx is an error with only the API's code and message", () => {
		const result = toolResult({
			ok: true,
			status: 404,
			body: JSON.stringify({ code: "NOT_FOUND", message: "No.", extra: "x" }),
		});
		expect(result.isError).toBe(true);
		expect(JSON.parse(text(result))).toEqual({ code: "NOT_FOUND", message: "No." });
	});

	test("a 5xx with no error body still says what happened", () => {
		const result = toolResult({ ok: true, status: 502, body: "<html>" });
		expect(result.isError).toBe(true);
		expect(JSON.parse(text(result))).toEqual({
			code: "INTERNAL",
			message: "The request failed with status 502.",
		});
	});

	test("a refusal from the runner is an error", () => {
		const result = toolResult({
			ok: false,
			error: { code: "NOT_FOUND", message: "x" },
		});
		expect(result.isError).toBe(true);
	});

	test("a long answer is cut at the limit with a note saying so", () => {
		const body = JSON.stringify({ items: "x".repeat(RESULT_TEXT_LIMIT * 2) });
		const out = text(toolResult({ ok: true, status: 200, body }));
		expect(out.startsWith(body.slice(0, RESULT_TEXT_LIMIT))).toBe(true);
		expect(out).toContain(`[Truncated: the answer was ${body.length} characters`);
		expect(out.length).toBeLessThan(RESULT_TEXT_LIMIT + 300);
	});
});
