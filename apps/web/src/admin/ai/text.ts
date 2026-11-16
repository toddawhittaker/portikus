import type { AiSettingsView, AiTestStage, ProviderKind } from "@portikus/contracts";
import { AI_NOTICE_VERSION } from "@portikus/contracts";

/** Each provider kind's name and the base address the page fills in for it. */
export const PROVIDERS: Record<ProviderKind, { label: string; baseUrl: string }> = {
	"openai-compatible": {
		label: "OpenAI-compatible",
		baseUrl: "https://api.openai.com/v1",
	},
	anthropic: { label: "Anthropic", baseUrl: "https://api.anthropic.com" },
};

export const DEFAULT_MONTHLY_TOKEN_CAP = 5_000_000;
export const DEFAULT_CONVERSATION_TOKEN_BUDGET = 200_000;

/**
 * The base address to show after the kind changes: the new kind's own
 * address, unless the administrator typed one of their own.
 */
export function baseUrlForKind(kind: ProviderKind, current: string): string {
	const typed = current.trim();
	const isDefault = Object.values(PROVIDERS).some((p) => p.baseUrl === typed);
	return typed === "" || isDefault ? PROVIDERS[kind].baseUrl : current;
}

/** The host of an https address, lowercased, or null when it is not one. */
function hostOf(address: string): string | null {
	try {
		const url = new URL(address.trim());
		return url.protocol === "https:" ? url.hostname.toLowerCase() : null;
	} catch {
		return null;
	}
}

/**
 * The host the page offers to add to the server proxy host list (D5): the
 * draft address's host when it is not already listed. A saved host is listed
 * only when the API says so; any other host is offered.
 */
export function proxyOffer(draftBaseUrl: string, saved: AiSettingsView): string | null {
	const host = hostOf(draftBaseUrl);
	if (!host) return null;
	const savedHost = saved.baseUrl ? hostOf(saved.baseUrl) : null;
	if (host === savedHost && saved.hostListed) return null;
	return host;
}

export function noticeAccepted(view: AiSettingsView): boolean {
	return view.noticeVersion === AI_NOTICE_VERSION && view.noticeAcceptedAt !== null;
}

/** Why the switch cannot be turned on yet, or null when it can. */
export function switchBlocked(view: AiSettingsView): string | null {
	const notice = noticeAccepted(view);
	if (!view.keySet && !notice)
		return "Read and accept the privacy notice and set a key first.";
	if (!notice) return "Read and accept the privacy notice first.";
	if (!view.keySet) return "Set the provider's key first.";
	return null;
}

export function keyText(view: AiSettingsView): string {
	if (!view.keySet) return "Not set";
	return view.keyHint ? `Set, ends in ${view.keyHint}` : "Set";
}

export const TEST_STAGES: readonly { stage: AiTestStage; label: string }[] = [
	{ stage: "connect", label: "Connect to the provider" },
	{ stage: "reply", label: "Get a reply" },
	{ stage: "tool-call", label: "Call a tool" },
	{ stage: "tool-result", label: "Use the tool's result" },
];

export type StageState = "done" | "failed" | "not-reached";

/** Each stage's state: those up to `stage` worked, the next one failed on an error. */
export function stageStates(stage: AiTestStage | null, ok: boolean): StageState[] {
	const reached = stage ? TEST_STAGES.findIndex((s) => s.stage === stage) : -1;
	return TEST_STAGES.map((_, i) => {
		if (i <= reached) return "done";
		if (!ok && i === reached + 1) return "failed";
		return "not-reached";
	});
}

const TEST_ERRORS: Record<string, string> = {
	"not-configured":
		"Save a provider, a base address, a model and a key before testing.",
	auth: "The provider refused the key. Check that it is right and still active.",
	"rate-limited": "The provider is limiting requests. Wait a minute and test again.",
	unreachable:
		"The server could not reach the provider. Check the base address and that its host is allowed through the server proxy.",
	"bad-response":
		"The provider sent a reply Portikus could not read. Check the base address and the provider kind.",
	aborted: "The provider took too long to answer.",
	"no-tool-call":
		"The model replied but did not call the tool. Choose a model that supports tool calls.",
	"bad-tool-call":
		"The model called the tool the wrong way. Choose a model that handles tool calls better.",
	"empty-reply": "The model used the tool but then sent an empty reply.",
};

export function testErrorText(code: string): string {
	return (
		TEST_ERRORS[code] ?? "The test failed. Try again, or check the provider's settings."
	);
}

const NUMBER = new Intl.NumberFormat("en");
export function tokens(n: number): string {
	return `${NUMBER.format(n)} tokens`;
}

/** A whole number from a field, or null when the text is not one above zero. */
export function parseCount(text: string, max: number): number | null {
	const clean = text.replace(/[,_\s]/g, "");
	if (!/^\d+$/.test(clean)) return null;
	const n = Number(clean);
	return n > 0 && n <= max ? n : null;
}
