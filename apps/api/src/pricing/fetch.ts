import type { ApiConfig } from "@portikus/config";
import { isAiBaseUrl } from "@portikus/contracts";
import type { OutboundFetch } from "@portikus/observability";
import { isSiteOwnHost } from "../ai/settings.js";

const SOURCE_TIMEOUT_MS = 20_000;
export const SOURCE_MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;

type SourceFetchError =
	| "refused"
	| "unreachable"
	| "too-large"
	| "bad-redirect"
	| "timeout";

export type SourcePage =
	| { ok: true; html: string }
	| { ok: false; error: SourceFetchError };

export type SourceFetchOptions = {
	/** Requests leave through the server proxy (ADR 0027). */
	outbound: OutboundFetch;
	/** The e2e fake: read `<origin>/__page?url=` with a plain fetch instead. */
	testBaseUrl?: string | undefined;
	/** The site's own hosts, which no redirect may reach. */
	site: Pick<ApiConfig, "PUBLIC_URL" | "PREVIEW_SUFFIX">;
	timeoutMs?: number;
};

async function readCapped(response: Response): Promise<string | null> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > SOURCE_MAX_BYTES) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks).toString("utf8");
}

async function getPage(
	url: string,
	fetchFn: OutboundFetch,
	signal: AbortSignal,
	redirectAllowed: (next: string) => boolean,
): Promise<SourcePage> {
	let current = url;
	for (let hop = 0; ; hop++) {
		const response = await fetchFn(current, {
			method: "GET",
			headers: { accept: "text/html,text/plain" },
			redirect: "manual",
			signal,
		});
		if (response.status >= 300 && response.status < 400) {
			await response.body?.cancel();
			const location = response.headers.get("location");
			if (!location || hop >= MAX_REDIRECTS)
				return { ok: false, error: "bad-redirect" };
			const next = new URL(location, current).href;
			if (!redirectAllowed(next)) return { ok: false, error: "bad-redirect" };
			current = next;
			continue;
		}
		if (!response.ok) {
			await response.body?.cancel();
			return { ok: false, error: "refused" };
		}
		const html = await readCapped(response);
		return html === null ? { ok: false, error: "too-large" } : { ok: true, html };
	}
}

/**
 * Read one pricing source: https only, a time limit, a size limit and at
 * most three redirects, each to a public https host other than this site
 * (SPEC.md section 24.1). A failure is a
 * code, never the page or the proxy's answer.
 */
export async function fetchSource(
	url: string,
	options: SourceFetchOptions,
): Promise<SourcePage> {
	if (new URL(url).protocol !== "https:") return { ok: false, error: "refused" };
	const signal = AbortSignal.timeout(options.timeoutMs ?? SOURCE_TIMEOUT_MS);
	try {
		if (options.testBaseUrl) {
			const origin = new URL(options.testBaseUrl).origin;
			const page = `${origin}/__page?url=${encodeURIComponent(url)}`;
			const httpsOnly = (next: string) => new URL(next).protocol === "https:";
			return await getPage(page, (u, init) => fetch(u, init), signal, httpsOnly);
		}
		// Each hop meets the rules a saved address does: https, a public host,
		// and never this site itself (SPEC.md section 24.1).
		const safe = (next: string) =>
			isAiBaseUrl(next) && !isSiteOwnHost(next, options.site);
		return await getPage(url, options.outbound, signal, safe);
	} catch {
		return { ok: false, error: signal.aborted ? "timeout" : "unreachable" };
	}
}
