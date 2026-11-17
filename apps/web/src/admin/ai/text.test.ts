import type { AiSettingsView } from "@portikus/contracts";
import { AI_NOTICE_VERSION } from "@portikus/contracts";
import { expect, test } from "vitest";
import {
	baseUrlForKind,
	keyText,
	parseCount,
	proxyOffer,
	stageStates,
	switchBlocked,
	testErrorText,
} from "./text.js";

const VIEW: AiSettingsView = {
	enabled: false,
	providerKind: "openai-compatible",
	baseUrl: null,
	model: null,
	keySet: false,
	keyHint: null,
	monthlyTokenCap: 5_000_000,
	conversationTokenBudget: 200_000,
	noticeVersion: null,
	noticeAcceptedAt: null,
	noticeAcceptedBy: null,
	usedThisMonth: 0,
	priceSources: [],
	triageEnabled: false,
	triageDailyLimit: 5,
	triageForward: false,
	hostListed: false,
};

test("changing the kind swaps a default address but keeps a typed one", () => {
	expect(baseUrlForKind("anthropic", "https://api.openai.com/v1")).toBe(
		"https://api.anthropic.com",
	);
	expect(baseUrlForKind("openai-compatible", "")).toBe("https://api.openai.com/v1");
	expect(baseUrlForKind("anthropic", "https://llm.example.edu/v1")).toBe(
		"https://llm.example.edu/v1",
	);
});

test("the proxy host is offered unless the saved host is already listed (D5)", () => {
	const saved = { ...VIEW, baseUrl: "https://api.openai.com/v1" };
	expect(proxyOffer("https://api.openai.com/v1", saved)).toBe("api.openai.com");
	expect(proxyOffer("https://API.openai.com/v1", { ...saved, hostListed: true })).toBe(
		null,
	);
	expect(proxyOffer("https://other.example.com", { ...saved, hostListed: true })).toBe(
		"other.example.com",
	);
	expect(proxyOffer("not an address", saved)).toBe(null);
	expect(proxyOffer("http://plain.example.com", saved)).toBe(null);
});

test("the switch says what is missing: the notice, the key, or both", () => {
	expect(switchBlocked(VIEW)).toMatch(/notice and set a key/);
	const accepted = {
		...VIEW,
		noticeVersion: AI_NOTICE_VERSION,
		noticeAcceptedAt: "2026-11-01T10:00:00.000Z",
	};
	expect(switchBlocked(accepted)).toBe("Set the provider's key first.");
	expect(switchBlocked({ ...VIEW, keySet: true })).toBe(
		"Read and accept the privacy notice first.",
	);
	expect(
		switchBlocked({
			...VIEW,
			keySet: true,
			noticeVersion: 0,
			noticeAcceptedAt: "2026-11-01T10:00:00.000Z",
		}),
	).toMatch(/notice/);
	expect(switchBlocked({ ...accepted, keySet: true })).toBe(null);
});

test("the key shows only whether it is set and its last four characters", () => {
	expect(keyText(VIEW)).toBe("Not set");
	expect(keyText({ ...VIEW, keySet: true, keyHint: "ABCD" })).toBe("Set, ends in ABCD");
});

test("the stages up to the last that worked are done, the next one failed", () => {
	expect(stageStates("tool-result", true)).toEqual(["done", "done", "done", "done"]);
	expect(stageStates("reply", false)).toEqual([
		"done",
		"done",
		"failed",
		"not-reached",
	]);
	expect(stageStates(null, false)).toEqual([
		"failed",
		"not-reached",
		"not-reached",
		"not-reached",
	]);
});

test("each test error code has its own plain sentence", () => {
	const codes = [
		"not-configured",
		"auth",
		"rate-limited",
		"unreachable",
		"bad-response",
		"aborted",
		"no-tool-call",
		"bad-tool-call",
		"empty-reply",
	];
	const texts = codes.map(testErrorText);
	expect(new Set(texts).size).toBe(codes.length);
	expect(testErrorText("auth")).toMatch(/refused the key/);
	expect(testErrorText("something-new")).toMatch(/test failed/);
});

test("a count is a whole number above zero and within the limit", () => {
	expect(parseCount("5,000,000", 10_000_000)).toBe(5_000_000);
	expect(parseCount("0", 10)).toBe(null);
	expect(parseCount("1.5", 10)).toBe(null);
	expect(parseCount("11", 10)).toBe(null);
	expect(parseCount("", 10)).toBe(null);
});
