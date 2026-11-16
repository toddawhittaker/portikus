import { describe, expect, test } from "vitest";
import { AI_NOTICE_VERSION, AiBaseUrl, UpdateAiSettingsRequest } from "./ai.js";

describe("AI base address", () => {
	test.each([
		"https://api.openai.com/v1",
		"https://api.anthropic.com",
		"https://openrouter.ai/api/v1/",
	])("accepts hosted provider %s", (url) => {
		expect(AiBaseUrl.safeParse(url).success).toBe(true);
	});

	test.each([
		"http://api.openai.com/v1",
		"https://127.0.0.1/v1",
		"https://10.0.0.5/v1",
		"https://192.168.1.2",
		"https://8.8.8.8/v1",
		"https://[2001:db8::1]/v1",
		"https://[::1]/v1",
		"https://localhost/v1",
		"https://models.localhost",
		"https://intranet/v1",
		"https://user:pass@api.openai.com/v1",
		"https://api.openai.com/v1?key=x",
		"https://api.openai.com/v1#frag",
		"ftp://api.openai.com",
		"not a url",
	])("refuses %s", (url) => {
		expect(AiBaseUrl.safeParse(url).success).toBe(false);
	});
});

describe("UpdateAiSettingsRequest", () => {
	test("every field is optional, so an empty body changes nothing", () => {
		expect(UpdateAiSettingsRequest.parse({})).toEqual({});
	});

	test("an absent key is left out, so the stored key stays", () => {
		const body = UpdateAiSettingsRequest.parse({ model: "gpt-6.1" });
		expect("key" in body).toBe(false);
	});

	test("an empty or blank key is refused", () => {
		expect(UpdateAiSettingsRequest.safeParse({ key: "" }).success).toBe(false);
		expect(UpdateAiSettingsRequest.safeParse({ key: "   " }).success).toBe(false);
	});

	test("clearing and setting the key at once is refused", () => {
		expect(
			UpdateAiSettingsRequest.safeParse({ key: "sk-1", clearKey: true }).success,
		).toBe(false);
		expect(UpdateAiSettingsRequest.safeParse({ clearKey: true }).success).toBe(true);
	});

	test("caps are positive integers under their maxima", () => {
		for (const bad of [0, -1, 1.5, 1e12]) {
			expect(UpdateAiSettingsRequest.safeParse({ monthlyTokenCap: bad }).success).toBe(
				false,
			);
			expect(
				UpdateAiSettingsRequest.safeParse({ conversationTokenBudget: bad }).success,
			).toBe(false);
		}
		expect(
			UpdateAiSettingsRequest.safeParse({
				monthlyTokenCap: 5_000_000,
				conversationTokenBudget: 200_000,
			}).success,
		).toBe(true);
	});

	test("unknown fields are refused", () => {
		expect(UpdateAiSettingsRequest.safeParse({ keyHint: "abcd" }).success).toBe(false);
	});

	test("the proxy host offer is a boolean", () => {
		expect(UpdateAiSettingsRequest.parse({ addProxyHost: true })).toEqual({
			addProxyHost: true,
		});
	});
});

test("the notice version starts at 1", () => {
	expect(AI_NOTICE_VERSION).toBe(1);
});
