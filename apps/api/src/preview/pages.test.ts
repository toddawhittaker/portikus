import { describe, expect, test } from "vitest";
import { missLimitPage, tooManyRequestsPage } from "./pages.js";

describe("preview refusal pages", () => {
	test("the network miss limit says what happened and what to do", () => {
		expect(missLimitPage()).toContain(
			"Too many preview requests came from your network just now. Wait a minute, then reload this preview.",
		);
	});

	test("one preview session's request cap keeps its own wording", () => {
		expect(tooManyRequestsPage()).toContain("This preview made too many requests");
		expect(tooManyRequestsPage()).not.toContain("your network");
	});
});
