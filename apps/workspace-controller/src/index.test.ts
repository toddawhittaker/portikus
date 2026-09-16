import { expect, test } from "vitest";

test("index module exports buildServer", async () => {
	const mod = await import("./server.js");
	expect(typeof mod.buildServer).toBe("function");
});
