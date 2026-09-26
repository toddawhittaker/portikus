import { expect, test } from "vitest";
import { ApiError } from "../api/request.js";
import { fileErrorToast } from "./errors.js";

test("a rate-limited file change says to wait", () => {
	expect(fileErrorToast(new ApiError(429, "x", "RATE_LIMITED")).title).toBe(
		"Too many file changes just now. Wait a minute, then try again.",
	);
});

test("a busy server says to try again shortly", () => {
	expect(fileErrorToast(new ApiError(503, "x", "SERVICE_BUSY")).title).toBe(
		"Portikus is busy. Try again in a moment.",
	);
});
