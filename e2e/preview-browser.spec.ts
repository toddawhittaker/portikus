import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	deleteSessions,
	seedListening,
	setWorkspaceState,
	toast,
	workspacePath,
} from "./helpers";

/**
 * What the browser itself must and must not do with a preview
 * (BROWSER-HANDLING.md §12, §16, §25.1, §26).
 *
 * As in preview.spec.ts, the only faked hop is Caddy: a preview host has no
 * DNS entry or certificate here, so the gateway below intercepts the
 * browser's requests to it and does what the edge would — `/__portikus/*`
 * to the API, everything else authorized by `/preview/authorize` and then
 * proxied to the upstream that answer names. The route is registered on the
 * whole browser context, not one page, because these tests also open
 * top-level tabs and popups on the preview origin.
 *
 * The application behind the preview is a real HTTP server this file starts
 * on 127.0.0.1, richer than the fake agent's one-page app: it sets a cookie
 * and localStorage, accepts a form post, opens a window, and can register a
 * service worker. It is reported to the control plane through the fake
 * agent's listening list, so the grant, the ticket, the preview session and
 * the upstream lookup are all the real API.
 */

const API_ORIGIN = "http://127.0.0.1:3000";
const PREVIEW_SUFFIX = ".preview.localhost";

const PASSED_HEADERS = [
	"content-type",
	"cache-control",
	"referrer-policy",
	"clear-site-data",
	"x-frame-options",
	"content-security-policy",
	"service-worker-allowed",
];

function headersOf(response: Response): Record<string, string> {
	const headers: Record<string, string> = {};
	for (const name of PASSED_HEADERS) {
		const value = response.headers.get(name);
		if (value !== null) headers[name] = value;
	}
	return headers;
}

function cookiePairs(response: Response): string {
	return response.headers
		.getSetCookie()
		.map((line) => line.split(";")[0] ?? "")
		.filter(Boolean)
		.join("; ");
}

interface Seen {
	/** Every cookie header the browser sent to a preview host. */
	cookies: string[];
	/** Every request the student application really answered. */
	app: string[];
	/** The preview session cookie the edge is holding for a host. */
	session: (host: string) => string | undefined;
	/** Every reserved `/__portikus/` request the edge answered, and how. */
	reserved: { path: string; clearSiteData: string | null }[];
}

/** Stand in for Caddy for every page in one browser context. */
async function previewGateway(context: BrowserContext): Promise<Seen> {
	/**
	 * The preview session cookie, held here rather than in the browser.
	 *
	 * The supported deployment is same-site: Portikus and the preview suffix
	 * share a registrable domain (BROWSER-HANDLING.md §7.1), so the
	 * `SameSite=Strict` preview cookie is stored and sent inside the frame.
	 * This development environment cannot be same-site, because Portikus is
	 * on 127.0.0.1 and an IP address has no subdomains, so Chromium treats
	 * every preview request as cross-site and drops the cookie. This jar
	 * stands in for the browser Portikus is really deployed against. Nothing
	 * else is faked: every value in it came from the API, and the browser's
	 * own cookie header is still what the Portikus-cookie test reads.
	 */
	const jar = new Map<string, string>();
	const seen: Seen = {
		cookies: [],
		app: [],
		session: (host) => jar.get(host),
		reserved: [],
	};

	/** What the edge sends on: the browser's cookies plus the jar's. */
	function withJar(host: string, browser: string): string {
		const names = browser
			.split(";")
			.map((one) => one.split("=")[0]?.trim() ?? "")
			.filter(Boolean);
		const held = jar.get(host);
		if (held === undefined || names.includes("portikus-preview")) return browser;
		return [browser, `portikus-preview=${held}`].filter(Boolean).join("; ");
	}

	/** Record what the API set or cleared for this host. */
	function remember(host: string, response: Response): void {
		for (const line of response.headers.getSetCookie()) {
			const pair = line.split(";")[0] ?? "";
			const separator = pair.indexOf("=");
			if (pair.slice(0, separator).trim() !== "portikus-preview") continue;
			const value = pair.slice(separator + 1).trim();
			if (value === "") jar.delete(host);
			else jar.set(host, value);
		}
	}

	async function proxy(
		host: string,
		method: string,
		path: string,
		cookie: string,
		body: Buffer | null,
		contentType: string | null,
	): Promise<{ status: number; headers: Record<string, string>; body: Buffer }> {
		const authorized = await fetch(`${API_ORIGIN}/preview/authorize`, {
			headers: { "x-forwarded-host": host, "x-forwarded-proto": "https", cookie },
			redirect: "manual",
		});
		if (!authorized.ok) {
			return {
				status: authorized.status,
				headers: headersOf(authorized),
				body: Buffer.from(await authorized.arrayBuffer()),
			};
		}
		const upstream = authorized.headers.get("x-portikus-upstream");
		if (!upstream) throw new Error("the authorization answer named no upstream");
		seen.app.push(`${method} ${path}`);
		const proxied = await fetch(`http://${upstream}${path}`, {
			method,
			headers: {
				host,
				cookie,
				...(contentType === null ? {} : { "content-type": contentType }),
			},
			body: body ?? undefined,
			redirect: "manual",
		});
		const headers = headersOf(proxied);
		const setCookie = proxied.headers.getSetCookie();
		if (setCookie.length > 0) headers["set-cookie"] = setCookie.join("\n");
		const location = proxied.headers.get("location");
		if (location !== null) headers.location = location;
		return {
			status: proxied.status,
			headers,
			body: Buffer.from(await proxied.arrayBuffer()),
		};
	}

	await context.route(
		(url) => url.hostname.endsWith(PREVIEW_SUFFIX),
		async (route) => {
			const request = route.request();
			const url = new URL(request.url());
			const host = url.host;
			const fromBrowser = (await request.headerValue("cookie")) ?? "";
			seen.cookies.push(fromBrowser);
			const cookie = withJar(host, fromBrowser);
			const path = `${url.pathname}${url.search}`;
			const raw = request.postDataBuffer();
			const contentType = await request.headerValue("content-type");

			if (url.pathname.startsWith("/__portikus/")) {
				const answer = await fetch(`${API_ORIGIN}${path}`, {
					headers: { "x-forwarded-host": host, "x-forwarded-proto": "https", cookie },
					redirect: "manual",
				});
				remember(host, answer);
				seen.reserved.push({
					path: url.pathname,
					clearSiteData: answer.headers.get("clear-site-data"),
				});
				const headers = headersOf(answer);
				const setCookie = answer.headers.getSetCookie();
				if (setCookie.length > 0) headers["set-cookie"] = setCookie.join("\n");

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
				const app = await proxy(
					host,
					"GET",
					location,
					[fromBrowser, cookiePairs(answer)].filter(Boolean).join("; "),
					null,
					null,
				);
				return route.fulfill({
					status: app.status,
					headers: { ...app.headers, ...headers },
					body: app.body,
				});
			}

			const app = await proxy(host, request.method(), path, cookie, raw, contentType);
			return route.fulfill({
				status: app.status,
				headers: app.headers,
				body: app.body,
			});
		},
	);

	return seen;
}

/**
 * A small application with the browser behaviors the spec names: stored
 * state, a cookie, a form, a popup, and an optional service worker.
 */
function startApp(
	title: string,
	/** Sent as `X-Frame-Options` on every answer, for the refused-framing path. */
	frameOptions?: string,
	/** Answer every request the way Vite refuses a host it does not allow. */
	blockHost?: boolean,
): Promise<{ port: number; close: () => Promise<void> }> {
	const page = (body: string) =>
		`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head>` +
		`<body>${body}</body></html>`;

	const home = page(`
		<h1 id="title">${title}</h1>
		<a id="link" href="/second">Second page</a>
		<button id="push" type="button">Push a route</button>
		<p id="state">pending</p>
		<p id="cookie">pending</p>
		<form id="form" method="POST" action="/form">
			<input name="field" value="hello">
			<button id="send" type="submit">Send</button>
		</form>
		<button id="popup" type="button">Open a window</button>
		<button id="register" type="button">Register a worker</button>
		<p id="worker">no worker</p>
		<script>
			const note = localStorage.getItem("app-note") ?? "none";
			document.getElementById("state").textContent = "note:" + note;
			localStorage.setItem("app-note", "kept");
			document.cookie = "app-cookie=chocolate; path=/";
			const cookie = document.cookie === "" ? "none" : document.cookie;
			document.getElementById("cookie").textContent = "cookie:" + cookie;
			// A single-page route change, which leaves an entry in the joint
			// history without loading the frame again (issue #271).
			document.getElementById("push").addEventListener("click", () => {
				history.pushState({}, "", "/pushed");
				document.getElementById("title").textContent = "pushed route";
			});
			window.addEventListener("popstate", () => {
				document.getElementById("title").textContent =
					location.pathname === "/pushed" ? "pushed route" : "${title}";
			});
			document.getElementById("popup").addEventListener("click", () => {
				window.open("/opened", "_blank");
			});
			document.getElementById("register").addEventListener("click", async () => {
				try {
					await navigator.serviceWorker.register("/sw.js");
					await navigator.serviceWorker.ready;
					document.getElementById("worker").textContent = "worker ready";
				} catch (error) {
					document.getElementById("worker").textContent = "worker failed: " + error;
				}
			});
		</script>`);

	const worker =
		"self.addEventListener('install', () => self.skipWaiting());\n" +
		"self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));\n" +
		// Answers everything, so a reserved path that reached it would be obvious.
		"self.addEventListener('fetch', (event) => {\n" +
		"  event.respondWith(new Response('<h1 id=\"title\">the service worker answered</h1>'," +
		" { headers: { 'content-type': 'text/html' } }));\n" +
		"});\n";

	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://app.invalid");
		if (frameOptions) response.setHeader("x-frame-options", frameOptions);
		if (blockHost) {
			// Word for word what Vite answers for a host it does not allow.
			const host = request.headers.host ?? "";
			response.writeHead(403, { "content-type": "text/html; charset=utf-8" });
			response.end(
				`Blocked request. This host ("${host}") is not allowed.\n` +
					`To allow this host, add "${host}" to \`server.allowedHosts\` in ` +
					"vite.config.js.",
			);
			return;
		}
		if (url.pathname === "/second") {
			response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			response.end(
				page('<h1 id="title">second page</h1><a id="home" href="/">Home</a>'),
			);
			return;
		}
		if (url.pathname === "/sw.js") {
			response.writeHead(200, {
				"content-type": "text/javascript",
				"service-worker-allowed": "/",
			});
			response.end(worker);
			return;
		}
		if (url.pathname === "/opened") {
			response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			response.end(page('<h1 id="title">opened window</h1>'));
			return;
		}
		if (url.pathname === "/form" && request.method === "POST") {
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				const field = new URLSearchParams(Buffer.concat(chunks).toString()).get(
					"field",
				);
				response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
				response.end(page(`<h1 id="title">form received ${field}</h1>`));
			});
			return;
		}
		response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		response.end(home);
	});

	return new Promise((resolve) => {
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as AddressInfo;
			resolve({
				port,
				close: () =>
					new Promise<void>((done) => {
						server.closeAllConnections();
						server.close(() => done());
					}),
			});
		});
	});
}

/** Start the application and tell the control plane it is listening. */
async function startPreview(
	workspaceId: string,
	title: string,
	frameOptions?: string,
	blockHost?: boolean,
): Promise<{ port: number; close: () => Promise<void>; stop: () => Promise<void> }> {
	const app = await startApp(title, frameOptions, blockHost);
	await seedListening(workspaceId, [{ port: app.port }]);
	return {
		port: app.port,
		close: app.close,
		// What the student sees when the application exits.
		stop: async () => {
			await seedListening(workspaceId, []);
			await app.close();
		},
	};
}

async function openPreviewTab(
	page: Page,
	workspaceId: string,
	port: number,
	/** What the tab must end up showing; the frame unless a state replaces it. */
	expected = "preview-frame",
): Promise<void> {
	const project = await createProject(workspaceId, { name: "preview-browser" });
	await page.goto(workspacePath(workspaceId, project.id));
	await expect(page.getByTestId("work-tabs")).toBeVisible({ timeout: 15_000 });
	await page.getByTestId("right-pane-tab-running").click();
	await page.getByTestId(`running-open-${port}`).click({ timeout: 20_000 });
	await expect(page.getByTestId(expected)).toBeVisible({ timeout: 20_000 });
}

function appHeading(page: Page) {
	return page.frameLocator("[data-testid=preview-frame]").locator("#title");
}

/** The frame's own document, for scripts that must run as preview code. */
function previewFrame(page: Page) {
	const frame = page.frames().find((one) => {
		try {
			return new URL(one.url()).hostname.endsWith(PREVIEW_SUFFIX);
		} catch {
			return false;
		}
	});
	if (!frame) throw new Error("the preview frame is not there");
	return frame;
}

/** The origin the preview tab is showing, taken from the toolbar. */
async function previewOrigin(page: Page): Promise<string> {
	const host = await page.getByTestId("preview-host").textContent();
	return `https://${host ?? ""}`;
}

test.describe("the preview in a real browser", () => {
	test("the Portikus session cookie never reaches the preview host", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const seen = await previewGateway(context);
		const app = await startPreview(student.workspaceId, "Cookie check");
		await openPreviewTab(page, student.workspaceId, app.port);
		await expect(appHeading(page)).toHaveText("Cookie check", { timeout: 20_000 });

		expect(seen.cookies.length).toBeGreaterThan(0);
		for (const cookie of seen.cookies) {
			expect(cookie).not.toContain("portikus_session");
			expect(cookie).not.toContain(student.sessionToken);
		}
		await app.close();
	});

	test("preview code cannot read the Portikus DOM or storage", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await previewGateway(context);
		const app = await startPreview(student.workspaceId, "Hostile");
		await openPreviewTab(page, student.workspaceId, app.port);
		await expect(appHeading(page)).toHaveText("Hostile", { timeout: 20_000 });

		await page.evaluate(() => localStorage.setItem("portikus-secret", "do-not-read"));
		const reach = await previewFrame(page).evaluate(() => {
			const results: Record<string, string> = {};
			try {
				results.dom = String(window.parent.document.title);
			} catch (error) {
				results.dom = `refused: ${(error as Error).name}`;
			}
			try {
				results.storage = String(window.parent.localStorage.getItem("portikus-secret"));
			} catch (error) {
				results.storage = `refused: ${(error as Error).name}`;
			}
			try {
				results.cookie = String(window.parent.document.cookie);
			} catch (error) {
				results.cookie = `refused: ${(error as Error).name}`;
			}
			return results;
		});
		expect(reach.dom).toContain("refused");
		expect(reach.storage).toContain("refused");
		expect(reach.cookie).toContain("refused");
		// Its own storage is its own, and holds nothing of Portikus.
		const own = await previewFrame(page).evaluate(() =>
			localStorage.getItem("portikus-secret"),
		);
		expect(own).toBeNull();
		await app.close();
	});

	test("a cookie and stored state survive a reload of the tab", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await previewGateway(context);
		const app = await startPreview(student.workspaceId, "Stateful");
		await openPreviewTab(page, student.workspaceId, app.port);
		const frame = page.frameLocator("[data-testid=preview-frame]");
		await expect(frame.locator("#state")).toHaveText("note:none", { timeout: 20_000 });

		await page.getByTestId("preview-reload").click();
		await expect(frame.locator("#state")).toHaveText("note:kept", { timeout: 20_000 });
		await app.close();
	});

	/**
	 * Skipped for the environment, not for the product: a cookie the
	 * application sets inside the frame needs a same-site deployment
	 * (BROWSER-HANDLING.md §7.1). Portikus here is on 127.0.0.1, which has no
	 * subdomains, so Chromium treats the frame as cross-site and refuses the
	 * write outright. Run this against a deployment with a real preview
	 * suffix, such as the pilot VM.
	 */
	test.skip("an application cookie survives a reload of the tab", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await previewGateway(context);
		const app = await startPreview(student.workspaceId, "Cookies");
		await openPreviewTab(page, student.workspaceId, app.port);
		const frame = page.frameLocator("[data-testid=preview-frame]");
		await expect(frame.locator("#cookie")).toHaveText("cookie:app-cookie=chocolate", {
			timeout: 20_000,
		});

		await page.getByTestId("preview-reload").click();
		await expect(frame.locator("#cookie")).toHaveText("cookie:app-cookie=chocolate", {
			timeout: 20_000,
		});
		await app.close();
	});

	test("a form posted inside the frame reaches the application", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const seen = await previewGateway(context);
		const app = await startPreview(student.workspaceId, "Forms");
		await openPreviewTab(page, student.workspaceId, app.port);
		await expect(appHeading(page)).toHaveText("Forms", { timeout: 20_000 });

		await page.frameLocator("[data-testid=preview-frame]").locator("#send").click();
		await expect(appHeading(page)).toHaveText("form received hello", {
			timeout: 20_000,
		});
		expect(seen.app).toContain("POST /form");
		await app.close();
	});

	test("the sandbox lets the application open a window on its own origin", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await previewGateway(context);
		const app = await startPreview(student.workspaceId, "Popups");
		await openPreviewTab(page, student.workspaceId, app.port);
		await expect(appHeading(page)).toHaveText("Popups", { timeout: 20_000 });

		const [popup] = await Promise.all([
			page.waitForEvent("popup"),
			page.frameLocator("[data-testid=preview-frame]").locator("#popup").click(),
		]);
		await popup.waitForLoadState();
		const url = new URL(popup.url());
		expect(url.hostname.endsWith(PREVIEW_SUFFIX)).toBe(true);
		expect(url.origin).not.toBe("http://127.0.0.1:5173");
		await expect(popup.locator("#title")).toHaveText("opened window");
		await app.close();
	});

	/**
	 * An application that refuses framing must be offered in a new tab, and
	 * quickly: Chromium fires the frame's load event for the refused
	 * navigation, so without the control plane's probe the tab would sit blank
	 * (BROWSER-HANDLING.md §12).
	 */
	test("an application that refuses framing is offered in a new tab", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await previewGateway(context);
		const app = await startPreview(student.workspaceId, "Refuses", "DENY");
		await openPreviewTab(page, student.workspaceId, app.port);

		// Well inside the eight-second load timeout, so the probe is what
		// reached this state and not the fallback.
		await expect(page.getByTestId("preview-blocked")).toBeVisible({
			timeout: 5_000,
		});
		await expect(page.getByTestId("preview-blocked-new-tab")).toBeVisible();

		// The tab is opened with noopener, so it arrives as a new page in the
		// context rather than as an opener's popup.
		await page.getByTestId("preview-blocked-new-tab").click();
		let opened: Page | undefined;
		await expect
			.poll(
				() => {
					opened = context.pages().find((one) => {
						try {
							return new URL(one.url()).hostname.endsWith(PREVIEW_SUFFIX);
						} catch {
							return false;
						}
					});
					return opened !== undefined;
				},
				{ timeout: 20_000 },
			)
			.toBe(true);
		if (!opened) throw new Error("no tab opened on the preview origin");
		await expect(opened.locator("#title")).toHaveText("Refuses", { timeout: 20_000 });
		await opened.close();

		// The notice stays: the load event the refused navigation fired must
		// not clear a verdict the control plane got from the application.
		await expect(page.getByTestId("preview-blocked")).toBeVisible();
		await app.close();
	});

	/**
	 * What this file can and cannot see of a reset.
	 *
	 * Chromium applies `Clear-Site-Data` to answers that come off the network,
	 * but not to answers Playwright's request interception supplies. The
	 * gateway here is interception, so the cleared cookies, storage and worker
	 * registrations cannot be observed in this environment. What is observed
	 * instead is everything Portikus is responsible for: that the reset
	 * request leaves the Portikus page and reaches the edge rather than being
	 * answered inside the frame, and that the edge answers it with the header
	 * that does the clearing. That the API sends that header is pinned in
	 * apps/api/src/routes/preview.test.ts.
	 */
	test("a service worker cannot answer the reset", async ({ page, context }) => {
		const student = await createStudent(context);
		const seen = await previewGateway(context);
		const app = await startPreview(student.workspaceId, "Workers");
		await openPreviewTab(page, student.workspaceId, app.port);
		await expect(appHeading(page)).toHaveText("Workers", { timeout: 20_000 });

		// This worker answers every request it is asked about, so if the reset
		// went through the frame the worker would answer it instead of the edge.
		const frame = page.frameLocator("[data-testid=preview-frame]");
		await frame.locator("#register").click();
		await expect(frame.locator("#worker")).toHaveText("worker ready", {
			timeout: 20_000,
		});

		const host = new URL(await previewOrigin(page)).host;
		const before = seen.session(host);
		expect(before).toBeTruthy();

		// Reset is driven from the Portikus page, which the worker does not
		// control, so the reset request goes to the network and the edge answers
		// it (BROWSER-HANDLING.md §12, §16.4).
		await page.getByTestId("preview-reset").click();
		await expect(toast(page, "Preview data reset")).toBeVisible();
		await expect.poll(() => seen.session(host), { timeout: 20_000 }).not.toBe(before);

		// The reset request reached the edge. If Portikus had navigated the
		// frame instead, this worker would have answered it and the gateway
		// would never have been asked. The answer carries the header that
		// clears the origin's storage and worker registrations, and a
		// Set-Cookie expiring every cookie the request carried.
		const reset = seen.reserved.filter((one) => one.path === "/__portikus/reset");
		expect(reset).toHaveLength(1);
		expect(reset[0]?.clearSiteData).toBe('"storage"');
		await app.close();
	});

	test("resetting preview data starts a fresh session and clears the origin", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const seen = await previewGateway(context);
		const app = await startPreview(student.workspaceId, "Reset");
		await openPreviewTab(page, student.workspaceId, app.port);
		const state = page.frameLocator("[data-testid=preview-frame]").locator("#state");
		await expect(state).toHaveText("note:none", { timeout: 20_000 });

		const host = new URL(await previewOrigin(page)).host;
		const before = seen.session(host);
		expect(before).toBeTruthy();

		await page.getByTestId("preview-reset").click();
		await expect(toast(page, "Preview data reset")).toBeVisible();
		await expect(appHeading(page)).toHaveText("Reset", { timeout: 20_000 });

		// A reset is a new preview session, not the old one carried over.
		await expect.poll(() => seen.session(host), { timeout: 20_000 }).not.toBe(before);
		// And the edge was asked to clear the origin's stored state
		// (BROWSER-HANDLING.md §16.4, §25.1). See the note above the
		// service-worker test for why the clearing itself is not visible here.
		const reset = seen.reserved.filter((one) => one.path === "/__portikus/reset");
		expect(reset).toHaveLength(1);
		expect(reset[0]?.clearSiteData).toBe('"storage"');
		await app.close();
	});

	test("a stopped application answers with the Portikus explanation", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await previewGateway(context);
		const app = await startPreview(student.workspaceId, "Going away");
		await openPreviewTab(page, student.workspaceId, app.port);
		await expect(appHeading(page)).toHaveText("Going away", { timeout: 20_000 });

		const origin = await previewOrigin(page);
		await app.stop();

		// The preview host itself explains, rather than showing a proxy error.
		await expect
			.poll(
				async () => {
					await page.goto(`${origin}/`);
					return (await page.locator("body").textContent()) ?? "";
				},
				{ timeout: 20_000 },
			)
			.toContain(`Nothing is currently listening on port ${app.port}`);
	});

	test("a stopped workspace answers with the Portikus explanation", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await previewGateway(context);
		const app = await startPreview(student.workspaceId, "Stopping");
		await openPreviewTab(page, student.workspaceId, app.port);
		await expect(appHeading(page)).toHaveText("Stopping", { timeout: 20_000 });

		const origin = await previewOrigin(page);
		await setWorkspaceState(student.workspaceId, "stopped");
		await expect
			.poll(
				async () => {
					await page.goto(`${origin}/`);
					return (await page.locator("body").textContent()) ?? "";
				},
				{ timeout: 20_000 },
			)
			.toContain("This workspace is not running");
		await app.close();
	});

	test("Open in new tab from a Running row opens exactly one tab", async ({
		page,
		context,
	}) => {
		// The Running row uses the same single-tab pattern as the Preview tab
		// (issues #261, #272), so one click must leave exactly one new page.
		const student = await createStudent(context);
		await previewGateway(context);
		const app = await startPreview(student.workspaceId, "Row tab");
		const project = await createProject(student.workspaceId, { name: "row-new-tab" });
		await page.goto(workspacePath(student.workspaceId, project.id));
		await page.getByTestId("right-pane-tab-running").click();
		await expect(page.getByTestId(`running-row-${app.port}`)).toBeVisible({
			timeout: 20_000,
		});

		const before = context.pages();
		await page.getByTestId(`running-new-tab-${app.port}`).click();
		let opened: Page | undefined;
		await expect
			.poll(
				() => {
					opened = context.pages().find((one) => {
						try {
							return new URL(one.url()).hostname.endsWith(PREVIEW_SUFFIX);
						} catch {
							return false;
						}
					});
					return opened !== undefined;
				},
				{ timeout: 20_000 },
			)
			.toBe(true);
		if (!opened) throw new Error("no tab opened on the preview origin");
		await expect(opened.locator("#title")).toHaveText("Row tab", { timeout: 20_000 });
		expect(context.pages().filter((one) => !before.includes(one))).toHaveLength(1);
		await app.close();
	});

	test("Open in new tab lands on the preview origin, not the Portikus one", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await previewGateway(context);
		const app = await startPreview(student.workspaceId, "Top level");
		await openPreviewTab(page, student.workspaceId, app.port);
		await expect(appHeading(page)).toHaveText("Top level", { timeout: 20_000 });

		// One click must produce exactly one new page. The blank placeholder the
		// click opens is the page that navigates to the preview origin; a second
		// window.open would leave the student with an extra about:blank tab.
		const before = context.pages();
		await page.getByTestId("preview-new-tab").click();
		let tab: Page | undefined;
		await expect
			.poll(
				() => {
					tab = context.pages().find((one) => {
						try {
							return new URL(one.url()).hostname.endsWith(PREVIEW_SUFFIX);
						} catch {
							return false;
						}
					});
					return tab !== undefined;
				},
				{ timeout: 20_000 },
			)
			.toBe(true);
		if (!tab) throw new Error("no tab opened on the preview origin");
		await expect(tab.locator("#title")).toHaveText("Top level", { timeout: 20_000 });
		const added = context.pages().filter((one) => !before.includes(one));
		expect(added).toHaveLength(1);
		await app.close();
	});

	test("the preview stops working when the Portikus session ends", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await previewGateway(context);
		const app = await startPreview(student.workspaceId, "Signed in");
		await openPreviewTab(page, student.workspaceId, app.port);
		await expect(appHeading(page)).toHaveText("Signed in", { timeout: 20_000 });

		const origin = await previewOrigin(page);
		// The same thing a logout does to the session row.
		await deleteSessions(student.userId);

		await page.goto(`${origin}/`);
		await expect(page.locator("h1")).toHaveText("Preview session ended");
		await app.close();
	});

	/**
	 * A development server that refuses the preview host is explained, with
	 * the exact line to paste (issue #262).
	 */
	test("a dev server refusing the preview host is explained", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await previewGateway(context);
		const app = await startPreview(student.workspaceId, "Blocked", undefined, true);
		await openPreviewTab(page, student.workspaceId, app.port, "preview-refused");

		// The real suffix of this deployment, with the workspace label gone.
		await expect(page.getByTestId("preview-refused-line")).toHaveText(
			`server: { allowedHosts: ["${PREVIEW_SUFFIX}"] }`,
		);
		const host = (await page.getByTestId("preview-host").textContent()) ?? "";
		await expect(page.getByTestId("preview-refused")).toContainText(
			host.split(":")[0] ?? "",
		);
		// Not the "cannot be embedded" notice: this application can be framed.
		await expect(page.getByTestId("preview-blocked")).toHaveCount(0);
		await expect(page.getByTestId("preview-refused-copy")).toBeVisible();
		await expect(page.getByTestId("preview-retry")).toBeVisible();
		await app.close();
	});

	/**
	 * Back and Forward step the joint history, including across a `pushState`
	 * route change, and never move the Portikus page (issue #271).
	 */
	test("Back and Forward step the preview's history", async ({ page, context }) => {
		const student = await createStudent(context);
		await previewGateway(context);
		const app = await startPreview(student.workspaceId, "History");
		await openPreviewTab(page, student.workspaceId, app.port);
		await expect(appHeading(page)).toHaveText("History", { timeout: 20_000 });
		const portikusUrl = page.url();

		const frame = () => page.frameLocator("[data-testid=preview-frame]");
		// Two navigations forward first, so stepping back stays on pages the
		// application served. The entry the frame started on is the bootstrap
		// URL, whose ticket is single-use; in a real deployment the browser
		// sees the bootstrap redirect and keeps "/" instead, but this file
		// stands in for Caddy and follows that redirect itself.
		await frame().locator("#link").click();
		await expect(appHeading(page)).toHaveText("second page");
		await frame().locator("#home").click();
		await expect(appHeading(page)).toHaveText("History");

		await page.getByTestId("preview-back").click();
		await expect(appHeading(page)).toHaveText("second page");
		expect(page.url()).toBe(portikusUrl);

		await page.getByTestId("preview-forward").click();
		await expect(appHeading(page)).toHaveText("History");

		// A single-page route change is an entry too.
		await frame().locator("#push").click();
		await expect(appHeading(page)).toHaveText("pushed route");
		await page.getByTestId("preview-back").click();
		await expect(appHeading(page)).toHaveText("History");

		// Whatever the history did, the Portikus page stayed where it was.
		expect(page.url()).toBe(portikusUrl);
		await expect(page.getByTestId("work-tabs")).toBeVisible();
		await app.close();
	});

	/**
	 * The states are a compact stack in the middle of the pane, not a column
	 * stretched from top to bottom (issue #275).
	 */
	test("an inactive preview is one compact stack in the middle", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await previewGateway(context);
		const app = await startPreview(student.workspaceId, "Layout");
		await openPreviewTab(page, student.workspaceId, app.port);
		await app.stop();

		const retry = page.getByTestId("preview-retry");
		await expect(retry).toBeVisible({ timeout: 20_000 });
		const button = await retry.boundingBox();
		const pane = await page.getByTestId(`preview-pane-${app.port}`).boundingBox();
		const heading = await page
			.getByTestId("preview-inactive")
			.locator("xpath=../..")
			.locator("h3")
			.boundingBox();
		if (!button || !pane || !heading) throw new Error("the preview pane has no box");

		// A stretched button fills the pane; a normal one is a line high.
		expect(button.height).toBeLessThan(40);
		const middle = heading.y + heading.height / 2;
		expect(middle).toBeGreaterThan(pane.y + pane.height / 3);
		expect(middle).toBeLessThan(pane.y + (pane.height * 2) / 3);
	});
});
