/**
 * The shared AI settings helpers (SPEC.md sections 20.4, 24.1, 24.8): the
 * gates openModelClient checks, the key and address it always passes on, and
 * the host checks.
 */
import { aiKeySealKey, openSecret, secondFactorKey } from "@portikus/auth";
import { AI_NOTICE_VERSION, AssistantUnavailableReason } from "@portikus/contracts";
import { createTestDb, hasTestDb, type TestDb } from "@portikus/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import type { ModelSettings } from "./model.js";

const made = vi.hoisted(() => ({
	calls: [] as { settings: ModelSettings; outbound: unknown }[],
	proxyUrls: [] as (string | null | undefined)[],
}));

vi.mock("./model.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./model.js")>()),
	createModelClient: (settings: ModelSettings, outbound: unknown) => {
		made.calls.push({ settings, outbound });
		return { step: () => (async function* () {})(), listModels: async () => null };
	},
}));
vi.mock("@portikus/observability", async (importOriginal) => ({
	...(await importOriginal<typeof import("@portikus/observability")>()),
	createOutboundFetch: (proxyUrl: string | null | undefined) => {
		made.proxyUrls.push(proxyUrl);
		return async () => new Response("via proxy");
	},
}));

const {
	isSiteOwnHost,
	loadAiSettings,
	modelClientFor,
	openModelClient,
	planSettingsUpdate,
	sealAiKey,
	unavailableMessage,
} = await import("./settings.js");
const { recordUsage } = await import("./usage.js");

const skip = !hasTestDb();
let testDb: TestDb;

const KEY = "fake-provider-key-for-tests-WXYZ";
const CONFIG = {
	SECOND_FACTOR_KEY: "5f".repeat(32),
	OUTBOUND_PROXY_URL: "http://127.0.0.1:3128",
	AI_TEST_BASE_URL: undefined as string | undefined,
};

beforeAll(async () => {
	if (skip) return;
	testDb = await createTestDb();
});

afterAll(async () => {
	if (skip) return;
	await testDb.close();
});

beforeEach(async () => {
	made.calls.length = 0;
	made.proxyUrls.length = 0;
	if (skip) return;
	await testDb.db.deleteFrom("ai_usage_days").execute();
	await testDb.db
		.updateTable("ai_settings")
		.set({
			enabled: false,
			provider_kind: null,
			base_url: null,
			model: null,
			key_sealed: null,
			key_hint: null,
			monthly_token_cap: 5_000_000,
			notice_version: null,
			notice_accepted_by: null,
			notice_accepted_at: null,
			price_sources: [],
		})
		.execute();
});

/** A fully set up, switched-on row. */
async function ready(over: Record<string, unknown> = {}): Promise<void> {
	await testDb.db
		.updateTable("ai_settings")
		.set({
			enabled: true,
			provider_kind: "openai-compatible",
			base_url: "https://api.openai.com/v1",
			model: "gpt-x",
			key_sealed: sealAiKey(CONFIG, KEY),
			key_hint: KEY.slice(-4),
			notice_version: AI_NOTICE_VERSION,
			...over,
		})
		.execute();
}

describe.skipIf(skip)("loadAiSettings", () => {
	test("reads the row migration 0061 inserts: off, no key, the default limits", async () => {
		expect(await loadAiSettings(testDb.db)).toEqual({
			enabled: false,
			providerKind: null,
			baseUrl: null,
			model: null,
			keySealed: null,
			keyHint: null,
			monthlyTokenCap: 5_000_000,
			conversationTokenBudget: 200_000,
			noticeVersion: null,
			noticeAcceptedBy: null,
			noticeAcceptedAt: null,
			priceSources: [],
		});
	});
});

describe.skipIf(skip)("openModelClient", () => {
	test("is off until switched on, whatever else is set", async () => {
		await ready({ enabled: false });
		expect(await openModelClient(testDb.db, CONFIG)).toEqual({ unavailable: "off" });
		expect(made.calls).toEqual([]);
	});

	test("a missing provider, address or model is incomplete; a missing key is no-key", async () => {
		for (const missing of [
			{ provider_kind: null },
			{ base_url: null },
			{ model: null },
		]) {
			await ready(missing);
			expect(await openModelClient(testDb.db, CONFIG), JSON.stringify(missing)).toEqual(
				{ unavailable: "incomplete" },
			);
		}
		await ready({ key_sealed: null, key_hint: null });
		expect(await openModelClient(testDb.db, CONFIG)).toEqual({ unavailable: "no-key" });
	});

	test("a sealed key that no longer opens (a restore without the key file) is key-unreadable", async () => {
		await ready();
		expect(
			await openModelClient(testDb.db, {
				...CONFIG,
				SECOND_FACTOR_KEY: "a0".repeat(32),
			}),
		).toEqual({ unavailable: "key-unreadable" });
	});

	test("needs the notice accepted at the current version", async () => {
		await ready({ notice_version: null });
		expect(await openModelClient(testDb.db, CONFIG)).toEqual({ unavailable: "notice" });
		await ready({ notice_version: AI_NOTICE_VERSION - 1 });
		expect(await openModelClient(testDb.db, CONFIG)).toEqual({ unavailable: "notice" });
	});

	test("stops when this month's tokens reach the cap, counting every purpose", async () => {
		await ready({ monthly_token_cap: 1000 });
		const usage = { input: 400, output: 100, cacheRead: 0, cacheWrite: 0 };
		await recordUsage(testDb.db, {
			userId: null,
			purpose: "assistant",
			model: "m",
			usage,
		});
		expect(await openModelClient(testDb.db, CONFIG)).not.toHaveProperty("unavailable");
		await recordUsage(testDb.db, {
			userId: null,
			purpose: "pricing",
			model: "m",
			usage,
		});
		expect(await openModelClient(testDb.db, CONFIG)).toEqual({
			unavailable: "monthly-cap",
		});
	});

	test("passes the opened key and the saved address explicitly, through the server proxy", async () => {
		await ready({
			provider_kind: "anthropic",
			base_url: "https://api.anthropic.com/v1",
		});
		const opened = await openModelClient(testDb.db, CONFIG);
		expect(opened).toHaveProperty("client");
		expect(opened).toMatchObject({
			settings: {
				providerKind: "anthropic",
				baseUrl: "https://api.anthropic.com/v1",
				model: "gpt-x",
			},
		});
		expect(made.calls).toHaveLength(1);
		expect(made.calls[0]?.settings).toEqual({
			kind: "anthropic",
			baseUrl: "https://api.anthropic.com/v1",
			apiKey: KEY,
			model: "gpt-x",
		});
		expect(made.proxyUrls).toEqual(["http://127.0.0.1:3128"]);
	});

	test("the test address replaces the saved one and skips the proxy, for the browser run", async () => {
		await ready();
		const fetch = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("fake", { status: 200 }));
		try {
			await openModelClient(testDb.db, {
				...CONFIG,
				AI_TEST_BASE_URL: "http://127.0.0.1:9/v1",
			});
			const call = made.calls[0];
			if (!call) throw new Error("no model client was made");
			expect(call.settings.baseUrl).toBe("http://127.0.0.1:9/v1");
			expect(call.settings.apiKey).toBe(KEY);
			expect(made.proxyUrls).toEqual([]);
			await (call.outbound as (url: string, init: RequestInit) => Promise<Response>)(
				"http://127.0.0.1:9/v1/models",
				{},
			);
			expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:9/v1/models", {});
		} finally {
			fetch.mockRestore();
		}
	});
});

describe.skipIf(skip)("modelClientFor", () => {
	test("works while the feature is off, so the page can test before switching on", async () => {
		await ready({ enabled: false, notice_version: null });
		expect(modelClientFor(await loadAiSettings(testDb.db), CONFIG)).not.toBeNull();
	});
});

describe("the sealed key", () => {
	test("opens only under the AI key's own seal key and purpose, never the second factor's", () => {
		const sealed = sealAiKey(CONFIG, KEY);
		expect(sealed).not.toContain(KEY);
		expect(
			openSecret(aiKeySealKey(CONFIG.SECOND_FACTOR_KEY), sealed, "ai-key:provider"),
		).toEqual(Buffer.from(KEY));
		expect(
			openSecret(secondFactorKey(CONFIG.SECOND_FACTOR_KEY), sealed, "ai-key:provider"),
		).toBeNull();
		expect(
			openSecret(aiKeySealKey(CONFIG.SECOND_FACTOR_KEY), sealed, "totp:x"),
		).toBeNull();
	});
});

describe("isSiteOwnHost", () => {
	const site = {
		PUBLIC_URL: "https://portikus.school.edu",
		PREVIEW_SUFFIX: "preview.school.edu",
	};

	test("refuses the site's own host and the preview hosts under its suffix", () => {
		for (const own of [
			"https://portikus.school.edu/v1",
			"https://PORTIKUS.school.edu/v1",
			"https://preview.school.edu/v1",
			"https://app-5173.preview.school.edu/v1",
		]) {
			expect(isSiteOwnHost(own, site), own).toBe(true);
		}
	});

	test("allows other hosts, including a look-alike that merely ends the same way", () => {
		for (const other of [
			"https://api.openai.com/v1",
			"https://evilpreview.school.edu/v1",
			"https://portikus.school.edu.example.com/v1",
		]) {
			expect(isSiteOwnHost(other, site), other).toBe(false);
		}
	});
});

describe("unavailableMessage", () => {
	test("has a plain sentence for every reason", () => {
		for (const reason of AssistantUnavailableReason.options) {
			expect(unavailableMessage(reason), reason).toMatch(/^[A-Z].+\.$/);
		}
	});
});

describe("planSettingsUpdate", () => {
	const PLAN_CONFIG = {
		SECOND_FACTOR_KEY: CONFIG.SECOND_FACTOR_KEY,
		PUBLIC_URL: "https://portikus.school.edu",
		PREVIEW_SUFFIX: "preview.school.edu",
	};
	const saved = {
		enabled: false,
		providerKind: "openai-compatible" as const,
		baseUrl: "https://api.openai.com/v1",
		model: "gpt-x",
		keySealed: sealAiKey(CONFIG, KEY),
		keyHint: "WXYZ",
		monthlyTokenCap: 5_000_000,
		conversationTokenBudget: 200_000,
		noticeVersion: AI_NOTICE_VERSION,
		noticeAcceptedBy: null,
		noticeAcceptedAt: null,
		priceSources: [],
	};

	test("a new base address host or provider kind without a new key is refused", () => {
		for (const body of [
			{ baseUrl: "https://models.elsewhere.example.com/v1" },
			{ providerKind: "anthropic" as const },
			{ baseUrl: "https://models.elsewhere.example.com/v1", enabled: false },
		]) {
			expect(
				planSettingsUpdate(body, saved, PLAN_CONFIG),
				JSON.stringify(body),
			).toEqual(expect.objectContaining({ status: 409, code: "AI_KEY_REQUIRED" }));
		}
	});

	test("the same host on a new path, a new key, or no saved key is allowed", () => {
		for (const body of [
			{ baseUrl: "https://API.openai.com/v2" },
			{
				baseUrl: "https://models.elsewhere.example.com/v1",
				key: "new-key-for-tests-1234",
			},
			{ providerKind: "anthropic" as const, key: "new-key-for-tests-1234" },
			{ baseUrl: "https://models.elsewhere.example.com/v1", clearKey: true },
		]) {
			expect(
				planSettingsUpdate(body, saved, PLAN_CONFIG),
				JSON.stringify(body),
			).not.toHaveProperty("status");
		}
		expect(
			planSettingsUpdate(
				{ baseUrl: "https://models.elsewhere.example.com/v1" },
				{ ...saved, keySealed: null, keyHint: null },
				PLAN_CONFIG,
			),
		).not.toHaveProperty("status");
	});

	test("turning on needs a provider, a base address and a model after the save", () => {
		for (const missing of [
			{ providerKind: null },
			{ baseUrl: null },
			{ model: null },
		]) {
			expect(
				planSettingsUpdate({ enabled: true }, { ...saved, ...missing }, PLAN_CONFIG),
				JSON.stringify(missing),
			).toEqual(
				expect.objectContaining({ status: 409, code: "AI_SETTINGS_INCOMPLETE" }),
			);
		}
		expect(
			planSettingsUpdate(
				{ enabled: true, model: "gpt-y" },
				{ ...saved, model: null },
				PLAN_CONFIG,
			),
		).toMatchObject({ patch: { enabled: true, model: "gpt-y" } });
	});
});
