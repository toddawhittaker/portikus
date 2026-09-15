import { expect, test } from "vitest";
import { HealthResponse } from "./index.js";

test("accepts a well-formed health response", () => {
	const parsed = HealthResponse.parse({
		status: "ok",
		service: "api",
		uptimeSeconds: 1.5,
	});
	expect(parsed.service).toBe("api");
});

test("rejects a health response with a negative uptime", () => {
	const result = HealthResponse.safeParse({
		status: "ok",
		service: "api",
		uptimeSeconds: -1,
	});
	expect(result.success).toBe(false);
});
