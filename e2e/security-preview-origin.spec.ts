import { expect, type Frame, type Page, test } from "@playwright/test";
import {
	API_ORIGIN,
	createProject,
	createStudent,
	query,
	startPreviewApp,
	WEB_ORIGIN,
	workspacePath,
} from "./helpers";

/**
 * Preview code running in student A's own browser gets none of the control
 * plane's authority (Epic 12a, Done item 10; SPEC.md §24; BROWSER-HANDLING.md
 * §7, §12, §25.1). From inside the preview frame it cannot read `/auth/me`,
 * cannot change anything through the API, and cannot see the session cookie,
 * which is HttpOnly and host-only.
 *
 * Two hops are stood in for. Caddy, as in preview.spec.ts: a small gateway
 * on the page answers the preview host from the real API. And the cookie jar
 * of a same-site deployment: Portikus here runs on 127.0.0.1, which cannot
 * share a site with the preview suffix, so Chromium never attaches the
 * session cookie to the frame's requests. `sameSiteSession` attaches it, with
 * the `Sec-Fetch-Site: same-site` a deployed browser sends, so the API's own
 * checks are what must refuse the request.
 */

const PREVIEW_SUFFIX = ".preview.localhost";

/** Stand in for Caddy for the browser's requests to preview hosts. */
async function previewGateway(page: Page): Promise<void> {
	async function proxy(host: string, path: string, cookie: string) {
		const authorized = await fetch(`${API_ORIGIN}/preview/authorize`, {
			headers: { "x-forwarded-host": host, "x-forwarded-proto": "https", cookie },
			redirect: "manual",
		});
		if (!authorized.ok) return authorized;
		const upstream = authorized.headers.get("x-portikus-upstream");
		if (!upstream) throw new Error("the authorization answer named no upstream");
		return fetch(`http://${upstream}${path}`, {
			headers: { host },
			redirect: "manual",
		});
	}

	await page.route(
		(url) => url.hostname.endsWith(PREVIEW_SUFFIX),
		async (route) => {
			const url = new URL(route.request().url());
			const cookie = (await route.request().headerValue("cookie")) ?? "";
			const path = `${url.pathname}${url.search}`;
			let answer: Response;
			if (url.pathname.startsWith("/__portikus/")) {
				answer = await fetch(`${API_ORIGIN}${path}`, {
					headers: {
						"x-forwarded-host": url.host,
						"x-forwarded-proto": "https",
						cookie,
					},
					redirect: "manual",
				});
				const location = answer.headers.get("location");
				if (answer.status === 303 && location !== null) {
					const minted = answer.headers
						.getSetCookie()
						.map((line) => line.split(";")[0] ?? "")
						.join("; ");
					answer = await proxy(url.host, location, [cookie, minted].join("; "));
				}
			} else {
				answer = await proxy(url.host, path, cookie);
			}
			return route.fulfill({
				status: answer.status,
				headers: {
					"content-type": answer.headers.get("content-type") ?? "text/plain",
				},
				body: Buffer.from(await answer.arrayBuffer()),
			});
		},
	);
}

/**
 * Give every request the preview frame sends to Portikus the student's
 * session cookie, and record what the API answered.
 */
async function sameSiteSession(
	page: Page,
	sessionToken: string,
): Promise<{ url: string; method: string; status: number; html: boolean }[]> {
	const answered: { url: string; method: string; status: number; html: boolean }[] = [];
	await page.route(`${WEB_ORIGIN}/**`, async (route) => {
		const request = route.request();
		const origin = await request.headerValue("origin");
		// Portikus's own page sends its own origin or none; anything else came
		// from the preview frame (a form post from it says "null").
		if (origin === null || origin === WEB_ORIGIN) return route.fallback();
		const response = await route.fetch({
			headers: {
				...request.headers(),
				cookie: `portikus_session=${sessionToken}`,
				"sec-fetch-site": "same-site",
			},
		});
		answered.push({
			url: request.url(),
			method: request.method(),
			status: response.status(),
			html: (response.headers()["content-type"] ?? "").startsWith("text/html"),
		});
		return route.fulfill({ response });
	});
	return answered;
}

/** The frame's own document, where scripts run as preview code. */
function previewFrame(page: Page): Frame {
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

/** Sign A in, open a preview of A's own application, and return the frame. */
async function openOwnPreview(page: Page) {
	const context = page.context();
	const student = await createStudent(context);
	await previewGateway(page);
	const port = await startPreviewApp(student.workspaceId, "Hostile preview");
	const project = await createProject(student.workspaceId, { name: "hostile" });
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(page.getByTestId("work-tabs")).toBeVisible({ timeout: 15_000 });
	await page.getByTestId("right-pane-tab-running").click();
	await page.getByTestId(`running-open-${port}`).click({ timeout: 20_000 });
	await expect(
		page.frameLocator("[data-testid=preview-frame]").locator("h1"),
	).toHaveText("Hostile preview", { timeout: 20_000 });
	// Routed only now: sending every module of the page load through the
	// route slows that load past its timeout when the whole suite runs.
	const answered = await sameSiteSession(page, student.sessionToken);
	return { student, project, answered, frame: previewFrame(page) };
}

test.describe("preview code in the student's own browser", () => {
	test("cannot read /auth/me", async ({ page }) => {
		const { frame, answered } = await openOwnPreview(page);
		for (const origin of [WEB_ORIGIN, API_ORIGIN]) {
			const result = await frame.evaluate(async (target) => {
				try {
					const response = await fetch(`${target}/auth/me`, { credentials: "include" });
					return `read ${response.status}: ${await response.text()}`;
				} catch (error) {
					return `refused: ${(error as Error).name}`;
				}
			}, origin);
			expect(result, origin).toMatch(/^refused/);
		}
		// The request really went, with the session, and was only unreadable.
		expect(answered.some((one) => one.url.endsWith("/auth/me"))).toBe(true);
	});

	test("cannot make a state-changing request", async ({ page }) => {
		const { student, project, answered, frame } = await openOwnPreview(page);
		const id = student.workspaceId;
		const targets = [
			`${WEB_ORIGIN}/workspaces/${id}/stop`,
			`${WEB_ORIGIN}/workspaces/${id}/projects/${project.id}/mkdir`,
			`${WEB_ORIGIN}/auth/logout`,
		];

		await frame.evaluate(async (urls) => {
			for (const url of urls) {
				// A simple request needs no preflight, so it is really sent.
				await fetch(url, {
					method: "POST",
					mode: "no-cors",
					credentials: "include",
				}).catch(() => undefined);
				// A JSON request needs a preflight the API must not approve.
				await fetch(url, {
					method: "POST",
					credentials: "include",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ path: "planted" }),
				}).catch(() => undefined);
			}
		}, targets);

		// A form post, the other way a page sends a cross-origin write.
		await frame.evaluate((url) => {
			const form = document.createElement("form");
			form.method = "POST";
			form.action = url;
			form.target = "sink";
			const sink = document.createElement("iframe");
			sink.name = "sink";
			document.body.append(sink, form);
			form.submit();
		}, `${WEB_ORIGIN}/workspaces/${id}/stop`);
		await page.waitForTimeout(1_500);

		// Every write reached the API carrying the session, and was refused.
		const posts = answered.filter((one) => one.method === "POST");
		for (const target of targets) {
			expect(
				posts.some((one) => one.url === target),
				target,
			).toBe(true);
		}
		for (const post of posts) {
			// A form post is a document request, so the edge serves the page
			// bundle instead of passing it to the API (Caddyfile `@app_page`).
			if (post.html) continue;
			expect(post.status, post.url).toBe(403);
		}
		const [workspace] = await query<{ desired_state: string }>(
			"select desired_state from workspaces where id = $1",
			[id],
		);
		expect(workspace?.desired_state).toBe("running");
		const sessions = await query("select id from sessions where user_id = $1", [
			student.userId,
		]);
		expect(sessions).toHaveLength(1);
		expect((await page.request.get("/auth/me")).status()).toBe(200);
	});

	test("cannot see the session cookie", async ({ request }) => {
		// Script in any frame can read a cookie only when it lacks HttpOnly, and
		// a Domain attribute would send it to preview hosts too. So the check is
		// on the Set-Cookie header of a real sign-in.
		const authorize = await request.get("/auth/login");
		expect(authorize.url()).toContain("/authorize");
		const chosen = await request.get(`${authorize.url()}&user=alice`, {
			maxRedirects: 0,
		});
		const callback = chosen.headers().location;
		expect(callback).toContain("/auth/callback");
		const signedIn = await request.get(callback ?? "", { maxRedirects: 0 });
		const session = signedIn
			.headersArray()
			.filter((header) => header.name.toLowerCase() === "set-cookie")
			.map((header) => header.value)
			.find((value) => /^(__Host-)?portikus_session=/.test(value));
		expect(session).toBeDefined();
		expect(session).toMatch(/;\s*HttpOnly/i);
		expect(session).not.toMatch(/;\s*Domain=/i);
		expect(session).toMatch(/;\s*SameSite=Lax/i);
	});
});
