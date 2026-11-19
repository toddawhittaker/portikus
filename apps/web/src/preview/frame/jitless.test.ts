import { expect, test } from "vitest";
import { z } from "zod";

test("importing it turns Zod's eval probe off before any schema is built", async () => {
	expect(z.config().jitless).not.toBe(true);
	await import("./jitless.js");
	expect(z.config().jitless).toBe(true);
});
