import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserContext, Frame, Page, Request } from "@playwright/test";
import { cookiePairs, headersOf } from "./helpers";
import { API_ORIGIN, WEB_ORIGIN } from "./ports";

/**
 * A stand-in for Caddy in front of preview hosts, for tests that open a
 * preview in the page (ADR 0018, BROWSER-HANDLING.md §10).
 *
 * A preview host such as `ws-1234abcd-5173.preview.localhost:5173` has no DNS
 * entry and no TLS certificate here, so `previewGateway` intercepts the
 * browser's requests to that host and does what Caddy would do:
 *
 *   - `/__portikus/frame/*` is the wrapper page an embedded preview opens
 *     (BROWSER-HANDLING.md §12.1), served from the build under the rules of
 *     the real Caddy route; see `frameAnswer`;
 *   - the rest of `/__portikus/*` goes to the API, which consumes the
 *     bootstrap ticket, mints the preview-host session cookie and redirects to
 *     the wrapper page, or to `/` for a preview opened in its own tab;
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

/** Where Caddy serves the wrapper page from; the web build writes it here. */
const FRAME_DIR = fileURLToPath(
	new URL("../apps/web/dist/preview-frame", import.meta.url),
);
export const FRAME_PREFIX = "/__portikus/frame";

const CONTENT_TYPES: Record<string, string> = {
	".html": "text/html",
	".js": "text/javascript",
	".css": "text/css",
	".map": "application/json",
};

interface FrameRequest {
	method: string;
	host: string;
	pathname: string;
	cookie: string;
	/** `Sec-Fetch-Dest` and `Sec-Fetch-User` as the browser sent them, if at all. */
	fetchDest: string | null;
	fetchUser: string | null;
}

/**
 * The wrapper page as the real Caddy route answers it (the
 * `handle /__portikus/frame/*` block in the Caddyfile template, SPEC.md
 * section 24):
 *
 *   - GET and HEAD only, else 405;
 *   - a request whose `Sec-Fetch-Dest` is present and not `iframe` is
 *     refused with 403, so the page can only be framed;
 *   - the same login check as the application path, made with the path
 *     rewritten to `/`; a refusal or the stopped page is passed back as is;
 *   - the build's `index.html` for the folder, its assets by path, with the
 *     page's policy (`frame-ancestors` is the Portikus origin) and caching.
 */
export async function frameAnswer(
	request: FrameRequest,
): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
	const none = (status: number, headers: Record<string, string> = {}) => ({
		status,
		headers,
		body: Buffer.alloc(0),
	});
	if (request.pathname === FRAME_PREFIX) {
		return none(308, { location: `${FRAME_PREFIX}/` });
	}
	if (request.method !== "GET" && request.method !== "HEAD") return none(405);
	if (request.fetchDest !== null && request.fetchDest !== "iframe") return none(403);

	// Caddy forwards the request's own headers to the check, so a user-started
	// load still counts as activity (ADR 0032).
	const authorized = await fetch(`${API_ORIGIN}/preview/authorize`, {
		headers: {
			"x-forwarded-host": request.host,
			"x-forwarded-proto": "https",
			"x-forwarded-method": "GET",
			"x-forwarded-uri": "/",
			cookie: request.cookie,
			...(request.fetchDest === null ? {} : { "sec-fetch-dest": request.fetchDest }),
			...(request.fetchUser === null ? {} : { "sec-fetch-user": request.fetchUser }),
		},
		redirect: "manual",
	});
	if (!authorized.ok) {
		return {
			status: authorized.status,
			headers: headersOf(authorized, PASSED_HEADERS),
			body: Buffer.from(await authorized.arrayBuffer()),
		};
	}

	const relative = normalize(request.pathname.slice(FRAME_PREFIX.length));
	const file = relative === "/" ? "index.html" : relative.slice(1);
	if (file.startsWith("..")) return none(404);
	let body: Buffer;
	try {
		body = await readFile(join(FRAME_DIR, file));
	} catch {
		return none(404);
	}
	const assets = relative.startsWith("/assets/");
	return {
		status: 200,
		headers: {
			"content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
			"content-security-policy":
				"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; " +
				`frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors ${WEB_ORIGIN}`,
			"cache-control": assets ? "public, max-age=31536000, immutable" : "no-cache",
		},
		body: request.method === "HEAD" ? Buffer.alloc(0) : body,
	};
}

/**
 * The student's application inside an embedded preview. The Preview pane's
 * frame holds the wrapper page, and the wrapper holds the application in a
 * frame of its own.
 */
export function appFrameLocator(page: Page) {
	return page.frameLocator("[data-testid=preview-frame]").frameLocator("iframe.app");
}

/** The application's own document, where scripts run as preview code. */
export function appFrame(page: Page): Frame {
	const frame = page.frames().find((one) => {
		try {
			return (
				new URL(one.url()).hostname.endsWith(PREVIEW_SUFFIX) &&
				one.parentFrame()?.parentFrame() === page.mainFrame()
			);
		} catch {
			return false;
		}
	});
	if (!frame) throw new Error("the preview frame is not there");
	return frame;
}

/**
 * The preview session cookie, held here rather than in the browser.
 *
 * The supported deployment is same-site: Portikus and the preview suffix
 * share a registrable domain (BROWSER-HANDLING.md §7.1), so the
 * `SameSite=Strict` preview cookie is stored and sent for every request the
 * preview page makes, the wrapper's own scripts included. This development
 * environment cannot be same-site, because Portikus is on 127.0.0.1 and an IP
 * address has no subdomains, so Chromium treats those requests as cross-site
 * and drops the cookie. This jar stands in for the browser Portikus is really
 * deployed against. Nothing else is faked: every value in it came from the API.
 */
export function edgeCookieJar() {
	const jar = new Map<string, string>();
	return {
		/** The session cookie the edge is holding for a host. */
		held: (host: string) => jar.get(host),

		/** What the edge sends on: the browser's cookies plus the jar's. */
		withJar(host: string, browser: string): string {
			const names = browser
				.split(";")
				.map((one) => one.split("=")[0]?.trim() ?? "")
				.filter(Boolean);
			const held = jar.get(host);
			if (held === undefined || names.includes("portikus-preview")) return browser;
			return [browser, `portikus-preview=${held}`].filter(Boolean).join("; ");
		},

		/** Record what the API set or cleared for this host. */
		remember(host: string, response: Response): void {
			for (const line of response.headers.getSetCookie()) {
				const pair = line.split(";")[0] ?? "";
				const separator = pair.indexOf("=");
				if (pair.slice(0, separator).trim() !== "portikus-preview") continue;
				const value = pair.slice(separator + 1).trim();
				if (value === "") jar.delete(host);
				else jar.set(host, value);
			}
		},
	};
}

/** The wrapper page's answer to a browser request, with the cookie the edge holds for it. */
export async function frameAnswerFor(
	request: Request,
	pathname: string,
	cookie: string,
): ReturnType<typeof frameAnswer> {
	return frameAnswer({
		method: request.method(),
		host: new URL(request.url()).host,
		pathname,
		cookie,
		fetchDest: (await request.headerValue("sec-fetch-dest")) ?? null,
		fetchUser: (await request.headerValue("sec-fetch-user")) ?? null,
	});
}

/**
 * Stand in for Caddy for the browser's requests to preview hosts. Returns a
 * count of the requests that reached the student application, which is how a
 * test says the application itself was really fetched. Pass the context
 * rather than the page when the preview opens in a new tab.
 */
export async function previewGateway(
	page: Page | BrowserContext,
): Promise<{ app: number }> {
	const counts = { app: 0 };
	const jar = edgeCookieJar();

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
			const fromBrowser = (await request.headerValue("cookie")) ?? "";
			const cookie = jar.withJar(host, fromBrowser);
			const path = `${url.pathname}${url.search}`;

			const frame = (pathname: string, cookies: string) =>
				frameAnswerFor(request, pathname, cookies);

			// Reserved paths never reach the student application
			// (BROWSER-HANDLING.md §12).
			if (
				url.pathname === FRAME_PREFIX ||
				url.pathname.startsWith(`${FRAME_PREFIX}/`)
			) {
				return route.fulfill(await frame(url.pathname, cookie));
			}
			if (url.pathname.startsWith("/__portikus/")) {
				const answer = await fetch(`${API_ORIGIN}${path}`, {
					headers: {
						"x-forwarded-host": host,
						"x-forwarded-proto": "https",
						cookie,
					},
					redirect: "manual",
				});
				jar.remember(host, answer);
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

				// The bootstrap just minted a session: follow the redirect with
				// that cookie alone, never a stale one the jar still holds.
				const withSession = [fromBrowser, cookiePairs(answer)]
					.filter(Boolean)
					.join("; ");
				// An embedded preview is sent to the wrapper page.
				if (location.startsWith(`${FRAME_PREFIX}/`)) {
					const page = await frame(location, withSession);
					return route.fulfill({
						...page,
						headers: {
							...page.headers,
							...(headers["set-cookie"] ? { "set-cookie": headers["set-cookie"] } : {}),
						},
					});
				}
				const app = await proxy(host, location, withSession);
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
