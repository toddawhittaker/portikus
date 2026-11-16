import { z } from "zod";
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
