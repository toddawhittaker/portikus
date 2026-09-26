import { expect, type Page, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	query,
	seedListening,
	startPreviewApp,
	toast,
	workspacePath,
} from "./helpers";
import { API_ORIGIN } from "./ports";

/**
 * The Preview tab, the Running surface and the preview route a terminal link
 * lands on (SPEC.md §14.6, §14.8, §18.2, BROWSER-HANDLING.md §12, §15).
 *
 * These tests drive the real control plane: ports are seeded through the fake
 * workspace agent, so the API's listening registry pushes them to the browser
 * over the workspace WebSocket, and grants come from the real
 * `POST /workspaces/:id/preview-grants`.
 *
 * One hop is stubbed, and only because it does not exist in the development
 * environment: Caddy. A preview host such as
 * `ws-1234abcd-5173.preview.localhost:5173` has no DNS entry and no TLS
 * certificate here, so `previewGateway` intercepts the browser's requests to
 * that host and does what Caddy would do (ADR 0018, BROWSER-HANDLING.md §10):
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
 *
 * Nothing about the grant, the ticket, the preview session, the port policy
 * or the upstream lookup is faked: all of that is the API under test.
 */

/** Where the API listens in the end-to-end environment. */

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

function headersOf(response: Response): Record<string, string> {
	const headers: Record<string, string> = {};
	for (const name of PASSED_HEADERS) {
		const value = response.headers.get(name);
		if (value !== null) headers[name] = value;
	}
	return headers;
}

/** The `name=value` part of each Set-Cookie line, for the next hop. */
function cookiePairs(response: Response): string {
	return response.headers
		.getSetCookie()
		.map((line) => line.split(";")[0] ?? "")
		.filter(Boolean)
		.join("; ");
}

/**
 * Stand in for Caddy for the browser's requests to preview hosts. Returns a
 * count of the requests that reached the student application, which is how a
 * test says the application itself was really fetched.
 */
async function previewGateway(page: Page): Promise<{ app: number }> {
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
				headers: headersOf(authorized),
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
			headers: headersOf(proxied),
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
				const headers = headersOf(answer);
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

async function openProject(page: Page, workspaceId: string, name = "todo-api") {
	const project = await createProject(workspaceId, { name });
	await page.goto(workspacePath(workspaceId, project.id));
	await expect(page.getByTestId("work-tabs")).toBeVisible({ timeout: 15_000 });
	return project;
}

/** Give a project a saved layout with one preview tab already open. */
async function savePreviewTab(projectId: string, port: number): Promise<void> {
	await query("update projects set layout = $2 where id = $1", [
		projectId,
		JSON.stringify({
			tabs: [{ id: `preview:${port}`, root: { type: "preview", port } }],
		}),
	]);
}

/** The heading of the application the fake agent runs for a preview test. */
function appHeading(page: Page) {
	return page.frameLocator("[data-testid=preview-frame]").locator("h1");
}

test.describe("application preview", () => {
	test("the Running surface lists a listening port and opens its preview", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const counts = await previewGateway(page);
		const port = await startPreviewApp(student.workspaceId, "Todo API");
		await openProject(page, student.workspaceId);

		await page.getByTestId("right-pane-tab-running").click();
		await expect(page.getByTestId(`running-row-${port}`)).toBeVisible({
			timeout: 20_000,
		});

		await page.getByTestId(`running-open-${port}`).click();
		await expect(page.getByTestId("preview-host")).toContainText(
			`-${port}.preview.localhost`,
			{ timeout: 20_000 },
		);
		// The frame shows the application the fake agent is really running,
		// fetched through the authorization subrequest.
		await expect(appHeading(page)).toHaveText("Todo API", { timeout: 20_000 });
		expect(counts.app).toBeGreaterThan(0);
	});

	test("a previewed loopback port stays in the Running pane", async ({
		page,
		context,
	}) => {
		// The agent's own forward must not make the port look like a system
		// service and hide the student's server (issue #299).
		const student = await createStudent(context);
		await seedListening(student.workspaceId, [
			{
				port: 4173,
				addresses: ["127.0.0.1"],
				previewReachability: "unknown",
				process: { pid: 4242, command: "node" },
			},
		]);
		await openProject(page, student.workspaceId);
		await page.getByTestId("right-pane-tab-running").click();
		await page.getByTestId("running-open-4173").click({ timeout: 20_000 });
		await expect(page.getByTestId("preview-host")).toContainText(
			"-4173.preview.localhost",
			{ timeout: 20_000 },
		);

		await page.getByTestId("right-pane-tab-running").click();
		await expect(page.getByTestId("running-row-4173")).toBeVisible();
		await expect(page.getByTestId("running-open-4173")).toBeVisible();
		await expect(page.getByTestId("running-stop-4173")).toBeVisible();
	});

	test("a system listener is hidden until the toggle is on", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await seedListening(student.workspaceId, [
			{ port: 5173, process: { pid: 4242, command: "node" } },
			{ port: 5355, system: true, process: { pid: 7, command: "systemd-resolve" } },
		]);
		await openProject(page, student.workspaceId);
		await page.getByTestId("right-pane-tab-running").click();
		await expect(page.getByTestId("running-row-5173")).toBeVisible({ timeout: 20_000 });
		await expect(page.getByTestId("running-row-5355")).toHaveCount(0);

		await page.getByTestId("running-system-toggle").locator("input").check();
		await expect(page.getByTestId("running-row-5355")).toBeVisible();
		await expect(page.getByTestId("running-reason-5355")).toHaveText("system service");
		await expect(page.getByTestId("running-stop-5355")).toHaveCount(0);

		// The choice is remembered per browser (issue #265).
		await page.reload();
		await page.getByTestId("right-pane-tab-running").click();
		await expect(page.getByTestId("running-row-5355")).toBeVisible({ timeout: 20_000 });
	});

	test("Stop ends a listener and its preview tab goes inactive", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await previewGateway(page);
		const port = await startPreviewApp(student.workspaceId, "Stoppable");
		await openProject(page, student.workspaceId);
		await page.getByTestId("right-pane-tab-running").click();
		await page.getByTestId(`running-open-${port}`).click({ timeout: 20_000 });
		await expect(appHeading(page)).toHaveText("Stoppable", { timeout: 20_000 });

		await page.getByTestId("right-pane-tab-running").click();
		await page.getByTestId(`running-stop-${port}`).click();
		await expect(page.getByTestId("dialog-stop-listener")).toContainText(
			`Stop node on port ${port}?`,
		);
		await page.getByTestId("dialog-confirm").click();

		await expect(page.getByTestId(`running-row-${port}`)).toHaveCount(0, {
			timeout: 20_000,
		});
		await expect(page.getByTestId("preview-inactive")).toContainText(
			`Nothing is currently listening on port ${port}`,
			{ timeout: 20_000 },
		);
	});

	test("an empty workspace says nothing is running yet", async ({ page, context }) => {
		const student = await createStudent(context);
		await seedListening(student.workspaceId, []);
		await openProject(page, student.workspaceId);
		await page.getByTestId("right-pane-tab-running").click();
		await expect(page.getByText("Nothing is running yet")).toBeVisible({
			timeout: 20_000,
		});
	});

	test("the + Preview launcher opens a port the student names", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await previewGateway(page);
		const port = await startPreviewApp(student.workspaceId);
		await openProject(page, student.workspaceId);

		await page.getByTestId("launcher").click();
		await page.getByTestId("launcher-preview").click();
		await page.getByLabel("Port").fill(String(port));
		await page.getByTestId("preview-open-port").click();
		await expect(page.getByTestId(`tab-preview:${port}`)).toBeVisible();
		await expect(appHeading(page)).toHaveText("Portikus test app", {
			timeout: 20_000,
		});
	});

	test("a reserved port the launcher opens is refused by the API", async ({
		page,
		context,
	}) => {
		// The port policy lives in the API (PREVIEW_PORT_MIN and friends), so
		// the launcher opens the tab and the API's own sentence explains it.
		const student = await createStudent(context);
		await seedListening(student.workspaceId, [{ port: 80 }]);
		await openProject(page, student.workspaceId);
		await page.getByTestId("launcher").click();
		await page.getByTestId("launcher-preview").click();
		await page.getByLabel("Port").fill("80");
		await page.getByTestId("preview-open-port").click();
		await expect(page.getByTestId("preview-error")).toHaveText(
			"Port 80 cannot be previewed",
			{ timeout: 20_000 },
		);
		await expect(page.getByTestId("preview-frame")).toHaveCount(0);
	});

	test("a port policy denies is listed but offers no preview", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		// 5432 is in PREVIEW_DENIED_PORTS, so the control plane marks it denied.
		await seedListening(student.workspaceId, [{ port: 5432 }]);
		await openProject(page, student.workspaceId);
		await page.getByTestId("right-pane-tab-running").click();
		await expect(page.getByTestId("running-row-5432")).toBeVisible({
			timeout: 20_000,
		});
		await expect(page.getByTestId("running-open-5432")).toHaveCount(0);
	});

	test("a saved preview reconnects when the application starts again", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await previewGateway(page);
		const port = await startPreviewApp(student.workspaceId, "Back again");
		// As far as the workspace is concerned, the application is not running.
		await seedListening(student.workspaceId, []);
		const project = await createProject(student.workspaceId, { name: "saved" });
		await savePreviewTab(project.id, port);

		await page.goto(workspacePath(student.workspaceId, project.id));
		await expect(page.getByTestId("preview-inactive")).toHaveText(
			`Nothing is currently listening on port ${port}. Start your application to reconnect this preview.`,
			{ timeout: 20_000 },
		);

		// The agent reports the port again, and the tab reconnects on its own
		// (SPEC.md §14.8).
		await seedListening(student.workspaceId, [{ port }]);
		await expect(appHeading(page)).toHaveText("Back again", { timeout: 20_000 });
	});

	test("a port that is no longer listening disappears from Running", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await seedListening(student.workspaceId, [{ port: 3000 }]);
		const project = await createProject(student.workspaceId, { name: "stale" });
		// A saved preview of a port that is not listening used to leave a
		// "not running" row. The list now shows only what is listening.
		await savePreviewTab(project.id, 5173);
		await page.goto(workspacePath(student.workspaceId, project.id));
		await page.getByTestId("right-pane-tab-running").click();
		await expect(page.getByTestId("running-row-3000")).toBeVisible({
			timeout: 20_000,
		});
		await expect(page.getByTestId("running-stale-5173")).toHaveCount(0);
		await expect(page.getByText("not running")).toHaveCount(0);
	});

	test("a preview of a port policy denies explains itself", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		// A tab saved for a port policy refuses: the agent says it is listening,
		// and the grant route turns it down (BROWSER-HANDLING.md §9.1).
		await seedListening(student.workspaceId, [{ port: 5432 }]);
		const project = await createProject(student.workspaceId, { name: "denied" });
		await savePreviewTab(project.id, 5432);
		await page.goto(workspacePath(student.workspaceId, project.id));
		await expect(page.getByTestId("preview-error")).toHaveText(
			"Port 5432 cannot be previewed",
			{ timeout: 20_000 },
		);
	});

	test("the preview route a terminal link uses opens a preview tab", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await previewGateway(page);
		const port = await startPreviewApp(student.workspaceId);
		const project = await createProject(student.workspaceId, { name: "linked" });
		// Where a click on `http://localhost:<port>` in a terminal lands
		// (SPEC.md §14.9); the parser itself is covered by unit tests.
		await page.goto(
			`${workspacePath(student.workspaceId, project.id)}/preview/${port}`,
		);
		await expect(page.getByTestId(`tab-preview:${port}`)).toBeVisible({
			timeout: 20_000,
		});
		await expect(appHeading(page)).toHaveText("Portikus test app", {
			timeout: 20_000,
		});
	});

	test("a preview tab is saved and comes back on a reload", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await previewGateway(page);
		const port = await startPreviewApp(student.workspaceId);
		const project = await openProject(page, student.workspaceId);
		await page.getByTestId("right-pane-tab-running").click();
		await page.getByTestId(`running-open-${port}`).click({ timeout: 20_000 });
		await expect(page.getByTestId("preview-frame")).toBeVisible();
		await expect
			.poll(
				async () => {
					const rows = await query<{ layout: unknown }>(
						"select layout from projects where id = $1",
						[project.id],
					);
					return JSON.stringify(rows[0]?.layout ?? null);
				},
				{ timeout: 20_000 },
			)
			.toContain(`"preview:${port}"`);

		await page.reload();
		await expect(page.getByTestId(`tab-preview:${port}`)).toBeVisible({
			timeout: 20_000,
		});
	});

	test("the frame carries the sandbox and permissions policy the design fixes", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await previewGateway(page);
		const port = await startPreviewApp(student.workspaceId);
		await openProject(page, student.workspaceId);
		await page.getByTestId("right-pane-tab-running").click();
		await page.getByTestId(`running-open-${port}`).click({ timeout: 20_000 });
		const frame = page.getByTestId("preview-frame");
		await expect(frame).toHaveAttribute(
			"sandbox",
			"allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads allow-pointer-lock",
		);
		await expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
		await expect(frame).toHaveAttribute(
			"allow",
			"clipboard-read 'none'; clipboard-write 'self'; camera 'none'; microphone 'none'; geolocation 'none'",
		);
	});

	test("a preview link is copied with the warning that sign-in is needed", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await previewGateway(page);
		const port = await startPreviewApp(student.workspaceId);
		await context.grantPermissions(["clipboard-read", "clipboard-write"]);
		await openProject(page, student.workspaceId);
		await page.getByTestId("right-pane-tab-running").click();
		await page.getByTestId(`running-open-${port}`).click({ timeout: 20_000 });
		await expect(page.getByTestId("preview-host")).toContainText(".preview.localhost", {
			timeout: 20_000,
		});
		await page.getByTestId("preview-more").click();
		await page.getByTestId("preview-copy").click();
		await expect(
			toast(page, "This link only works while you are signed in."),
		).toBeVisible();
		const copied = await page.evaluate(() => navigator.clipboard.readText());
		expect(copied).toContain(`-${port}.preview.localhost`);
	});

	test("resetting preview data revokes the session and reconnects", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await previewGateway(page);
		const port = await startPreviewApp(student.workspaceId, "Reset me");
		await openProject(page, student.workspaceId);
		await page.getByTestId("right-pane-tab-running").click();
		await page.getByTestId(`running-open-${port}`).click({ timeout: 20_000 });
		await expect(appHeading(page)).toHaveText("Reset me", { timeout: 20_000 });

		await page.getByTestId("preview-more").click();
		await page.getByTestId("preview-reset").click();
		await expect(toast(page, "Preview data reset")).toBeVisible();
		// A fresh grant and a fresh preview session put the application back.
		await expect(appHeading(page)).toHaveText("Reset me", { timeout: 20_000 });
	});

	test("a picker row opens its port, and the toolbar's extra actions sit in a menu", async ({
		page,
		context,
	}) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		const student = await createStudent(context);
		await previewGateway(page);
		const port = await startPreviewApp(student.workspaceId, "Picked");
		await openProject(page, student.workspaceId);

		await page.getByTestId("launcher").click();
		await page.getByTestId("launcher-preview").click();
		const dialog = page.getByTestId("dialog-preview-port");
		await expect(
			dialog.getByText("Pick a running port below, or type one."),
		).toBeVisible();
		const row = dialog.getByTestId(`preview-port-${port}`);
		await expect(row).toBeVisible({ timeout: 20_000 });
		// The row looks like something to click: it has a border of its own.
		expect(await row.evaluate((el) => getComputedStyle(el).borderTopStyle)).toBe(
			"solid",
		);
		await row.click();
		await expect(appHeading(page)).toHaveText("Picked", { timeout: 20_000 });

		// The bar stays on one line at 1280 px: every control shares one centre line.
		const centres = await page.locator(".pk-preview-bar > *").evaluateAll((els) =>
			els.map((el) => {
				const box = el.getBoundingClientRect();
				return Math.round(box.top + box.height / 2);
			}),
		);
		expect(Math.max(...centres) - Math.min(...centres)).toBeLessThanOrEqual(1);

		await page.getByRole("button", { name: "More preview actions" }).click();
		const menu = page.getByRole("menu", { name: "More preview actions" });
		await expect(menu.getByRole("menuitem", { name: "Copy URL" })).toBeVisible();
		await expect(menu.getByText("Width", { exact: true })).toBeVisible();
		await expect(
			menu.getByRole("menuitemcheckbox", { name: "Fit width" }),
		).toBeChecked();
		await expect(
			menu.getByRole("menuitem", { name: "Reset preview data" }),
		).toBeVisible();
		await expect(menu.getByRole("menuitem", { name: "Show in Running" })).toBeVisible();
		await menu.getByRole("menuitemcheckbox", { name: "768 px wide" }).click();
		await expect(page.getByTestId("preview-frame")).toHaveCSS("max-width", "768px");
	});
});
