import { expect, test } from "vitest";
import { dexLocalSubject } from "./dex-subject.js";

test("matches Dex's documented example for a static password", () => {
	expect(dexLocalSubject("08a8684b-db88-4b73-90a9-3cd1661f5466")).toBe(
		"CiQwOGE4Njg0Yi1kYjg4LTRiNzMtOTBhOS0zY2QxNjYxZjU0NjYSBWxvY2Fs",
	);
});

test("refuses a user id the one-byte length cannot encode", () => {
	expect(() => dexLocalSubject("x".repeat(128))).toThrow();
	expect(() => dexLocalSubject("")).toThrow();
});
