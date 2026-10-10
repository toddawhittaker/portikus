import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import type { SiteJobBody } from "../packages/contracts/dist/site.js";
import {
	expireSiteTrial,
	PROXY_HOSTS_FILE,
	playSiteJob,
	putInstallAnswers,
	readInstallAnswers,
	readSiteStatus,
	resetSiteStore,
	SITE_JOBS_DIR,
} from "./site-jobs";

// The harness the site page specs play the root site job with (ADR 0059):
// requests written as the API writes them, so a page spec's failure is its
// own and not the harness's.
test.describe.configure({ mode: "serial" });

const SECRET = "fake-e2e-client-secret-0123456789";
// An apt install's answers, as postinst writes them.
const ANSWERS =
	"portikus_admin_email: admin@example.edu\nportikus_dex_upstream: none\n" +
	"portikus_public_host: portikus.example.edu\nportikus_storage: file\n" +
	"portikus_storage_size: 100\nportikus_tls: internal\n";

/** A request file as apps/api/src/site/jobs.ts writes it, mode 0600. */
async function request(body: SiteJobBody): Promise<string> {
	const id = randomUUID();
	const file = { ...body, version: 1, id, requestedAt: new Date().toISOString() };
	await writeFile(join(SITE_JOBS_DIR, `request-${id}.json`), JSON.stringify(file), {
		mode: 0o600,
	});
	return id;
}

test.beforeEach(async () => {
	await resetSiteStore();
});

test("the site job applies page proxy hosts", async () => {
	const id = await request({ kind: "proxy-hosts", hosts: ["api.example.com"] });
	const played = await playSiteJob();
	expect(played).toMatchObject({ id, kind: "proxy-hosts", mode: 0o600 });
	expect(await readSiteStatus(id)).toMatchObject({ state: "done", code: null });
	expect(JSON.parse(await readFile(PROXY_HOSTS_FILE, "utf8"))).toEqual({
		version: 1,
		hosts: ["api.example.com"],
	});
});

test("the site job refuses a template expression", async () => {
	const id = await request({ kind: "proxy-hosts", hosts: ["{{ 7*7 }}"] });
	await playSiteJob();
	expect(await readSiteStatus(id)).toMatchObject({
		state: "failed",
		code: "invalid_value",
	});
});

test("a sign-in trial nobody keeps is put back, and no status holds the secret", async () => {
	await putInstallAnswers(ANSWERS);
	const id = await request({
		kind: "signin",
		provider: "oidc",
		oidcIssuer: "https://login.example.edu",
		clientId: "portikus-dex",
		clientSecret: SECRET,
	});
	await playSiteJob();
	const trial = await readSiteStatus(id);
	expect(trial).toMatchObject({ state: "trial", code: null });
	expect(JSON.stringify(trial)).not.toContain(SECRET);
	expect(await readInstallAnswers()).toContain("portikus_dex_upstream: oidc");

	await expireSiteTrial(id);
	expect(await readSiteStatus(id)).toMatchObject({
		state: "reverted",
		code: "trial_expired",
	});
	expect(await readInstallAnswers()).toBe(ANSWERS);
});

test("a failed setup puts the old address back", async () => {
	await putInstallAnswers(ANSWERS);
	const id = await request({ kind: "address", host: "new.example.edu", port: 8443 });
	await playSiteJob({ setupFails: true });
	expect(await readSiteStatus(id)).toMatchObject({
		state: "reverted",
		code: "setup_failed",
	});
	expect(await readInstallAnswers()).toBe(ANSWERS);
});
