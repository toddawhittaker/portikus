import { ProxyAgent, fetch as undiciFetch } from "undici";

/** The `fetch` shape `openid-client` and `jose` accept through `customFetch`. */
export type OutboundFetch = (url: string, init: RequestInit) => Promise<Response>;

/**
 * The fetch for the API's outbound provider requests: OIDC discovery, token
 * and keyset requests, and LMS keysets (docs/EPIC-14.md ruling 27). With a
 * proxy URL every request goes through that forward proxy; without one it is
 * the plain global fetch, for development and tests.
 */
export function createOutboundFetch(
	proxyUrl: string | null | undefined,
): OutboundFetch {
	if (!proxyUrl) {
		return (url, init) => fetch(url, init);
	}
	const dispatcher = new ProxyAgent(proxyUrl);
	// undici's own fetch, because the global one may bundle another undici
	// version that does not accept this dispatcher.
	return (url, init) =>
		undiciFetch(url, {
			...(init as Parameters<typeof undiciFetch>[1]),
			dispatcher,
		}) as unknown as Promise<Response>;
}
