import { expect, type Page, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	openToggletip,
	query,
	seedListening,
	settledAxe,
	startPreviewApp,
	toast,
	WCAG_TAGS,
	workspacePath,
} from "./helpers";
import { previewGateway } from "./preview-gateway";

/**
 * The Preview tab, the Running surface and the preview route a terminal link
 * lands on (SPEC.md §14.6, §14.8, §18.2, BROWSER-HANDLING.md §12, §15).
 *
 * These tests drive the real control plane: ports are seeded through the fake
 * workspace agent, so the API's listening registry pushes them to the browser
 * over the workspace WebSocket, and grants come from the real
 * `POST /workspaces/:id/preview-grants`. The one stubbed hop is Caddy, which
 * does not exist in the development environment (e2e/preview-gateway.ts).
 *
 * Nothing about the grant, the ticket, the preview session, the port policy
 * or the upstream lookup is faked: all of that is the API under test.
 */

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
		// service and hide the student's server.
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
		await expect(page.getByTestId("running-reason-5355")).toHaveText("System service");
		await expect(page.getByTestId("running-stop-5355")).toHaveCount(0);

		// The choice is remembered per browser.
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
		// The state says what to do instead and offers no retry.
		await expect(
			page.getByRole("heading", { name: "Port 80 cannot be previewed" }),
		).toBeVisible({ timeout: 20_000 });
		await expect(page.getByTestId("preview-port-refused")).toHaveText(
			"Ports below 1024, and a few kept for services such as SSH, Docker and PostgreSQL, cannot be opened as a preview. Run your app on a port from 1024 up, such as 3000 or 5173.",
		);
		await expect(page.getByTestId("preview-retry")).toHaveCount(0);
		await expect(page.getByTestId("preview-frame")).toHaveCount(0);

		// Choosing another port replaces the refused tab with the new one.
		await page.getByRole("button", { name: "Choose another port…" }).click();
		await page.getByLabel("Port").fill("3000");
		await page.getByTestId("preview-open-port").click();
		await expect(page.getByTestId("tab-preview:3000")).toBeVisible();
		await expect(page.getByTestId("tab-preview:80")).toHaveCount(0);
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
		await expect(
			page.getByRole("heading", { name: "Port 5432 cannot be previewed" }),
		).toBeVisible({ timeout: 20_000 });
		await expect(page.getByTestId("preview-choose-port")).toBeVisible();
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

		const resets: string[] = [];
		page.on("request", (request) => {
			if (request.url().endsWith("/preview/reset")) resets.push(request.url());
		});

		// Cancel leaves the data alone: nothing is revoked or cleared.
		await page.getByTestId("preview-more").click();
		await page.getByTestId("preview-reset").click();
		const dialog = page.getByTestId("dialog-preview-reset");
		await expect(dialog).toBeVisible();
		const results = await (await settledAxe(page))
			.withTags(WCAG_TAGS)
			.include('[data-testid="dialog-preview-reset"]')
			.analyze();
		expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
		await dialog.getByRole("button", { name: "Cancel" }).click();
		await expect(dialog).toBeHidden();
		await expect(page.getByTestId("preview-more")).toBeFocused();
		await expect(appHeading(page)).toHaveText("Reset me");
		expect(resets).toEqual([]);

		await page.getByTestId("preview-more").click();
		await page.getByTestId("preview-reset").click();
		await page.getByTestId("dialog-confirm").click();
		await expect(page.getByTestId("preview-more")).toBeFocused();
		await expect(toast(page, "Preview data reset")).toBeVisible();
		expect(resets).toHaveLength(1);
		// A fresh grant and a fresh preview session put the application back.
		await expect(appHeading(page)).toHaveText("Reset me", { timeout: 20_000 });
	});

	for (const colorScheme of ["light", "dark"] as const) {
		test(`the toolbar's Back and Forward are named icons, and the address has a toggletip (${colorScheme})`, async ({
			page,
			context,
		}) => {
			await page.emulateMedia({ colorScheme });
			const student = await createStudent(context);
			await previewGateway(page);
			const port = await startPreviewApp(student.workspaceId, "Tip");
			const project = await createProject(student.workspaceId, { name: "tip" });
			await savePreviewTab(project.id, port);
			await page.goto(workspacePath(student.workspaceId, project.id));
			await expect(appHeading(page)).toHaveText("Tip", { timeout: 20_000 });

			// Icons with names, not words.
			await expect(page.getByTestId("preview-back")).toHaveAccessibleName("Back");
			await expect(page.getByTestId("preview-back")).toHaveText("");
			await expect(page.getByTestId("preview-forward")).toHaveAccessibleName("Forward");

			const tip = page.getByRole("button", { name: "About the preview address" });
			await tip.focus();
			await page.keyboard.press("Enter");
			await expect(openToggletip(page)).toHaveText(
				"Your preview's own address. Only you can open it, after signing in to Portikus. It does not work for anyone else.",
			);
			for (const selector of [".pk-preview-bar", ".pk-toggletip-content"]) {
				const results = await (await settledAxe(page))
					.withTags(WCAG_TAGS)
					.include(selector)
					.analyze();
				expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
			}
			await page.keyboard.press("Escape");
			await expect(tip).toBeFocused();
		});
	}

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
		await expect(menu.getByRole("menuitemradio", { name: "Fit width" })).toBeChecked();
		await expect(
			menu.getByRole("menuitem", { name: "Reset preview data…" }),
		).toBeVisible();
		await expect(menu.getByRole("menuitem", { name: "Show in Running" })).toBeVisible();
		// The width choices are radio items; scan them open in both themes.
		for (const colorScheme of ["light", "dark"] as const) {
			await page.emulateMedia({ colorScheme });
			const results = await (await settledAxe(page))
				.withTags(WCAG_TAGS)
				.include('[role="menu"]')
				.analyze();
			expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
		}
		await menu.getByRole("menuitemradio", { name: "768 px wide" }).click();
		await expect(page.getByTestId("preview-frame")).toHaveCSS("max-width", "768px");
	});
});
