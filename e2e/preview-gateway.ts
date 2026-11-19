import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
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
 * The bootstrap's redirect to the wrapper page is handed to the browser (see
 * `frameRedirect`), so the browser makes its own request to
 * `/__portikus/frame/` with its own `Sec-Fetch-*` headers, and Caddy's rules
 * for that path are answered for a real browser request. The redirect to an
 * application page is still followed inside each gateway.
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
const FRAME_DIR = fileURLToPath(new URL("../apps/web/dist-frame", import.meta.url));
const FRAME_PREFIX = "/__portikus/frame";

/**
 * Stop a run at once, with the reason, when the wrapper page was never built,
 * instead of letting every preview open a blank frame.
 */
export function requireFrameBuild(): void {
	if (!existsSync(resolve(FRAME_DIR, "index.html"))) {
		throw new Error(
			`the preview wrapper build is missing (${FRAME_DIR}/index.html): build the web app first with \`pnpm build\``,
		);
	}
}

/**
 * The wrapper page's policy. It must match the `handle /__portikus/frame/*`
 * block in infra/ansible/roles/caddy/templates/Caddyfile.j2; `frame-ancestors`
 * is the Portikus origin there too.
 */
function frameContentSecurityPolicy(): string {
	return (
		"default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; " +
		`connect-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors ${WEB_ORIGIN}`
	);
}

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

	requireFrameBuild();
	const inside = request.pathname.slice(FRAME_PREFIX.length);
	const file = resolve(FRAME_DIR, inside === "/" ? "index.html" : inside.slice(1));
	// The URL parser has already removed dot segments; this keeps the check
	// true if a path ever arrives some other way.
	if (relative(FRAME_DIR, file).startsWith("..")) return none(404);
	let body: Buffer;
	try {
		body = await readFile(file);
	} catch {
		return none(404);
	}
	const assets = inside.startsWith("/assets/");
	return {
		status: 200,
		headers: {
			"content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
			"content-security-policy": frameContentSecurityPolicy(),
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

/** Whether a path is the wrapper page's route, which never reaches the application. */
function isFramePath(pathname: string): boolean {
	return pathname === FRAME_PREFIX || pathname.startsWith(`${FRAME_PREFIX}/`);
}

/**
 * What `Sec-Fetch-Dest` would be on a navigation. Chromium adds the `Sec-Fetch-*`
 * headers after Playwright has intercepted the request, so no route can read
 * them; the kind of navigation is the part that can be known. A sub-resource
 * (the wrapper's script and styles) is left as unknown.
 */
function navigationDest(request: Request): string | null {
	if (request.resourceType() !== "document") return null;
	return request.frame().parentFrame() === null ? "document" : "iframe";
}

/**
 * The wrapper page's answer to a browser request for a wrapper path, with the
 * cookie the edge holds for it; null for any other path.
 */
export async function frameAnswerFor(
	request: Request,
	cookie: string,
): Promise<Awaited<ReturnType<typeof frameAnswer>> | null> {
	const url = new URL(request.url());
	if (!isFramePath(url.pathname)) return null;
	return frameAnswer({
		method: request.method(),
		host: url.host,
		pathname: url.pathname,
		cookie,
		fetchDest: navigationDest(request),
		fetchUser: null,
	});
}

/**
 * The API's bootstrap answer when it sends an embedded preview to the wrapper
 * page, as a response to fulfil with; null for any other answer.
 *
 * A real 303 cannot be handed to the browser here: Chromium follows a fulfilled
 * redirect without asking the route again, so the follow-up request would go
 * to `https://` on a host this environment has no certificate for. A
 * `Refresh: 0` response is the nearest thing that still makes the browser
 * request the wrapper page itself, as a frame navigation with its own
 * `Sec-Fetch-*` headers, through the route. The cookie the API set rides on
 * this response, and `edgeCookieJar` holds the copy the follow-up request needs.
 */
export function frameRedirect(answer: Response): {
	status: number;
	headers: Record<string, string>;
} | null {
	const location = answer.headers.get("location");
	if (answer.status !== 303 || location === null || !isFramePath(location)) return null;
	const headers = {
		...headersOf(answer, PASSED_HEADERS),
		refresh: `0; url=${location}`,
	};
	const setCookie = answer.headers.getSetCookie();
	return {
		status: 200,
		headers:
			setCookie.length > 0
				? { ...headers, "set-cookie": setCookie.join("\n") }
				: headers,
	};
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
	requireFrameBuild();
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

			// Reserved paths never reach the student application
			// (BROWSER-HANDLING.md §12).
			const wrapper = await frameAnswerFor(request, cookie);
			if (wrapper) return route.fulfill(wrapper);
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

				const toWrapper = frameRedirect(answer);
				if (toWrapper) return route.fulfill(toWrapper);

				// The bootstrap just minted a session: follow the redirect with
				// that cookie alone, never a stale one the jar still holds.
				const withSession = [fromBrowser, cookiePairs(answer)]
					.filter(Boolean)
					.join("; ");
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
