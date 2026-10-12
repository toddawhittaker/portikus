import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { expect, test } from "@playwright/test";
import { MOCK_USERS } from "../packages/auth/dist/testing/mock-oidc.js";
import type { SiteView } from "../packages/contracts/dist/site.js";
import { expectNoViolations, MOCK_ISSUER, openAdmin, query } from "./helpers";
import {
	playSiteJob,
	putInstallAnswers,
	readInstallAnswers,
	readSiteStatus,
	resetSiteStore,
	SITE_JOBS_DIR,
	SITE_VIEW_FILE,
} from "./site-jobs";

// The Sign-in tab's single sign-on group (SPEC.md 20.1, ADR 0059): a provider
// change is a trial the real root site job opens, a test sign-in checks it
// without signing anyone in, and Keep ends it.
test.describe.configure({ mode: "serial" });

const SECRET = "fake-e2e-client-secret-0123456789";
// An apt install's answers on Dex passwords only, as postinst writes them.
const ANSWERS =
	"portikus_admin_email: admin@example.edu\nportikus_dex_upstream: none\n" +
	"portikus_public_host: portikus.example.edu\nportikus_storage: file\n" +
	"portikus_storage_size: 100\nportikus_tls: internal\n";

const DEX_VIEW: SiteView = {
	version: 1,
	apt: true,
	host: "portikus.example.edu",
	port: 443,
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

/** Setup writes the view; nothing does in e2e, so the spec writes what setup would. */
async function putView(view: SiteView): Promise<void> {
	await writeFile(SITE_VIEW_FILE, JSON.stringify(view));
}

test.beforeEach(async () => {
	await resetSiteStore();
});

test("off an apt install the group says single sign-on is unavailable", async ({
	page,
}) => {
	await openAdmin(page);
	await page.goto("/admin/signin");
	await expect(page.getByTestId("sso-unavailable")).toContainText("installed with apt");
	await expect(page.getByTestId("sso-apply")).toHaveCount(0);
});

test("a trial of a new provider is tested without signing anyone in, then kept", async ({
	page,
}) => {
	await putInstallAnswers(ANSWERS);
	await putView(DEX_VIEW);
	await openAdmin(page);
	await page.goto("/admin/signin");
	const sso = page.getByTestId("admin-signin-sso");
	await expect(sso.getByTestId("sso-current")).toContainText("Local accounts only");

	await sso.getByTestId("sso-provider-oidc").check();
	await sso.getByLabel("Issuer URL").fill("https://login.example.edu");
	await sso.getByLabel("Client ID").fill("portikus-dex");
	await sso.getByLabel("Client secret").fill(SECRET);
	await sso.getByTestId("sso-apply").click();
	const dialog = page.getByTestId("sso-apply-confirm");
	await expect(dialog).toContainText("students cannot sign in");
	await expect(dialog).toContainText("local administrator's password always works");
	await expectNoViolations(page);
	await dialog.getByRole("button", { name: "Apply as a trial" }).click();

	// The real root job takes the request; its secret travels only in the 0600 request.
	const played = await playSiteJob();
	expect(played).toMatchObject({ kind: "signin", mode: 0o600 });
	expect(played.request).toMatchObject({ provider: "oidc", clientSecret: SECRET });
	expect(await readSiteStatus(played.id)).toMatchObject({ state: "trial" });
	await putView({
		...DEX_VIEW,
		provider: "oidc",
		oidcIssuer: "https://login.example.edu",
		clientId: "portikus-dex",
		clientSecretSet: true,
		groupsClaim: "groups",
	});
	await page.reload();

	const trial = page.getByTestId("sso-trial");
	await expect(trial).toBeVisible({ timeout: 15_000 });
	await expect(trial.getByTestId("sso-trial-left")).toHaveText(/^\d+:\d\d$/);
	await expect(trial.getByTestId("sso-keep")).toHaveAttribute("aria-disabled", "true");
	await expectNoViolations(page);

	// The test sign-in goes to the provider and back; the person is never signed in.
	await trial.getByTestId("sso-test").click();
	await page.waitForURL(`${MOCK_ISSUER}/authorize**`);
	await page.click("[data-testid=mock-user-olga]");
	await page.waitForURL("**/admin/signin");
	await expect(page.getByTestId("sso-test-result")).toContainText("passed");
	await expect(page.getByTestId("sso-test-result")).toContainText("as a student");
	await expect(page.getByTestId("sso-test-result")).toBeFocused();
	const olga = await query("SELECT id FROM users WHERE oidc_subject = $1", [
		MOCK_USERS.olga?.sub,
	]);
	expect(olga).toEqual([]);
	const rows = await query(
		"SELECT metadata FROM audit_events WHERE action = 'settings.signin_tested' AND target = $1",
		[played.id],
	);
	expect(rows).toHaveLength(1);
	expect(JSON.stringify(rows[0])).not.toContain("olga@example.edu");
	await expectNoViolations(page);

	const keep = page.getByTestId("sso-keep");
	await expect(keep).not.toHaveAttribute("aria-disabled", "true");
	await keep.click();
	const kept = await playSiteJob();
	expect(kept.request).toMatchObject({ kind: "keep", trialId: played.id });
	expect(await readSiteStatus(played.id)).toMatchObject({ state: "kept" });
	await expect(page.getByTestId("sso-job")).toContainText("kept", { timeout: 15_000 });
	await expect(page.getByTestId("sso-trial")).toHaveCount(0);
});

// Google group checks (SPEC.md 5.1, 24.8): the service account's key goes to
// the root job once, in the 0600 request, and lands only where Dex reads it.
test("Google group checks send the key once, and the page only says it is set", async ({
	page,
}) => {
	const privateLine = "MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIB-not-a-real-key";
	const key = JSON.stringify({
		type: "service_account",
		project_id: "portikus-test",
		private_key_id: "fake-e2e-key-id",
		private_key: `-----BEGIN FAKE TEST KEY-----\n${privateLine}\n-----END FAKE TEST KEY-----\n`,
		client_email: "groups@portikus-test.iam.gserviceaccount.com",
	});
	const dexDir = join(dirname(SITE_VIEW_FILE), "..", "portikus-dex");
	await mkdir(dexDir, { recursive: true });
	await putInstallAnswers(ANSWERS);
	await putView(DEX_VIEW);
	await openAdmin(page);
	await page.goto("/admin/signin");
	const sso = page.getByTestId("admin-signin-sso");
	await sso.getByTestId("sso-provider-google").check();
	await sso.getByLabel("Domains").fill("example.edu");
	await sso.getByLabel("Client ID").fill("123.apps.googleusercontent.com");
	await sso.getByLabel("Client secret").fill(SECRET);
	await expect(sso.getByLabel("Service account key")).toHaveCount(0);
	await sso
		.getByLabel("Administrator to read groups as")
		.fill("groups-reader@example.edu");
	await expect(sso.getByTestId("sso-groups-note")).toContainText("cannot join");

	// No key yet, and none stored: the page stops it.
	await sso.getByLabel("Students' group").fill("students@example.edu");
	await sso.getByLabel("Instructors' group").fill("staff@example.edu");
	await sso.getByLabel("Administrators' group").fill("it-admins@example.edu");
	await sso.getByTestId("sso-apply").click();
	await expect(sso.getByLabel("Service account key")).toHaveAttribute(
		"aria-invalid",
		"true",
	);
	await expect(page.getByTestId("sso-apply-confirm")).toHaveCount(0);
	await expectNoViolations(page);

	await sso.getByLabel("Service account key").fill(key);
	await sso.getByTestId("sso-apply").click();
	await page
		.getByTestId("sso-apply-confirm")
		.getByRole("button", { name: "Apply as a trial" })
		.click();
	const played = await playSiteJob();
	expect(played).toMatchObject({ kind: "signin", mode: 0o600 });
	expect(played.request).toMatchObject({
		provider: "google",
		googleAdminEmail: "groups-reader@example.edu",
		googleServiceAccountKey: key,
	});
	expect(await readSiteStatus(played.id)).toMatchObject({ state: "trial" });
	const keyFile = join(dexDir, "google-service-account.json");
	expect(await readFile(keyFile, "utf8")).toBe(key);
	expect((await stat(keyFile)).mode & 0o777).toBe(0o640);
	const answers = await readInstallAnswers();
	expect(answers).toContain("portikus_google_admin_email: groups-reader@example.edu");
	expect(answers).toContain("portikus_oidc_admin_group: it-admins@example.edu");
	for (const name of await readdir(join(SITE_JOBS_DIR, "status"))) {
		const text = await readFile(join(SITE_JOBS_DIR, "status", name), "utf8");
		expect(text).not.toContain(privateLine);
	}

	await putView({
		...DEX_VIEW,
		provider: "google",
		googleDomains: ["example.edu"],
		clientId: "123.apps.googleusercontent.com",
		clientSecretSet: true,
		groups: {
			student: "students@example.edu",
			instructor: "staff@example.edu",
			admin: "it-admins@example.edu",
		},
		googleAdminEmail: "groups-reader@example.edu",
		googleKeySet: true,
	});
	await page.reload();
	await expect(page.getByTestId("sso-current")).toContainText(
		"groups-reader@example.edu",
	);
	await expect(page.getByTestId("sso-current")).toContainText("Service account keySet");
	expect(await page.content()).not.toContain(privateLine);
});
