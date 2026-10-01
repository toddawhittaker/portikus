import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import {
	CERTIFICATE_JOBS_DIR,
	FAKE_ROOT_PEM,
	putRoot,
	putStatus,
	requestFiles,
	resetCertificateStore,
	takeRequest,
	writeLog,
	writeStatus,
} from "./certificate-jobs";
import { expectNoViolations, loginAs, openToggletip, WEB_ORIGIN } from "./helpers";

/**
 * The Certificate tab (docs/SPEC.md section 20.1; ADR 0046). The first
 * group plays the root job against a fake job directory: the tests take each
 * request file the API writes and answer with the status and log the real
 * job would. The pre-flight is served fixed answers, because it resolves
 * the site's real DNS names, which the API's own tests cover. The last group
 * serves fixed page data for the accessibility checks.
 */

const LETS_ENCRYPT = "https://acme-v02.api.letsencrypt.org/directory";
// Obviously fake: secrets in tests must never look real.
const FAKE_TOKEN = "fake-cloudflare-token-for-e2e";

const PASSED = {
	ok: true,
	checks: [
		{
			name: "dns-site",
			result: "passed",
			message: "localhost resolves to this server.",
		},
		{
			name: "dns-preview",
			result: "passed",
			message: "x1.preview.localhost resolves to this server.",
		},
	],
};

const ACME_SETTINGS = {
	source: "acme",
	directory: LETS_ENCRYPT,
	email: "it@example.edu",
	eab: null,
	challenge: {
		mode: "dns01",
		provider: "cloudflare",
		fields: {},
		secretsSet: { api_token: true },
	},
};

/** A self-signed certificate and a key that does not belong to it, made once with openssl. */
function mismatchedPair(): { cert: string; otherKey: string } {
	const dir = mkdtempSync(join(tmpdir(), "portikus-e2e-cert-"));
	const run = (args: string[]) => execFileSync("openssl", args, { stdio: "ignore" });
	run([
		"req",
		"-x509",
		"-newkey",
		"ec",
		"-pkeyopt",
		"ec_paramgen_curve:prime256v1",
		"-nodes",
		"-days",
		"30",
		"-subj",
		"/CN=localhost",
		"-addext",
		"subjectAltName=DNS:localhost,DNS:*.preview.localhost",
		"-keyout",
		join(dir, "site.key"),
		"-out",
		join(dir, "site.crt"),
	]);
	run([
		"genpkey",
		"-algorithm",
		"EC",
		"-pkeyopt",
		"ec_paramgen_curve:prime256v1",
		"-out",
		join(dir, "other.key"),
	]);
	return {
		cert: readFileSync(join(dir, "site.crt"), "utf8"),
		otherKey: readFileSync(join(dir, "other.key"), "utf8"),
	};
}

async function open(page: Page) {
	await loginAs(page, "carol");
	await page.goto("/admin?tab=certificate");
	await expect(
		page.getByRole("heading", { level: 2, name: "Certificate", exact: true }),
	).toBeVisible({ timeout: 15_000 });
	await expect(page.getByTestId("cert-current")).toBeVisible();
}

/** The pre-flight's fixed answer for this page. */
async function routePreflight(page: Page, answer: object = PASSED) {
	await page.route("**/admin/certificate/preflight", (route) =>
		route.fulfill({ json: answer }),
	);
}

const LE_ISSUER = "CN=R11,O=Let's Encrypt,C=US";

test.describe("with the fake root job", () => {
	// One job directory for the whole group, so the tests run in order.
	test.describe.configure({ mode: "serial" });

	test.beforeEach(async () => {
		await resetCertificateStore();
		await putStatus({});
	});

	test("shows the certificate in use and downloads the internal root", async ({
		page,
	}) => {
		await putRoot();
		await open(page);
		await expect(page.getByTestId("cert-issuer-site")).toHaveText(
			"CN=Caddy Local Authority - ECC Intermediate",
		);
		await expect(page.getByTestId("cert-row-site")).toContainText(
			"*.preview.localhost",
		);
		await expect(page.getByTestId("cert-expires-site")).toContainText(/in \d+ days/);
		await expect(page.getByTestId("cert-last-renewal")).toHaveText(
			"None since the last change",
		);

		const root = page.getByTestId("cert-root");
		await expect(root).toContainText("update-ca-certificates");
		const [download] = await Promise.all([
			page.waitForEvent("download"),
			root.getByRole("link", { name: "Download root certificate" }).click(),
		]);
		expect(await readFile(await download.path(), "utf8")).toBe(FAKE_ROOT_PEM);
	});

	test("Test only: checks the names, sends the token once in a 0600 request, and shows progress", async ({
		page,
	}) => {
		await routePreflight(page);
		await open(page);
		await page.getByRole("radio", { name: /^ACME/ }).check();
		await page.getByLabel("Account email").fill("it@example.edu");
		const token = page.getByLabel("API token");
		await expect(token).toHaveAttribute("type", "password");
		await expect(token).toHaveAccessibleDescription("Not set.");
		await token.fill(FAKE_TOKEN);
		await page.getByRole("button", { name: "Test only" }).click();

		await expect(page.getByTestId("cert-preflight-summary")).toHaveText(
			"All checks passed.",
		);
		const { id, mode, request } = await takeRequest();
		expect(mode).toBe(0o600);
		expect(request).toEqual({
			kind: "test",
			settings: {
				source: "acme",
				directory: LETS_ENCRYPT,
				email: "it@example.edu",
				challenge: {
					mode: "dns01",
					dns: { provider: "cloudflare", fields: { api_token: FAKE_TOKEN } },
				},
			},
		});
		await writeStatus(
			id,
			"test",
			"running",
			"Getting a certificate from Let's Encrypt staging",
		);
		await writeLog(id, ["starting a separate caddy", "solving dns-01 for localhost"]);

		const job = page.getByTestId("cert-job");
		await expect(job.getByTestId("cert-job-state")).toContainText(
			"Getting a certificate from Let's Encrypt staging",
			{ timeout: 5_000 },
		);
		await expect(job.getByTestId("cert-job-log")).toContainText("solving dns-01");
		// The always-present status region reads the new state out.
		await expect(page.getByTestId("cert-job-announce")).toHaveText(
			"Test only: Running. Getting a certificate from Let's Encrypt staging.",
			{ timeout: 5_000 },
		);
		await expect(page.getByRole("button", { name: "Apply" })).toHaveAttribute(
			"aria-disabled",
			"true",
		);

		// The page polls: the next step arrives without a reload.
		await writeStatus(id, "test", "succeeded", "The test certificate was issued");
		await expect(job.getByTestId("cert-job-state")).toContainText("Finished", {
			timeout: 5_000,
		});
		await expect(page.getByRole("button", { name: "Apply" })).not.toHaveAttribute(
			"aria-disabled",
			"true",
		);

		// The token is never shown, and the job's record on disk keeps none.
		await expect(page.locator("body")).not.toContainText(FAKE_TOKEN);
		expect(
			await readFile(join(CERTIFICATE_JOBS_DIR, id, "request.json"), "utf8"),
		).not.toContain(FAKE_TOKEN);
	});

	test("a failed apply keeps the old certificate and says why", async ({ page }) => {
		await putStatus({ settings: ACME_SETTINGS, issuer: LE_ISSUER });
		await routePreflight(page);
		await open(page);
		// The stored token is kept: the field starts blank and says so.
		const token = page.getByLabel("API token");
		await expect(token).toHaveValue("");
		await expect(token).toHaveAccessibleDescription("Set. Leave blank to keep it.");
		await page.getByRole("button", { name: "Apply" }).click();
		const dialog = page.getByTestId("cert-apply-confirm");
		await expect(dialog).toContainText(
			"Until then the site keeps its current certificate.",
		);
		await dialog.getByRole("button", { name: "Apply" }).click();

		const { id, request } = await takeRequest();
		// A blank secret is left out, so the job keeps the stored one (Epic 27 R8).
		expect(request).toEqual({
			kind: "apply",
			settings: {
				source: "acme",
				directory: LETS_ENCRYPT,
				email: "it@example.edu",
				challenge: { mode: "dns01", dns: { provider: "cloudflare", fields: {} } },
			},
		});
		await writeStatus(id, "apply", "failed", "Put the previous settings back", {
			message: "Cloudflare refused the token: Invalid access token (code 1000)",
			restored: true,
		});
		const job = page.getByTestId("cert-job");
		await expect(job.getByTestId("cert-job-message")).toHaveText(
			"Cloudflare refused the token: Invalid access token (code 1000)",
			{ timeout: 5_000 },
		);
		await expect(job.getByTestId("cert-job-restored")).toContainText("still in use");
		await expect(job.getByTestId("cert-job-state")).toContainText("Failed");
		await expect(page.getByTestId("cert-issuer-site")).toHaveText(LE_ISSUER);
	});

	test("a failed HTTP-01 pre-flight check blocks the test and names the wrong name", async ({
		page,
	}) => {
		await putStatus({ settings: ACME_SETTINGS, issuer: LE_ISSUER });
		await routePreflight(page, {
			ok: false,
			checks: [
				{
					name: "dns-preview",
					result: "failed",
					message: "x1.preview.localhost resolves to 198.51.100.9, not this server.",
				},
			],
		});
		await open(page);
		await page.getByRole("radio", { name: /^HTTP-01/ }).check();
		await expect(page.getByTestId("cert-http01-note")).toContainText("Port 80");
		await page.getByRole("button", { name: "Test only" }).click();
		await expect(page.getByTestId("cert-preflight-summary")).toHaveText(
			"1 check failed. Fix it and try again.",
		);
		await expect(page.getByTestId("cert-check-dns-preview")).toContainText(
			"x1.preview.localhost resolves to 198.51.100.9",
		);
		await page.waitForTimeout(500);
		expect(await requestFiles()).toEqual([]);
	});

	test("an upload whose key does not match is refused, naming the check", async ({
		page,
	}) => {
		const { cert, otherKey } = mismatchedPair();
		await open(page);
		await page.getByRole("radio", { name: /^Upload files/ }).check();
		const site = page.getByTestId("cert-upload-site");
		await site.getByLabel("Certificate", { exact: true }).setInputFiles({
			name: "site.crt",
			mimeType: "application/x-pem-file",
			buffer: Buffer.from(cert),
		});
		await site.getByLabel("Private key").setInputFiles({
			name: "site.key",
			mimeType: "application/x-pem-file",
			buffer: Buffer.from(otherKey),
		});
		await page.getByRole("button", { name: "Apply" }).click();
		await page
			.getByTestId("cert-apply-confirm")
			.getByRole("button", { name: "Apply" })
			.click();
		const error = page.getByTestId("cert-form-error");
		await expect(error).toContainText(
			'Site certificate: failed the check "Key matches the certificate".',
		);
		// Also under the file the check reads.
		await expect(site.getByLabel("Private key")).toHaveAccessibleDescription(
			/Key matches the certificate/,
		);
		await expect(error).not.toContainText("BEGIN");
		expect(await requestFiles()).toEqual([]);
	});

	test("descriptions and errors reach assistive technology (SPEC.md section 25.8)", async ({
		page,
	}) => {
		await open(page);
		// Each source's sentence describes its radio; the name stays the short label.
		const acme = page.getByRole("radio", { name: "ACME", exact: true });
		await expect(acme).toHaveAccessibleDescription(/Let's Encrypt, ZeroSSL/);
		await acme.check();
		// A Select's hint describes its trigger.
		await page.getByRole("combobox", { name: /ACME directory/ }).click();
		await page.getByRole("option", { name: "Let's Encrypt staging" }).click();
		await expect(
			page.getByRole("combobox", { name: /ACME directory/ }),
		).toHaveAccessibleDescription(/Browsers do not trust staging certificates/);
		// A file that is not PEM is an alert as soon as it is picked.
		await page.getByRole("radio", { name: "Upload files", exact: true }).check();
		await page
			.getByTestId("cert-upload-site")
			.getByLabel("Certificate", { exact: true })
			.setInputFiles({
				name: "site.der",
				mimeType: "application/octet-stream",
				buffer: Buffer.from("not a pem file"),
			});
		await expect(page.getByTestId("cert-upload-site").getByRole("alert")).toContainText(
			"not in PEM format",
		);
	});

	test("a request the job refuses shows the failed check", async ({ page }) => {
		const id = crypto.randomUUID();
		await writeStatus(id, "apply", "refused", "Refused", {
			message: "The chain is not complete: no issuer found for CN=Campus CA.",
		});
		await open(page);
		const job = page.getByTestId("cert-job");
		await expect(job.getByTestId("cert-job-state")).toContainText("Refused");
		await expect(job.getByTestId("cert-job-message")).toHaveText(
			"The chain is not complete: no issuer found for CN=Campus CA.",
		);
	});

	test("Renew now and Roll back ask the job", async ({ page }) => {
		await putStatus({
			settings: ACME_SETTINGS,
			previousAvailable: true,
			issuer: LE_ISSUER,
		});
		await open(page);
		await page.getByRole("button", { name: "Renew now" }).click();
		const renew = await takeRequest();
		expect(renew.request).toEqual({ kind: "renew" });
		await writeStatus(renew.id, "renew", "succeeded", "Renewed");
		await expect(page.getByTestId("cert-job-kind")).toHaveText("Renew now", {
			timeout: 5_000,
		});
		await expect(page.getByTestId("cert-job-state")).toContainText("Finished", {
			timeout: 5_000,
		});

		await page.getByRole("button", { name: "Roll back" }).click();
		const dialog = page.getByTestId("cert-rollback-confirm");
		await expect(dialog).toContainText(
			"Roll back to the previous certificate settings?",
		);
		await dialog.getByRole("button", { name: "Roll back" }).click();
		const rollback = await takeRequest();
		expect(rollback.request).toEqual({ kind: "rollback" });
		await writeStatus(rollback.id, "rollback", "running", "Reloading Caddy");
		await expect(page.getByTestId("cert-job-kind")).toHaveText("Roll back", {
			timeout: 5_000,
		});
	});

	test("a second request while one waits is refused", async ({ page }) => {
		await open(page);
		const first = await page.request.post("/admin/certificate/jobs", {
			headers: { origin: WEB_ORIGIN },
			data: { kind: "check" },
		});
		expect(first.status()).toBe(202);
		const second = await page.request.post("/admin/certificate/jobs", {
			headers: { origin: WEB_ORIGIN },
			data: { kind: "rollback" },
		});
		expect(second.status()).toBe(409);
		expect(await requestFiles()).toHaveLength(1);
		await page.reload();
		await expect(page.getByTestId("cert-job-state")).toContainText("Waiting to start", {
			timeout: 15_000,
		});
		await expect(page.getByRole("button", { name: "Apply" })).toHaveAttribute(
			"aria-disabled",
			"true",
		);
		// The internal authority's certificates renew themselves, so there is no Renew now.
		await expect(page.getByRole("button", { name: "Renew now" })).toHaveCount(0);
	});
});

// ---- Fixed page data, for the accessibility checks (SPEC.md section 25.8) ----

const JOB_ID = "44444444-4444-4444-8444-444444444444";

const FAILED_JOB = {
	id: JOB_ID,
	kind: "apply",
	state: "failed",
	step: "Put the previous settings back",
	message: "Cloudflare refused the token: Invalid access token (code 1000)",
	restored: true,
	requestedAt: "2026-09-30T09:59:00.000Z",
	startedAt: "2026-09-30T10:00:00.000Z",
	finishedAt: "2026-09-30T10:03:00.000Z",
	request: { kind: "apply", settings: ACME_SETTINGS },
};

function soon(days: number): string {
	return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
}

const PAGE = {
	siteName: "portikus.example.edu",
	previewSuffix: "preview.portikus.example.edu",
	settings: ACME_SETTINGS,
	previousAvailable: true,
	status: {
		checkedAt: "2026-09-30T10:00:00.000Z",
		source: "acme",
		settings: ACME_SETTINGS,
		previousAvailable: true,
		site: {
			name: "portikus.example.edu",
			issuer: "CN=R11,O=Let's Encrypt,C=US",
			names: ["portikus.example.edu", "*.preview.portikus.example.edu"],
			notBefore: "2026-07-01T00:00:00.000Z",
			notAfter: soon(10),
		},
		preview: {
			name: "x1.preview.portikus.example.edu",
			issuer: "CN=R11,O=Let's Encrypt,C=US",
			names: ["portikus.example.edu", "*.preview.portikus.example.edu"],
			notBefore: "2026-07-01T00:00:00.000Z",
			notAfter: soon(10),
		},
		lastRenewal: {
			ok: false,
			at: "2026-09-30T08:00:00.000Z",
			message: "DNS provider said: invalid credentials",
		},
	},
	job: FAILED_JOB,
	rootCertificateAvailable: true,
};

async function routePage(page: Page) {
	await page.route("**/admin/certificate", (route) => route.fulfill({ json: PAGE }));
	await page.route(`**/admin/certificate/jobs/${JOB_ID}`, (route) =>
		route.fulfill({
			json: { job: FAILED_JOB, log: ["starting a separate caddy", "dns-01 failed"] },
		}),
	);
	// An HTTP-01 answer: DNS-01 only ever warns, so only HTTP-01 has a failed check.
	await routePreflight(page, {
		ok: false,
		checks: [
			{ name: "dns-site", result: "passed", message: "Resolves to 203.0.113.7." },
			{
				name: "reach-preview",
				result: "warning",
				message: "x1.preview.portikus.example.edu did not answer in time.",
			},
			{
				name: "dns-preview",
				result: "failed",
				message: "x1.preview.portikus.example.edu resolves to 198.51.100.9.",
			},
		],
	});
}

for (const colorScheme of ["light", "dark"] as const) {
	test(`the Certificate tab has no automatic accessibility violations (${colorScheme})`, async ({
		page,
	}) => {
		await routePage(page);
		await page.emulateMedia({ colorScheme });
		await loginAs(page, "carol");
		await page.goto("/admin?tab=certificate");
		await expect(page.getByTestId("cert-job-message")).toBeVisible({ timeout: 15_000 });
		await expect(page.getByTestId("cert-expiry-notice")).toContainText("expires in");
		await expect(page.getByTestId("intro-admin-certificate")).toBeVisible();
		await expectNoViolations(page);

		// Pre-flight results, then the form for each source.
		await page.getByRole("radio", { name: "HTTP-01" }).check();
		await page.getByRole("button", { name: "Test only" }).click();
		await expect(page.getByTestId("cert-preflight-summary")).toHaveText(
			"1 check failed. Fix it and try again.",
		);
		await expectNoViolations(page);

		await page.getByRole("radio", { name: /^ACME/ }).focus();
		await page.keyboard.press("ArrowDown");
		await expect(page.getByRole("radio", { name: /^Upload files/ })).toBeChecked();
		await page.getByText("Use a separate wildcard certificate for previews").click();
		await expect(page.getByTestId("cert-upload-preview")).toBeVisible();
		await expectNoViolations(page);

		// A toggletip opens and Escape closes it back onto its button.
		const tip = page.getByRole("button", { name: "About renewal" });
		await tip.click();
		await expect(openToggletip(page)).toBeVisible();
		await expectNoViolations(page);
		await page.keyboard.press("Escape");
		await expect(tip).toBeFocused();

		// The log takes focus, so it scrolls from the keyboard.
		await page.getByTestId("cert-job-log").focus();
		await expect(page.getByTestId("cert-job-log")).toBeFocused();
	});

	test(`the certificate dialogs have no automatic accessibility violations (${colorScheme})`, async ({
		page,
	}) => {
		await routePage(page);
		await page.emulateMedia({ colorScheme });
		await loginAs(page, "carol");
		await page.goto("/admin?tab=certificate");
		await expect(page.getByTestId("cert-current")).toBeVisible({ timeout: 15_000 });

		await page.getByRole("radio", { name: /^Internal authority/ }).check();
		await page.getByRole("button", { name: "Apply" }).click();
		const apply = page.getByTestId("cert-apply-confirm");
		await expect(apply).toContainText("Switch to the internal authority?");
		await expectNoViolations(page);
		await page.keyboard.press("Escape");
		await expect(apply).toHaveCount(0);

		await page.getByRole("button", { name: "Roll back" }).click();
		const rollback = page.getByTestId("cert-rollback-confirm");
		await expect(rollback).toBeVisible();
		await expectNoViolations(page);
		await page.keyboard.press("Escape");
		await expect(rollback).toHaveCount(0);
		await expect(page.getByRole("button", { name: "Roll back" })).toBeFocused();
	});
}
