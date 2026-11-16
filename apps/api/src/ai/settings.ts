import { aiKeySealKey, openSecret, sealSecret } from "@portikus/auth";
import type { ApiConfig } from "@portikus/config";
import {
	AI_NOTICE_VERSION,
	type ProviderKind,
	type UpdateAiSettingsRequest,
} from "@portikus/contracts";
import type { Database } from "@portikus/db";
import { createOutboundFetch, type OutboundFetch } from "@portikus/observability";
import type { Kysely, Updateable } from "kysely";
import { readProxyHostsFile } from "../site/page-files.js";
import { createModelClient, type ModelClient } from "./model.js";
import { usedThisMonth } from "./usage.js";

/** What the saved settings row says, with the key still sealed. */
export type AiSettings = {
	enabled: boolean;
	providerKind: ProviderKind | null;
	baseUrl: string | null;
	model: string | null;
	keySealed: string | null;
	keyHint: string | null;
	monthlyTokenCap: number;
	conversationTokenBudget: number;
	noticeVersion: number | null;
	/** Display name of who accepted the notice. */
	noticeAcceptedBy: string | null;
	noticeAcceptedAt: Date | null;
	priceSources: string[];
};

/** Settings with everything a model call needs. */
export type ReadyAiSettings = AiSettings & {
	providerKind: ProviderKind;
	baseUrl: string;
	model: string;
};

type AiUnavailable = "off" | "no-key" | "notice" | "monthly-cap";

export type OpenedModel =
	| { client: ModelClient; settings: ReadyAiSettings }
	| { unavailable: AiUnavailable };

// The context ties a sealed key to its purpose, so it opens nowhere else (SPEC.md section 24.8).
const KEY_CONTEXT = "ai-key:provider";

export function sealAiKey(
	config: Pick<ApiConfig, "SECOND_FACTOR_KEY">,
	key: string,
): string {
	return sealSecret(
		aiKeySealKey(config.SECOND_FACTOR_KEY),
		Buffer.from(key, "utf8"),
		KEY_CONTEXT,
	);
}

function openAiKey(
	config: Pick<ApiConfig, "SECOND_FACTOR_KEY">,
	sealed: string,
): string | null {
	return (
		openSecret(aiKeySealKey(config.SECOND_FACTOR_KEY), sealed, KEY_CONTEXT)?.toString(
			"utf8",
		) ?? null
	);
}

export async function loadAiSettings(db: Kysely<Database>): Promise<AiSettings> {
	const row = await db
		.selectFrom("ai_settings as s")
		.leftJoin("users as u", "u.id", "s.notice_accepted_by")
		.select([
			"s.enabled",
			"s.provider_kind",
			"s.base_url",
			"s.model",
			"s.key_sealed",
			"s.key_hint",
			"s.monthly_token_cap",
			"s.conversation_token_budget",
			"s.notice_version",
			"s.notice_accepted_at",
			"s.price_sources",
			"u.display_name as accepted_by_name",
		])
		.where("s.id", "=", 1)
		.executeTakeFirstOrThrow();
	return {
		enabled: row.enabled,
		providerKind: row.provider_kind,
		baseUrl: row.base_url,
		model: row.model,
		keySealed: row.key_sealed,
		keyHint: row.key_hint,
		monthlyTokenCap: Number(row.monthly_token_cap),
		conversationTokenBudget: row.conversation_token_budget,
		noticeVersion: row.notice_version,
		noticeAcceptedBy: row.accepted_by_name,
		noticeAcceptedAt: row.notice_accepted_at,
		priceSources: row.price_sources,
	};
}

/** A plain fetch, for the e2e run that points model requests at a local fake. */
const directFetch: OutboundFetch = (url, init) => fetch(url, init);

/**
 * A client for the saved settings, or null when the key, provider, address
 * or model is missing, or the sealed key no longer opens (a restore without
 * the key file). Requests go through the server's proxy (ADR 0027); the key
 * and address are always passed explicitly. Ignores the on/off switch, so the
 * settings page can test before it is switched on.
 */
export function modelClientFor(
	settings: AiSettings,
	config: Pick<
		ApiConfig,
		"SECOND_FACTOR_KEY" | "OUTBOUND_PROXY_URL" | "AI_TEST_BASE_URL"
	>,
): { client: ModelClient; settings: ReadyAiSettings } | null {
	const { providerKind, baseUrl, model, keySealed } = settings;
	if (!providerKind || !baseUrl || !model || !keySealed) return null;
	const apiKey = openAiKey(config, keySealed);
	if (apiKey === null) return null;
	const test = config.AI_TEST_BASE_URL;
	const client = createModelClient(
		{ kind: providerKind, baseUrl: test ?? baseUrl, apiKey, model },
		test ? directFetch : createOutboundFetch(config.OUTBOUND_PROXY_URL),
	);
	return { client, settings: { ...settings, providerKind, baseUrl, model } };
}

/**
 * The client for the assistant and the price check: only when the feature is
 * on, has a key, the privacy notice was accepted at the current version, and
 * the month's token cap is not spent (SPEC.md section 20.4).
 */
export async function openModelClient(
	db: Kysely<Database>,
	config: Pick<
		ApiConfig,
		"SECOND_FACTOR_KEY" | "OUTBOUND_PROXY_URL" | "AI_TEST_BASE_URL"
	>,
): Promise<OpenedModel> {
	const settings = await loadAiSettings(db);
	if (!settings.enabled) return { unavailable: "off" };
	const opened = modelClientFor(settings, config);
	if (!opened) return { unavailable: "no-key" };
	if (settings.noticeVersion !== AI_NOTICE_VERSION) return { unavailable: "notice" };
	if ((await usedThisMonth(db)) >= settings.monthlyTokenCap) {
		return { unavailable: "monthly-cap" };
	}
	return opened;
}

/**
 * Whether an address points back at Portikus itself: the site's public host
 * or a preview host under its suffix. A model address there would let an
 * administrator aim the server's own requests at the site (SPEC.md section 24.1).
 */
export function isSiteOwnHost(
	address: string,
	config: Pick<ApiConfig, "PUBLIC_URL" | "PREVIEW_SUFFIX">,
): boolean {
	const host = new URL(address).hostname.toLowerCase();
	const site = new URL(config.PUBLIC_URL).hostname.toLowerCase();
	const suffix = config.PREVIEW_SUFFIX.toLowerCase();
	return host === site || host === suffix || host.endsWith(`.${suffix}`);
}

/**
 * The proxy host lists: the page-owned entries (which a save rewrites whole)
 * and every host the proxy opens on port 443. An entry for another port does
 * not make the host reachable on 443.
 */
export async function readProxyHosts(
	config: Pick<ApiConfig, "PROXY_HOSTS_FILE" | "OPERATOR_PROXY_HOSTS_FILE">,
): Promise<{ page: string[]; listed: Set<string> }> {
	const operator = await readProxyHostsFile(config.OPERATOR_PROXY_HOSTS_FILE);
	const page = await readProxyHostsFile(config.PROXY_HOSTS_FILE);
	const listed = new Set(
		[...operator, ...page].flatMap((entry) => {
			const host = entry.toLowerCase();
			if (!host.includes(":")) return [host];
			return host.endsWith(":443") ? [host.slice(0, -4)] : [];
		}),
	);
	return { page, listed };
}

export type SettingsRefusal = {
	status: 400 | 409;
	code: "VALIDATION_FAILED" | "AI_KEY_REQUIRED" | "AI_NOTICE_REQUIRED";
	message: string;
};

export type SettingsPlan = {
	patch: Updateable<Database["ai_settings"]>;
	/** The names of the fields that differ from what is saved. */
	changed: string[];
	keyChange?: "set" | "cleared";
};

function hasKeyAfter(body: UpdateAiSettingsRequest, current: AiSettings): boolean {
	if (body.key !== undefined) return true;
	if (body.clearKey === true) return false;
	return current.keySealed !== null;
}

function refusalFor(
	body: UpdateAiSettingsRequest,
	current: AiSettings,
	config: Pick<ApiConfig, "PUBLIC_URL" | "PREVIEW_SUFFIX">,
): SettingsRefusal | null {
	for (const address of [body.baseUrl, ...(body.priceSources ?? [])]) {
		if (address !== undefined && isSiteOwnHost(address, config)) {
			return {
				status: 400,
				code: "VALIDATION_FAILED",
				message: "That address is this site itself. Give the provider's address.",
			};
		}
	}
	if (body.enabled !== true) return null;
	if (!hasKeyAfter(body, current)) {
		return {
			status: 409,
			code: "AI_KEY_REQUIRED",
			message: "Save a key before turning this on.",
		};
	}
	if (current.noticeVersion !== AI_NOTICE_VERSION) {
		return {
			status: 409,
			code: "AI_NOTICE_REQUIRED",
			message: "Read and accept the privacy notice before turning this on.",
		};
	}
	return null;
}

/**
 * What a settings save changes, or why it is refused. Fields left out stay;
 * with no key the feature switches off, since it could not run (SPEC.md
 * section 20.4).
 */
export function planSettingsUpdate(
	body: UpdateAiSettingsRequest,
	current: AiSettings,
	config: Pick<ApiConfig, "SECOND_FACTOR_KEY" | "PUBLIC_URL" | "PREVIEW_SUFFIX">,
): SettingsPlan | SettingsRefusal {
	const refusal = refusalFor(body, current, config);
	if (refusal) return refusal;

	const patch: SettingsPlan["patch"] = {};
	const changed: string[] = [];
	const set = <K extends keyof SettingsPlan["patch"]>(
		name: string,
		column: K,
		value: SettingsPlan["patch"][K],
		old: unknown,
	) => {
		if (value === undefined || JSON.stringify(value) === JSON.stringify(old)) return;
		patch[column] = value;
		changed.push(name);
	};
	set("providerKind", "provider_kind", body.providerKind, current.providerKind);
	set("baseUrl", "base_url", body.baseUrl, current.baseUrl);
	set("model", "model", body.model, current.model);
	set(
		"monthlyTokenCap",
		"monthly_token_cap",
		body.monthlyTokenCap,
		current.monthlyTokenCap,
	);
	set(
		"conversationTokenBudget",
		"conversation_token_budget",
		body.conversationTokenBudget,
		current.conversationTokenBudget,
	);
	set("priceSources", "price_sources", body.priceSources, current.priceSources);

	let keyChange: SettingsPlan["keyChange"];
	if (body.key !== undefined) {
		patch.key_sealed = sealAiKey(config, body.key);
		patch.key_hint = body.key.slice(-4);
		keyChange = "set";
	} else if (body.clearKey === true && current.keySealed !== null) {
		patch.key_sealed = null;
		patch.key_hint = null;
		keyChange = "cleared";
	}
	if (keyChange) changed.push("key");

	const enabled = hasKeyAfter(body, current)
		? (body.enabled ?? current.enabled)
		: false;
	if (enabled !== current.enabled) {
		patch.enabled = enabled;
		changed.push("enabled");
	}
	return { patch, changed, ...(keyChange ? { keyChange } : {}) };
}

/**
 * The hosts of the base address and price sources that the server proxy
 * does not yet open on port 443, in the order they are used.
 */
export function unlistedHosts(addresses: string[], listed: Set<string>): string[] {
	const hosts = addresses.map((a) => new URL(a).hostname.toLowerCase());
	return [...new Set(hosts)].filter((host) => !listed.has(host));
}
