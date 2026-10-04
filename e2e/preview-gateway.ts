import type { Page } from "@playwright/test";
import { cookiePairs, headersOf } from "./helpers";
import { API_ORIGIN } from "./ports";

/**
 * A stand-in for Caddy in front of preview hosts, for tests that open a
 * preview in the page (ADR 0018, BROWSER-HANDLING.md §10).
 *
 * A preview host such as `ws-1234abcd-5173.preview.localhost:5173` has no DNS
 * entry and no TLS certificate here, so `previewGateway` intercepts the
 * browser's requests to that host and does what Caddy would do:
 *
 *   - `/__portikus/*` goes to the API, which consumes the bootstrap ticket,
 *     mints the preview-host session cookie and redirects to `/`;
 *   - every other path is authorized by the API's `/preview/authorize`
 *     subrequest and then proxied to the upstream that answer names, which is
 *     the little application the fake agent is really running.
 *
 * The bootstrap redirect is followed inside the gateway rather than handed to
 * the browser: Chromium follows a redirect from an intercepted response
 * without consulting the route again, and that redirected request would then
 * need the TLS this environment has no certificate for. The browser still
 * receives the preview cookie, so its own later requests to the preview host
 * go through the authorization subrequest as they would in production.
 */

/** The preview suffix the end-to-end API is configured with. */
const PREVIEW_SUFFIX = ".preview.localhost";

/**
 * The response headers worth passing on. Hop-by-hop headers such as
 * `connection` must never be replayed into a fulfilled response.
 */
const PASSED_HEADERS = [
	"content-type",
	"cache-control",
	"referrer-policy",
	"clear-site-data",
	"x-frame-options",
	"content-security-policy",
];

/**
 * Stand in for Caddy for the browser's requests to preview hosts. Returns a
 * count of the requests that reached the student application, which is how a
 * test says the application itself was really fetched.
 */
export async function previewGateway(page: Page): Promise<{ app: number }> {
	const counts = { app: 0 };

	/** Authorize one request and proxy it to the upstream the API names. */
	async function proxy(
		host: string,
		path: string,
		cookie: string,
	): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
		const forwarded = {
			"x-forwarded-host": host,
			"x-forwarded-proto": "https",
			cookie,
		};
		const authorized = await fetch(`${API_ORIGIN}/preview/authorize`, {
			headers: forwarded,
			redirect: "manual",
		});
		if (!authorized.ok) {
			return {
				status: authorized.status,
				headers: headersOf(authorized, PASSED_HEADERS),
				body: Buffer.from(await authorized.arrayBuffer()),
			};
		}
		const upstream = authorized.headers.get("x-portikus-upstream");
		if (!upstream) throw new Error("the authorization answer named no upstream");
		counts.app += 1;
		const proxied = await fetch(`http://${upstream}${path}`, {
			headers: { host },
			redirect: "manual",
		});
		return {
			status: proxied.status,
			headers: headersOf(proxied, PASSED_HEADERS),
			body: Buffer.from(await proxied.arrayBuffer()),
		};
	}

	await page.route(
		(url) => url.hostname.endsWith(PREVIEW_SUFFIX),
		async (route) => {
			const request = route.request();
			const url = new URL(request.url());
			const host = url.host;
			const cookie = (await request.headerValue("cookie")) ?? "";
			const path = `${url.pathname}${url.search}`;

			// Reserved paths never reach the student application
			// (BROWSER-HANDLING.md §12).
			if (url.pathname.startsWith("/__portikus/")) {
				const answer = await fetch(`${API_ORIGIN}${path}`, {
					headers: {
						"x-forwarded-host": host,
						"x-forwarded-proto": "https",
						cookie,
					},
					redirect: "manual",
				});
				const headers = headersOf(answer, PASSED_HEADERS);
				const setCookie = answer.headers.getSetCookie();
				if (setCookie.length > 0) headers["set-cookie"] = setCookie.join("\n");

				// Anything but the bootstrap redirect is a Portikus page, passed
				// straight through.
				const location = answer.headers.get("location");
				if (answer.status !== 303 || location === null) {
					return route.fulfill({
						status: answer.status,
						headers,
						body: Buffer.from(await answer.arrayBuffer()),
					});
				}

				const app = await proxy(
					host,
					location,
					[cookie, cookiePairs(answer)].filter(Boolean).join("; "),
				);
				return route.fulfill({
					status: app.status,
					headers: { ...app.headers, ...headers },
					body: app.body,
				});
			}

			const app = await proxy(host, path, cookie);
			return route.fulfill({
				status: app.status,
				headers: app.headers,
				body: app.body,
			});
		},
	);

	return counts;
}
