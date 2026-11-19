import { expect, test } from "vitest";

test("importing it turns Zod's eval probe off before any schema is built", async () => {
	await import("./jitless.js");
	expect((globalThis as { __zod_globalConfig?: unknown }).__zod_globalConfig).toEqual({
		jitless: true,
	});
});
