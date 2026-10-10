import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import { expectNoViolations, loginAs } from "./helpers";
import {
	LTI_ADMIN_PLATFORMS_FILE,
	playSiteJob,
	readSiteStatus,
	resetSiteStore,
} from "./site-jobs";

/**
 * LMS platforms on the Sign-in tab (SPEC.md sections 5.1 and 20.1, ADR 0025
 * and 0059). The API writes request files into a fake job directory and the
 * tests play the real root site job with playSiteJob, including its real
 * platforms check. Every test starts from no page file.
 */
test.describe.configure({ mode: "serial" });

test.beforeEach(async () => {
	await resetSiteStore();
});

const CANVAS = {
	name: "Canvas",
	issuer: "https://canvas.example.edu",
	clientId: "10000000000001",
	authLoginUrl: "https://canvas.example.edu/api/lti/authorize_redirect",
	keysetUrl: "https://canvas.example.edu/api/lti/security/jwks",
	authTokenUrl: "https://canvas.example.edu/login/oauth2/token",
	deploymentIds: ["1:abc", "2:def"],
};

async function open(page: Page) {
	await loginAs(page, "carol");
	await page.goto("/admin/signin");
	const group = page.getByTestId("admin-signin-lms");
	await expect(group.getByTestId("lms-tool-urls")).toBeVisible({ timeout: 15_000 });
	return group;
}

async function fillDialog(page: Page, platform: typeof CANVAS) {
	const dialog = page.getByTestId("lms-dialog");
	await dialog.getByTestId("lms-name").fill(platform.name);
	await dialog.getByTestId("lms-issuer").fill(platform.issuer);
	await dialog.getByTestId("lms-clientId").fill(platform.clientId);
	await dialog.getByTestId("lms-authLoginUrl").fill(platform.authLoginUrl);
	await dialog.getByTestId("lms-keysetUrl").fill(platform.keysetUrl);
	await dialog.getByTestId("lms-authTokenUrl").fill(platform.authTokenUrl);
	await dialog.getByLabel("Deployment IDs").fill(platform.deploymentIds.join("\n"));
	return dialog;
}

async function pagePlatforms(): Promise<{ name: string }[]> {
	return JSON.parse(await readFile(LTI_ADMIN_PLATFORMS_FILE, "utf8")).platforms;
}

test("the tool's addresses and the operator's platform show, read-only", async ({
	page,
}) => {
	const group = await open(page);
	const urls = group.getByTestId("lms-tool-urls");
	await expect(urls).toContainText("/lti/login");
	await expect(urls).toContainText("/lti/launch");
	await expect(urls).toContainText("/lti/jwks");
	await expect(urls.getByText("Deep Linking address")).toBeVisible();
	await expect(group.getByTestId("lms-empty")).toBeVisible();
	const operator = group.getByTestId("lms-operator");
	await expect(operator).toContainText("mock-lms");
	await expect(operator.getByRole("button")).toHaveCount(0);
});

test("a platform is added, warned about, applied by the root job, edited and removed", async ({
	page,
}) => {
	const group = await open(page);
	await group.getByTestId("lms-add").click();
	const dialog = await fillDialog(page, CANVAS);
	await expect(dialog.getByTestId("lms-restart-warning")).toContainText(
		"restarts the Portikus API",
	);
	await expect(dialog.getByTestId("lms-restart-warning")).toContainText("root shell");
	await dialog.getByTestId("lms-save").click();

	const played = await playSiteJob();
	expect(played).toMatchObject({ kind: "lti-platforms", mode: 0o600 });
	expect(played.request).toMatchObject({
		platforms: [{ ...CANVAS, mock: false }],
	});
	expect(await readSiteStatus(played.id)).toMatchObject({ state: "done" });
	await expect(group.getByTestId("lms-row")).toHaveText(/Canvas/, { timeout: 15_000 });
	expect(await pagePlatforms()).toHaveLength(1);

	// Edit: the dialog starts from the saved values.
	await group.getByRole("button", { name: "Edit Canvas" }).click();
	const edit = page.getByTestId("lms-dialog");
	await expect(edit.getByTestId("lms-clientId")).toHaveValue(CANVAS.clientId);
	await edit.getByTestId("lms-name").fill("Canvas Prod");
	await edit.getByTestId("lms-save").click();
	await playSiteJob();
	await expect(group.getByTestId("lms-row")).toHaveText(/Canvas Prod/, {
		timeout: 15_000,
	});

	// Remove, after a confirmation that repeats the restart warning.
	await group.getByRole("button", { name: "Remove Canvas Prod" }).click();
	const confirm = page.getByTestId("lms-remove-dialog");
	await expect(confirm).toContainText("restarts the Portikus API");
	await confirm.getByRole("button", { name: "Remove and restart" }).click();
	const removed = await playSiteJob();
	expect(removed.request).toMatchObject({ platforms: [] });
	await expect(group.getByTestId("lms-empty")).toBeVisible({ timeout: 15_000 });
});

test("an http address, a name clash and missing fields are explained before sending", async ({
	page,
}) => {
	const group = await open(page);
	await group.getByTestId("lms-add").click();
	const dialog = page.getByTestId("lms-dialog");
	await dialog.getByTestId("lms-save").click();
	await expect(dialog.getByText("Enter a name.")).toBeVisible();
	await expect(dialog.getByText("Enter at least one deployment ID.")).toBeVisible();

	await fillDialog(page, { ...CANVAS, name: "mock-lms" });
	await dialog.getByTestId("lms-save").click();
	await expect(
		dialog.getByText("Another platform already has this name."),
	).toBeVisible();

	await dialog.getByTestId("lms-name").fill("Canvas");
	await dialog.getByTestId("lms-issuer").fill("http://canvas.example.edu");
	await dialog.getByTestId("lms-save").click();
	await expect(dialog.getByText(/must be an https URL/).first()).toBeVisible();
	await dialog.getByRole("button", { name: "Cancel" }).click();
	await expect(dialog).toHaveCount(0);
});

test("a proxy that refuses the change is reported", async ({ page }) => {
	const group = await open(page);
	await group.getByTestId("lms-add").click();
	const dialog = await fillDialog(page, CANVAS);
	await dialog.getByTestId("lms-save").click();
	const played = await playSiteJob({ squidRejects: true });
	expect(await readSiteStatus(played.id)).toMatchObject({
		state: "failed",
		code: "proxy_config_rejected",
	});
	await expect(group.getByTestId("lms-job")).toContainText("proxy refused", {
		timeout: 15_000,
	});
	await expect(group.getByTestId("lms-empty")).toBeVisible();
});

test("the group and its dialog have no accessibility violations", async ({ page }) => {
	const group = await open(page);
	await expectNoViolations(page);
	await group.getByTestId("lms-add").click();
	await fillDialog(page, CANVAS);
	await expectNoViolations(page);
});
