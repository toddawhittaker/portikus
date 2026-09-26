import { expect, test } from "vitest";
import { REDACT_PATHS } from "./logger.js";
import { MAX_DISPLAY_STRING, redactLine, SENSITIVE_KEYS } from "./redact.js";
import { collectingLogger, lineAt } from "./testing.js";

/** `{ a: { a: ... { [key]: "secret" } } }` with the key at `depth`. */
function nested(key: string, depth: number): unknown {
	let value: unknown = { [key]: "secret-value" };
	for (let i = 1; i < depth; i++) value = { a: value };
	return value;
}

test("every sensitive key is redacted at depths one to five", () => {
	for (const key of SENSITIVE_KEYS) {
		for (let depth = 1; depth <= 5; depth++) {
			const text = JSON.stringify(redactLine(nested(key, depth)));
			expect(text, `${key} at ${depth}`).not.toContain("secret-value");
			expect(text).toContain("[redacted]");
		}
	}
});

test("keys inside arrays are redacted and other values kept", () => {
	const out = redactLine({
		msg: "hello",
		status: 200,
		ok: true,
		none: null,
		items: [{ token: "t1" }, "plain", [{ cookie: "c1" }]],
	});
	expect(out).toEqual({
		msg: "hello",
		status: 200,
		ok: true,
		none: null,
		items: [{ token: "[redacted]" }, "plain", [{ cookie: "[redacted]" }]],
	});
});

test("an object under a sensitive key is replaced whole", () => {
	expect(redactLine({ headers: { authorization: { scheme: "Bearer" } } })).toEqual({
		headers: { authorization: "[redacted]" },
	});
});

test("long strings are cut at 2,000 characters", () => {
	const out = redactLine({ msg: "x".repeat(5000), short: "y".repeat(2000) }) as Record<
		string,
		string
	>;
	expect(out.msg?.startsWith("x".repeat(MAX_DISPLAY_STRING))).toBe(true);
	expect(out.msg?.length).toBe(MAX_DISPLAY_STRING + 1);
	expect(out.short).toBe("y".repeat(2000));
});

test("the input is not changed", () => {
	const input = { token: "t" };
	redactLine(input);
	expect(input.token).toBe("t");
});

test("the logger's redaction paths come from the same key list", () => {
	for (const key of SENSITIVE_KEYS) {
		expect(REDACT_PATHS).toContain(key);
		expect(REDACT_PATHS).toContain(`*.${key}`);
		expect(REDACT_PATHS).toContain(`*.*.${key}`);
	}
	const { logger, lines } = collectingLogger();
	logger.info({ userinfo: "u:p", outer: { ANTHROPIC_API_KEY: "sk-1" } }, "m");
	const text = JSON.stringify(lineAt(lines, 0));
	expect(text).not.toContain("u:p");
	expect(text).not.toContain("sk-1");
});
