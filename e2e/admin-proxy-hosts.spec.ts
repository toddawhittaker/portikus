import { readFile, writeFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import { expectNoViolations, loginAs } from "./helpers";
import {
	PROXY_HOSTS_FILE,
	playSiteJob,
	readSiteStatus,
	resetSiteStore,
	SQUID_CONF,
} from "./site-jobs";

/**
 * Allowed API hosts on the Network tab (SPEC.md section 20.1, ADR 0059). The
 * API writes request files into a fake job directory and the tests play the
 * real root site job with playSiteJob, which writes the page file the API
 * reads back. Every test starts from no page file.
 */
test.describe.configure({ mode: "serial" });

test.beforeEach(async () => {
	await resetSiteStore();
});

const OPERATOR_CONF =
	"acl portikus_hosts_443 dstdomain -n github.com api.openai.com\ninclude /etc/portikus/egress-proxy.d/*.conf\n";

async function open(page: Page) {
	await loginAs(page, "carol");
	await page.goto("/admin/network");
	const group = page.getByTestId("proxy-hosts-group");
	await expect(group.getByRole("heading", { name: "Allowed API hosts" })).toBeVisible({
		timeout: 15_000,
	});
	return group;
}

async function pageHosts(): Promise<string[]> {
	return JSON.parse(await readFile(PROXY_HOSTS_FILE, "utf8")).hosts;
}

test("a new site has no added hosts, and the operator's show read-only", async ({
	page,
}) => {
	await writeFile(SQUID_CONF, OPERATOR_CONF);
	const group = await open(page);
	await expect(group.getByTestId("proxy-hosts-empty")).toBeVisible();
	const operator = group.getByTestId("proxy-hosts-operator");
	await expect(operator.getByRole("listitem")).toHaveText([
		"api.openai.com",
		"github.com",
	]);
	await expect(operator.getByRole("button")).toHaveCount(0);
});

test("a host is added through the root job, then removed", async ({ page }) => {
	const group = await open(page);
	await group.getByLabel("Host name").fill("API.Example.com");
	await group.getByRole("button", { name: "Allow host" }).click();
	const played = await playSiteJob();
	expect(played).toMatchObject({ kind: "proxy-hosts", mode: 0o600 });
	expect(played.request).toMatchObject({ hosts: ["api.example.com"] });
	await expect(group.getByTestId("proxy-hosts-job")).toContainText("Saved", {
		timeout: 15_000,
	});
	await expect(group.getByTestId("proxy-hosts-row")).toHaveText(/api\.example\.com/);
	expect(await pageHosts()).toEqual(["api.example.com"]);

	// The page file survives a reload.
	await page.reload();
	await expect(page.getByTestId("proxy-hosts-row")).toHaveCount(1);

	await page.getByRole("button", { name: "Remove api.example.com" }).click();
	const removed = await playSiteJob();
	expect(removed.request).toMatchObject({ hosts: [] });
	await expect(page.getByTestId("proxy-hosts-empty")).toBeVisible({ timeout: 15_000 });
	expect(await pageHosts()).toEqual([]);
});

test("a bad host is explained and nothing is sent", async ({ page }) => {
	const group = await open(page);
	for (const bad of [
		"",
		"10.0.0.1",
		"api.example.com:443",
		"https://api.example.com",
	]) {
		await group.getByLabel("Host name").fill(bad);
		await group.getByRole("button", { name: "Allow host" }).click();
		await expect(
			group.getByText(/Enter a host name|must be a host name/),
		).toBeVisible();
	}
	await writeFile(SQUID_CONF, OPERATOR_CONF);
	await page.reload();
	const again = page.getByTestId("proxy-hosts-group");
	await expect(again.getByTestId("proxy-hosts-operator")).toBeVisible();
	await again.getByLabel("Host name").fill("github.com");
	await again.getByRole("button", { name: "Allow host" }).click();
	await expect(
		again.getByText("The operator's list already allows that host."),
	).toBeVisible();
});

test("a proxy that refuses the change is reported, and nothing is saved", async ({
	page,
}) => {
	const group = await open(page);
	await group.getByLabel("Host name").fill("api.example.com");
	await group.getByRole("button", { name: "Allow host" }).click();
	const played = await playSiteJob({ squidRejects: true });
	expect(await readSiteStatus(played.id)).toMatchObject({
		state: "failed",
		code: "proxy_config_rejected",
	});
	await expect(group.getByTestId("proxy-hosts-job")).toContainText("proxy refused", {
		timeout: 15_000,
	});
	await expect(group.getByTestId("proxy-hosts-empty")).toBeVisible();
});

test("the group has no accessibility violations", async ({ page }) => {
	await writeFile(SQUID_CONF, OPERATOR_CONF);
	const group = await open(page);
	await group.getByLabel("Host name").fill("api.example.com");
	await group.getByRole("button", { name: "Allow host" }).click();
	await playSiteJob();
	await expect(group.getByTestId("proxy-hosts-row")).toHaveCount(1, {
		timeout: 15_000,
	});
	await expectNoViolations(page);
});
