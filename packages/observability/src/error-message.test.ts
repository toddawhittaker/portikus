import { describe, expect, test } from "vitest";
import { errorMessage } from "./error-message.js";

describe("errorMessage", () => {
	test("returns an Error's message", () => {
		expect(errorMessage(new TypeError("bad input"))).toBe("bad input");
	});

	test("stringifies anything else that was thrown", () => {
		expect(errorMessage("plain")).toBe("plain");
		expect(errorMessage(42)).toBe("42");
		expect(errorMessage(null)).toBe("null");
		expect(errorMessage(undefined)).toBe("undefined");
	});
});
