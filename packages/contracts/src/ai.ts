import { z } from "zod";
import { AgentUsageQuery, AgentUsageWindow, UsageDay } from "./agent-usage.js";
import { isLocalOrPrivateHost } from "./browser.js";
import { isHttpsUrl } from "./settings.js";

/** Bumped when the privacy notice text changes, so it must be read again. */
export const AI_NOTICE_VERSION = 1;

export const ProviderKind = z.enum(["openai-compatible", "anthropic"]);
export type ProviderKind = z.infer<typeof ProviderKind>;

export const MAX_AI_MONTHLY_TOKEN_CAP = 10_000_000_000;
export const MAX_AI_CONVERSATION_TOKEN_BUDGET = 100_000_000;
export const MAX_AI_KEY_CHARS = 1000;
export const MAX_AI_MODEL_CHARS = 200;
export const MAX_AI_PRICE_SOURCES = 20;
export const MAX_AI_TRIAGE_DAILY_LIMIT = 100;

function isIpLiteral(host: string): boolean {
	return host.startsWith("[") || /^[\d.]+$/.test(host);
}

/**
 * A hosted provider's base address: https, a host name (no IP literal,
 * no local or private host), no credentials, query or fragment. Pricing
 * sources follow the same rule (SPEC.md
 * section 24.1; private networks are out of reach of the server proxy).
 */
export function isAiBaseUrl(value: string): boolean {
	if (!isHttpsUrl(value) || value.includes("?") || value.includes("#")) return false;
	const host = new URL(value).hostname.toLowerCase();
	return !isIpLiteral(host) && !isLocalOrPrivateHost(host) && host.includes(".");
}

export const AiBaseUrl = z.string().trim().refine(isAiBaseUrl, {
	message: "Give the provider's https:// address, by host name",
});

export const AiSettingsView = z.object({
	enabled: z.boolean(),
	providerKind: ProviderKind,
	baseUrl: z.string().nullable(),
	model: z.string().nullable(),
	keySet: z.boolean(),
	/** The key's last four characters; the key itself never leaves the server. */
	keyHint: z.string().max(4).nullable(),
	monthlyTokenCap: z.number().int().positive(),
	conversationTokenBudget: z.number().int().positive(),
	noticeVersion: z.number().int().nonnegative().nullable(),
	noticeAcceptedAt: z.string().datetime().nullable(),
	/** Display name of who accepted the notice. */
	noticeAcceptedBy: z.string().nullable(),
	usedThisMonth: z.number().int().nonnegative(),
	priceSources: z.array(z.string()),
	/** Whether new warning and danger administrator alerts get a model's explanation. */
	triageEnabled: z.boolean(),
	/** The most explanations written in one UTC day. */
	triageDailyLimit: z.number().int().nonnegative().max(MAX_AI_TRIAGE_DAILY_LIMIT),
	/** Whether forwarded email and Pushover alerts carry the explanation. */
	triageForward: z.boolean(),
	/** Whether the base address host is on the server proxy host list. */
	hostListed: z.boolean(),
});
export type AiSettingsView = z.infer<typeof AiSettingsView>;

/** Absent fields stay as they are. The key is write-only. */
export const UpdateAiSettingsRequest = z
	.object({
		enabled: z.boolean().optional(),
		providerKind: ProviderKind.optional(),
		baseUrl: AiBaseUrl.optional(),
		model: z.string().trim().min(1).max(MAX_AI_MODEL_CHARS).optional(),
		key: z.string().trim().min(1).max(MAX_AI_KEY_CHARS).optional(),
		clearKey: z.boolean().optional(),
		monthlyTokenCap: z
			.number()
			.int()
			.positive()
			.max(MAX_AI_MONTHLY_TOKEN_CAP)
			.optional(),
		conversationTokenBudget: z
			.number()
			.int()
			.positive()
			.max(MAX_AI_CONVERSATION_TOKEN_BUDGET)
			.optional(),
		priceSources: z.array(AiBaseUrl).max(MAX_AI_PRICE_SOURCES).optional(),
		triageEnabled: z.boolean().optional(),
		triageDailyLimit: z
			.number()
			.int()
			.nonnegative()
			.max(MAX_AI_TRIAGE_DAILY_LIMIT)
			.optional(),
		triageForward: z.boolean().optional(),
		/** Also add the base address host to the server proxy host list. */
		addProxyHost: z.boolean().optional(),
	})
	.strict()
	.refine((body) => !(body.clearKey === true && body.key !== undefined), {
		message: "Set a key or clear it, not both",
	});
export type UpdateAiSettingsRequest = z.infer<typeof UpdateAiSettingsRequest>;

export const AcceptNoticeRequest = z
	.object({ noticeVersion: z.number().int().positive() })
	.strict();
export type AcceptNoticeRequest = z.infer<typeof AcceptNoticeRequest>;

export const AiTestStage = z.enum(["connect", "reply", "tool-call", "tool-result"]);
export type AiTestStage = z.infer<typeof AiTestStage>;

export const AiTokenUsage = z.object({
	inputTokens: z.number().int().nonnegative(),
	outputTokens: z.number().int().nonnegative(),
});
export type AiTokenUsage = z.infer<typeof AiTokenUsage>;

/** The settings page's round trip: `stage` is the last one that worked. */
export const TestAiResult = z.object({
	ok: z.boolean(),
	stage: AiTestStage.nullable(),
	errorCode: z.string().nullable(),
	model: z.string().nullable(),
	usage: AiTokenUsage.nullable(),
});
export type TestAiResult = z.infer<typeof TestAiResult>;

/** Null when the server has no model list; the page falls back to free text. */
export const ModelListResponse = z.object({ models: z.array(z.string()).nullable() });
export type ModelListResponse = z.infer<typeof ModelListResponse>;

/** Query for `GET /admin/ai-usage`: the same 7, 30 or 90 day window as agent usage. */
export const AiUsageQuery = AgentUsageQuery;
export type AiUsageQuery = z.infer<typeof AiUsageQuery>;

export const AiPurpose = z.enum(["assistant", "pricing", "triage"]);
export type AiPurpose = z.infer<typeof AiPurpose>;

const TokenCount = z.number().int().nonnegative();

/** The four token counts the built-in AI keeps; never any text. */
export const AiUsageCounts = z.object({
	inputTokens: TokenCount,
	outputTokens: TokenCount,
	cacheReadTokens: TokenCount,
	cacheWriteTokens: TokenCount,
});
export type AiUsageCounts = z.infer<typeof AiUsageCounts>;

/** One person's use of one model for one purpose over the window. */
export const AiUsagePerson = AiUsageCounts.extend({
	/** Null for the weekly price check and for a person since deleted. */
	userId: z.string().uuid().nullable(),
	displayName: z.string().min(1),
	purpose: AiPurpose,
	model: z.string().min(1),
});
export type AiUsagePerson = z.infer<typeof AiUsagePerson>;

/** Everyone's use on one UTC day for one purpose. */
export const AiUsageDay = AiUsageCounts.extend({
	day: UsageDay,
	purpose: AiPurpose,
});
export type AiUsageDay = z.infer<typeof AiUsageDay>;

export const AiUsageResponse = z.object({
	days: AgentUsageWindow,
	/** First and last UTC day of the window, inclusive. */
	from: UsageDay,
	to: UsageDay,
	users: z.array(AiUsagePerson),
	daily: z.array(AiUsageDay),
	totals: AiUsageCounts,
	/** Estimated US dollars for the window; null when a model used has no full price row. */
	dollars: z.number().nonnegative().nullable(),
	/** Input plus output tokens used this calendar month (UTC) against the site's cap. */
	month: z.object({
		usedTokens: TokenCount,
		capTokens: z.number().int().positive(),
	}),
});
export type AiUsageResponse = z.infer<typeof AiUsageResponse>;
