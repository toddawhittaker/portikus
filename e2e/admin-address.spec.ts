import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { SiteView } from "../packages/contracts/dist/site.js";
import { expectNoViolations, loginAs, toast } from "./helpers";
import {
	expireSiteTrial,
	playSiteJob,
	putInstallAnswers,
	readSiteStatus,
	resetSiteStore,
	SITE_VIEW_FILE,
} from "./site-jobs";

/**
 * The Site address tab (SPEC.md 20.1, ADR 0059): plan,
 * pre-flight, a trial applied by the real root site job with setup faked,
 * Keep only from the new address, and a trial nobody keeps put back. The
 * pre-flight is served a fixed answer, because it resolves real DNS names,
 * which the API's own tests cover. Nothing writes the site view in e2e, so
 * each test writes its own.
 */
test.describe.configure({ mode: "serial" });

const NEW_HOST = "code.example.edu";
const NEW_URL = `https://${NEW_HOST}`;

const VIEW: SiteView = {
	version: 1,
	apt: true,
	host: "portikus.example.edu",
	port: 8443,
	previewSuffix: "preview.portikus.example.edu",
	previewSuffixSetByHand: false,
	provider: "dex",
	entraTenantId: null,
	googleDomains: [],
	oidcIssuer: null,
	clientId: null,
	clientSecretSet: false,
	groupsClaim: null,
	groups: {
		student: "portikus-students",
		instructor: "portikus-instructors",
		admin: "portikus-administrators",
	},
	certificateSource: "internal",
};

// An apt install's answers, as postinst writes them.
const ANSWERS =
	"portikus_admin_email: admin@example.edu\nportikus_dex_upstream: none\n" +
	"portikus_public_host: portikus.example.edu\nportikus_public_port: 8443\n" +
	"portikus_storage: file\nportikus_storage_size: 100\nportikus_tls: internal\n";

const PASSED = {
	ok: true,
	checks: [
		{ name: "dns-site", result: "passed", message: `${NEW_HOST} resolves.` },
		{
			name: "dns-preview",
			result: "passed",
			message: `Preview names such as portikus-check-1.preview.${NEW_HOST} resolve.`,
		},
		{
			name: "reach-site",
			result: "passed",
			message: `${NEW_HOST} points at this server.`,
		},
		{
			name: "reach-preview",
			result: "passed",
			message: `*.preview.${NEW_HOST} points at this server.`,
		},
	],
};

async function writeView(view: SiteView): Promise<void> {
	await mkdir(dirname(SITE_VIEW_FILE), { recursive: true });
	await writeFile(SITE_VIEW_FILE, JSON.stringify(view));
}

async function open(page: Page): Promise<void> {
	await loginAs(page, "carol");
	await page.goto("/admin/address");
	await expect(
		page.getByRole("heading", { level: 2, name: "Site address", exact: true }),
	).toBeVisible({ timeout: 15_000 });
}

/** Plan and check the new address, then apply it and let the job open the trial. */
async function applyTrial(page: Page): Promise<string> {
	await page.route("**/admin/address/preflight", (route) =>
		route.fulfill({ json: PASSED }),
	);
	await page.getByTestId("address-host").fill(NEW_HOST);
	await page.getByTestId("address-port").fill("443");
	await page.getByTestId("address-check").click();
	await expect(page.getByTestId("address-preflight-summary")).toHaveText(
		"All DNS checks passed.",
	);
	await page.getByTestId("address-apply").click();
	const dialog = page.getByTestId("address-apply-confirm");
	await expect(dialog).toContainText("Everyone is signed out");
	await dialog.getByRole("button", { name: "Apply" }).click();
	const played = await playSiteJob();
	expect(played.request).toMatchObject({ kind: "address", host: NEW_HOST, port: 443 });
	expect(await readSiteStatus(played.id)).toMatchObject({ state: "trial" });
	await expect(page.getByTestId("address-job-text")).toContainText(
		`The site now answers at ${NEW_URL} as a trial.`,
	);
	return played.id;
}

test.beforeEach(async () => {
	await resetSiteStore();
	await putInstallAnswers(ANSWERS);
	await writeView(VIEW);
});

test("off an apt install the page explains the change is unavailable", async ({
	page,
}) => {
	await writeView({ ...VIEW, apt: false });
	await open(page);
	await expect(page.getByTestId("address-unavailable")).toContainText(
		"installed with apt",
	);
	await expect(page.getByTestId("address-change")).toHaveCount(0);
	await expect(page.getByTestId("address-recovery")).toContainText(
		"sudo dpkg-reconfigure portikus",
	);
});

test("the plan lists the new values and the checklist, and Apply waits for the checks", async ({
	page,
}) => {
	await open(page);
	await expect(page.getByTestId("address-current-url")).toHaveText(
		"https://portikus.example.edu:8443",
	);
	await expect(page.getByTestId("address-apply")).toHaveAttribute(
		"aria-disabled",
		"true",
	);
	await page.route("**/admin/address/preflight", (route) =>
		route.fulfill({
			json: {
				ok: false,
				checks: [
					{
						name: "reach-site",
						result: "failed",
						message: `${NEW_HOST} does not point at this server at every address DNS gives.`,
					},
				],
			},
		}),
	);
	await page.getByTestId("address-host").fill(NEW_HOST);
	await page.getByTestId("address-port").fill("443");
	await page.getByTestId("address-check").click();
	await expect(page.getByTestId("address-plan-issuer")).toHaveText(`${NEW_URL}/dex`);
	await expect(page.getByTestId("address-plan-lti-keyset")).toHaveText(
		`${NEW_URL}/lti/jwks`,
	);
	await expect(page.getByTestId("address-plan-preview")).toHaveText(
		`*.preview.${NEW_HOST}`,
	);
	await expect(page.getByTestId("address-checklist")).toContainText(
		`${NEW_URL}/lti/login`,
	);
	await expect(page.getByTestId("address-preflight-summary")).toContainText(
		"1 check failed",
	);
	await expect(page.getByTestId("address-apply")).toHaveAttribute(
		"aria-disabled",
		"true",
	);
	await expect(page.locator("#address-apply-note")).toHaveText(
		"The DNS checks must pass first.",
	);
	await expectNoViolations(page, "main");
});

test("Keep works only from the new address", async ({ page }) => {
	await open(page);
	const trialId = await applyTrial(page);
	await expect(page.getByTestId("address-countdown")).toHaveText(/^1[45]:\d\d$/);
	await expect(page.getByTestId("address-open-new")).toContainText(NEW_URL);
	await expectNoViolations(page, "main");

	// This page is on the old address, which cannot prove the new one works.
	await page.getByTestId("address-keep").click();
	await expect(toast(page, "Could not keep the address")).toBeVisible();

	// Caddy tells the API which name the browser used; this stands in for it.
	await page.setExtraHTTPHeaders({ "x-forwarded-host": NEW_HOST });
	await page.getByTestId("address-keep").click();
	await expect(toast(page, "Keep requested")).toBeVisible();
	const keep = await playSiteJob();
	expect(keep.request).toMatchObject({ kind: "keep", trialId });
	expect(await readSiteStatus(trialId)).toMatchObject({ state: "kept" });
	await expect(page.getByTestId("address-job-text")).toHaveText(
		`The site moved to ${NEW_URL} and the change was kept.`,
	);
});

test("a trial nobody keeps is put back", async ({ page }) => {
	await open(page);
	const trialId = await applyTrial(page);
	await expireSiteTrial(trialId);
	expect(await readSiteStatus(trialId)).toMatchObject({
		state: "reverted",
		code: "trial_expired",
	});
	await expect(page.getByTestId("address-job-text")).toContainText(
		"Nobody pressed Keep",
		{ timeout: 10_000 },
	);
	await expect(page.getByTestId("address-keep")).toHaveCount(0);
});

test("Roll back puts the old address back from the old page", async ({ page }) => {
	await open(page);
	const trialId = await applyTrial(page);
	await page.getByTestId("address-rollback").click();
	await expect(toast(page, "Roll back requested")).toBeVisible();
	const rollback = await playSiteJob();
	expect(rollback.request).toMatchObject({ kind: "rollback", trialId });
	await expect(page.getByTestId("address-job-text")).toContainText("rolled back");
});
