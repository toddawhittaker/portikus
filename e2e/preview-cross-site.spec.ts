import { expect, type Page, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	startPreviewApp,
	workspacePath,
} from "./helpers";
import { WEB_ORIGIN } from "./ports";
import { appFrameLocator, previewGateway, siteOf } from "./preview-gateway";

/**
 * Previews on a different site from Portikus (BROWSER-HANDLING.md §7.2).
 *
 * Portikus runs on 127.0.0.1 and previews on `*.preview.localhost`. A browser
 * treats those as two sites: an IP address is a site of its own and shares
 * no registrable domain with any name. That is the layout of a deployment
 * whose preview suffix is a separate domain, such as an app host on
 * `kitestringlabs.org` with previews on `kitestringlabs.dev`.
 *
 * Unlike the other preview specs, the gateway here holds no cookies: the
 * browser stores and sends the preview cookie itself, so these tests show
 * that the partitioned cookie an embedded bootstrap sets is really kept
 * inside the Portikus page that framed it.
 */

const PREVIEW_SUFFIX = ".preview.localhost";

test("the two hosts are different sites", () => {
	expect(siteOf(new URL(WEB_ORIGIN).hostname)).not.toBe(
		siteOf(`ws-1-5173${PREVIEW_SUFFIX}`),
	);
});

async function openRunning(page: Page, workspaceId: string, port: number) {
	const project = await createProject(workspaceId, { name: "cross-site" });
	await page.goto(workspacePath(workspaceId, project.id));
	await page.getByTestId("right-pane-tab-running").click();
	await expect(page.getByTestId(`running-row-${port}`)).toBeVisible({
		timeout: 20_000,
	});
}

test("an embedded preview keeps its session across reloads", async ({
	page,
	context,
	browserName,
}) => {
	// WebKit in Playwright keeps no cookie set inside a cross-site frame,
	// partitioned or not; there the preview opens in its own tab instead.
	test.skip(
		browserName === "webkit",
		"WebKit refuses a cookie set in a cross-site frame",
	);
	const student = await createStudent(context);
	const counts = await previewGateway(context, { browserCookies: true });
	const port = await startPreviewApp(student.workspaceId, "Across sites");
	await openRunning(page, student.workspaceId, port);

	await page.getByTestId(`running-open-${port}`).click();
	const heading = appFrameLocator(page).locator("h1");
	await expect(heading).toHaveText("Across sites", { timeout: 20_000 });

	const host = new URL(
		page
			.frames()
			.find((one) => one.url().includes(PREVIEW_SUFFIX))
			?.url() ?? "",
	).host;
	const stored = (await context.cookies(`https://${host}/`)).find(
		(one) => one.name === "portikus-preview",
	);
	expect(stored?.sameSite).toBe("None");
	expect(stored?.secure).toBe(true);
	// Playwright's Chromium stores a Partitioned cookie without a partition
	// key, so that it is kept to the framing site is not checked here; real
	// Chrome and Safari partition it.

	const before = counts.app;
	await page.getByTestId("preview-reload").click();
	await expect(heading).toHaveText("Across sites", { timeout: 20_000 });
	await expect.poll(() => counts.app).toBeGreaterThan(before);
});

test("a preview in its own tab still works", async ({ page, context, browserName }) => {
	const student = await createStudent(context);
	// A WebKit route never sees the request's cookies, so there the edge
	// holds the session as in the other preview specs.
	await previewGateway(context, { browserCookies: browserName !== "webkit" });
	const port = await startPreviewApp(student.workspaceId, "Own tab");
	await openRunning(page, student.workspaceId, port);

	const opened = context.waitForEvent("page");
	await page.getByTestId(`running-new-tab-${port}`).click();
	const tab = await opened;
	await expect(tab.locator("h1")).toHaveText("Own tab", { timeout: 20_000 });
	const stored = (await context.cookies(tab.url())).find(
		(one) => one.name === "portikus-preview",
	);
	expect(stored?.sameSite).toBe("Strict");
	expect(stored?.partitionKey).toBeFalsy();

	await tab.goto(new URL("/", tab.url()).href);
	await expect(tab.locator("h1")).toHaveText("Own tab", { timeout: 20_000 });
});
