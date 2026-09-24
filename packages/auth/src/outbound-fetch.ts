import { createRequire } from "node:module";
import { Readable } from "node:stream";
import type { Dispatcher, ProxyAgent as ProxyAgentType } from "undici";

/** The `fetch` shape `openid-client` and `jose` accept through `customFetch`. */
export type OutboundFetch = (url: string, init: RequestInit) => Promise<Response>;

// undici's package entry installs its own global fetch dispatcher when it
// loads, which would change every other fetch in the process (such as the
// agent client's). The ProxyAgent and request modules on their own do not,
// so only they are loaded, and requests go through them rather than a fetch.
// Internal paths of undici 8.10.2, pinned; outbound-fetch tests fail if a bump moves them.
const requireUndici = createRequire(import.meta.url);
const ProxyAgent = requireUndici(
	"undici/lib/dispatcher/proxy-agent.js",
) as typeof ProxyAgentType;
const request = requireUndici("undici/lib/api/api-request.js") as (
	this: Dispatcher,
	options: Dispatcher.RequestOptions,
) => Promise<Dispatcher.ResponseData>;

// Statuses whose Response must have no body.
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/**
 * The fetch for the API's outbound provider requests: OIDC discovery, token
 * and userinfo requests, and LMS keysets (docs/EPIC-14.md ruling 27). With a
 * proxy URL every request goes through that forward proxy; without one it is
 * the plain global fetch, for development and tests.
 */
export function createOutboundFetch(
	proxyUrl: string | null | undefined,
): OutboundFetch {
	if (!proxyUrl) {
		return (url, init) => fetch(url, init);
	}
	const agent = new ProxyAgent(proxyUrl);
	return async (url, init) => {
		const target = new URL(url);
		const headers: Record<string, string> = {};
		new Headers(init.headers).forEach((value, name) => {
			headers[name] = value;
		});
		// The libraries send only strings or form parameters as bodies.
		const body =
			init.body === undefined || init.body === null ? undefined : String(init.body);
		const answer = await request.call(agent, {
			origin: target.origin,
			path: `${target.pathname}${target.search}`,
			method: (init.method ?? "GET") as "GET",
			headers,
			body,
			signal: init.signal ?? undefined,
		});
		const responseHeaders = new Headers();
		for (const [name, value] of Object.entries(answer.headers)) {
			if (Array.isArray(value)) {
				for (const item of value) responseHeaders.append(name, item);
			} else if (value !== undefined) {
				responseHeaders.set(name, value);
			}
		}
		if (NULL_BODY_STATUSES.has(answer.statusCode)) {
			answer.body.resume();
			return new Response(null, {
				status: answer.statusCode,
				headers: responseHeaders,
			});
		}
		return new Response(Readable.toWeb(answer.body) as ReadableStream, {
			status: answer.statusCode,
			headers: responseHeaders,
		});
	};
}
