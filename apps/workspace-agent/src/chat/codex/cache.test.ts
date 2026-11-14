import { describe, expect, test } from "vitest";
import { codexCache } from "./cache.js";

describe("Codex cache figures", () => {
	test.each([
		"gpt-5.6",
		"gpt-5.6-codex",
		"gpt-5.7",
		"gpt-5.10",
		"gpt-6",
		"gpt-6.1",
		"gpt-6.1-sol",
		"gpt-7",
	])("%s has a 30-minute cache", (model) => {
		expect(codexCache(model, 42)).toEqual({ at: 42, ttlSeconds: 1800 });
	});

	test.each(["gpt-5.5", "gpt-5.3-codex", "gpt-5", "gpt-4.1", "gpt-55", "o3", ""])(
		"%s has none",
		(model) => {
			expect(codexCache(model, 42)).toBeNull();
		},
	);
});
