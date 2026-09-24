import type { Dispatcher } from "undici";

/** The `fetch` shape `openid-client` and `jose` accept through `customFetch`. */
export type OutboundFetch = (url: string, init: RequestInit) => Promise<Response>;

type Undici = typeof import("undici");

// Where undici and Node's bundled copy keep the process-wide fetch dispatcher.
const GLOBAL_DISPATCHER_KEYS = [
	Symbol.for("undici.globalDispatcher.1"),
	Symbol.for("undici.globalDispatcher.2"),
];

let undiciLoad: Promise<Undici> | null = null;

/**
 * Loading undici installs its own agent as the global fetch dispatcher,
 * which would change every other fetch in the process, such as the agent
 * client's (ruling 27: they stay as they are). So it is loaded only when a
 * proxy is configured, and Node's dispatcher is put back straight after.
 */
function loadUndici(): Promise<Undici> {
	if (!undiciLoad) {
		const slots = globalThis as unknown as Record<symbol, unknown>;
		const saved = GLOBAL_DISPATCHER_KEYS.map((key) => slots[key]);
		undiciLoad = import("undici").then((undici) => {
			GLOBAL_DISPATCHER_KEYS.forEach((key, index) => {
				slots[key] = saved[index];
			});
			return undici;
		});
	}
	return undiciLoad;
}

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
	let dispatcher: Dispatcher | null = null;
	return async (url, init) => {
		const undici = await loadUndici();
		dispatcher ??= new undici.ProxyAgent(proxyUrl);
		// undici's own fetch, because Node's bundled one is another undici
		// version that does not accept this dispatcher.
		return (await undici.fetch(url, {
			...(init as Parameters<Undici["fetch"]>[1]),
			dispatcher,
		})) as unknown as Response;
	};
}
