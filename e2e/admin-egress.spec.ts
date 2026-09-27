import { expect, type Page, test } from "@playwright/test";
import { EGRESS_PRESETS } from "../packages/contracts/dist/egress.js";
import { loginAs, query } from "./helpers";

/**
 * The admin Network tab: the workspace egress allow-list (issue #284, SPEC.md
 * section 20.1). No worker runs here, so tests mark a policy applied, or
 * failed, straight in the database, as the worker's apply loop would.
 */

// Every test here shares the one settings row.
test.describe.configure({ mode: "serial" });

const SUFFIX = "e2e-egress.test";
const RANGES = ["203.0.113.0/24", "198.51.100.0/24"];

async function reset(mode: "open" | "allow-list" = "open"): Promise<void> {
	await query(
		`update settings set egress_mode = $1, egress_presets = '{}', egress_ports = '{22,80,443}',
		 egress_version = egress_version + 1 where id = 1`,
		[mode],
	);
	await markApplied();
	await query("delete from egress_entries where value like $1 or value = any($2)", [
		`%${SUFFIX}`,
		RANGES,
	]);
	await query("delete from egress_blocked_names where name like $1", [`%${SUFFIX}`]);
}

/** What the worker records once the controller has applied the policy. */
async function markApplied(): Promise<void> {
	await query(
		`update settings set egress_applied_version = egress_version,
		 egress_applied_at = now(), egress_apply_error = null where id = 1`,
	);
}

async function open(page: Page): Promise<void> {
	await loginAs(page, "carol");
	await page.goto("/admin?tab=network");
	await expect(page.getByTestId("egress-tab")).toBeVisible({ timeout: 15_000 });
}

async function testHost(page: Page, input: string): Promise<string> {
	await page.getByTestId("egress-test-input").fill(input);
	await page.getByTestId("egress-test-run").click();
	const result = page.getByTestId("egress-test-result");
	await expect(result).toBeVisible();
	return (await result.getAttribute("data-reason")) ?? "";
}

test("the Network tab sits after Health and before Settings", async ({ page }) => {
	await reset();
	await open(page);
	const nav = page.getByRole("navigation", { name: "Administration" });
	await expect(nav.getByRole("link")).toHaveText([
		"Users",
		"Audit",
		"Logs",
		"Health",
		"Network",
		"Backups",
		"Settings",
	]);
	await expect(page).toHaveTitle(/Network, Administration/);
	await expect(
		page.getByRole("heading", { level: 2, name: "Network", exact: true }),
	).toBeVisible();
});

test("switching mode asks first, and the applied status follows", async ({ page }) => {
	await reset();
	await open(page);
	const status = page.getByTestId("egress-apply-status");
	await expect(status).toContainText("Applied just now");
	await expect(page.getByTestId("egress-mode-open")).toHaveAttribute(
		"aria-pressed",
		"true",
	);

	await page.getByTestId("egress-mode-allow-list").click();
	const dialog = page.getByTestId("egress-mode-dialog");
	// The a11y spec may list its own host meanwhile, so the count is not fixed.
	await expect(dialog).toContainText(
		/Nothing is listed yet|Workspaces will reach only the \d+ hosts? and \d+ ranges? listed/,
	);
	await expect(dialog).toContainText('"Could not resolve host"');
	await dialog.getByRole("button", { name: "Cancel" }).click();
	await expect(dialog).toBeHidden();
	await expect(page.getByTestId("egress-mode-open")).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(page.getByTestId("egress-mode-allow-list")).toBeFocused();

	await page.getByTestId("egress-mode-allow-list").click();
	await dialog.getByRole("button", { name: "Switch to allow-list" }).click();
	await expect(dialog).toBeHidden();
	await expect(page.getByTestId("egress-mode-allow-list")).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(status).toHaveAttribute("data-tone", "pending");
	await expect(status).toContainText("Applying");

	// The worker applies it; the tab polls while a change is pending.
	await markApplied();
	await expect(status).toContainText("Applied just now");

	await query(
		"update settings set egress_apply_error = 'nft refused the table.' where id = 1",
	);
	await page.reload();
	await expect(status).toHaveAttribute("data-tone", "error");
	await expect(status).toContainText(
		"The last change could not be applied: nft refused the table.",
	);

	await page.getByTestId("egress-mode-open").click();
	await expect(dialog).toContainText("Your presets and list are kept");
	await dialog.getByRole("button", { name: "Switch to open" }).click();
	await expect(page.getByTestId("egress-mode-open")).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	const audit = await query<{ n: number }>(
		"select count(*)::int as n from audit_events where action = 'egress.mode_changed' and at > now() - interval '1 minute'",
	);
	expect(audit[0]?.n).toBeGreaterThanOrEqual(2);
});

test("each preset turns on, shows its sites, and allows them", async ({ page }) => {
	await reset("allow-list");
	await open(page);
	for (const preset of EGRESS_PRESETS) {
		const card = page.getByTestId(`egress-preset-${preset.id}`);
		const n = preset.hosts.length;
		// The summary also carries the preset's name for screen readers.
		const summary = card.locator("summary");
		await expect(summary).toHaveText(
			`${preset.label}: ${n} ${n === 1 ? "site" : "sites"}`,
		);
		await summary.click();
		for (const host of preset.hosts)
			await expect(card.getByText(host, { exact: true })).toBeVisible();
		expect(await testHost(page, `www.${preset.hosts[0]}`)).toBe("not-listed");
		await card.getByText(preset.label, { exact: true }).click();
		await expect(card).toHaveAttribute("data-on", "true");
		expect(await testHost(page, `www.${preset.hosts[0]}`)).toBe("preset");
		await expect(page.getByTestId("egress-test-result")).toContainText(
			`Allowed by the ${preset.label} preset`,
		);
	}
	const saved = await query<{ egress_presets: string[] }>(
		"select egress_presets from settings where id = 1",
	);
	expect(saved[0]?.egress_presets).toEqual(EGRESS_PRESETS.map((p) => p.id));

	const github = page.getByTestId("egress-preset-github");
	await github.getByText("GitHub", { exact: true }).click();
	await expect(github).toHaveAttribute("data-on", "false");
	await page.reload();
	await expect(page.getByTestId("egress-preset-github")).toHaveAttribute(
		"data-on",
		"false",
	);
	await expect(page.getByTestId("egress-preset-gitlab")).toHaveAttribute(
		"data-on",
		"true",
	);
});

test("hosts and ranges are added, edited and removed, with validation", async ({
	page,
}) => {
	await reset("allow-list");
	await open(page);
	const dialog = page.getByTestId("egress-entry-dialog");
	const value = dialog.getByTestId("egress-entry-value");

	await page.getByTestId("egress-add").click();
	await dialog.getByTestId("egress-entry-save").click();
	await expect(dialog.getByRole("alert")).toHaveText("Enter a host name.");
	await value.fill(`https://api.${SUFFIX}/v1`);
	await expect(dialog.getByRole("alert")).toContainText(
		"Enter a host name such as github.com",
	);
	await value.fill(`*.${SUFFIX}`);
	await expect(value).toHaveAttribute("aria-invalid", "true");
	await value.fill(`api.${SUFFIX}`);
	await expect(dialog.getByRole("alert")).toHaveCount(0);
	await dialog.getByTestId("egress-entry-label").fill("Course API");
	await dialog.getByTestId("egress-entry-save").click();
	await expect(dialog).toBeHidden();

	const rows = page.getByTestId("egress-entry-row");
	await expect(rows.filter({ hasText: `api.${SUFFIX}` })).toContainText("Course API");

	// A range, with the private-range refusal first.
	await page.getByTestId("egress-add").click();
	await dialog.getByTestId("egress-kind-range").check();
	await value.fill("10.1.0.0/16");
	await dialog.getByTestId("egress-entry-save").click();
	await expect(dialog.getByRole("alert")).toContainText(
		"overlaps the private range 10.0.0.0/8",
	);
	await value.fill("203.0.113.5/24");
	await expect(dialog.getByRole("alert")).toContainText("no host bits set");
	await value.fill(RANGES[0] as string);
	await value.press("Enter");
	await expect(dialog).toBeHidden();
	await expect(rows.filter({ hasText: RANGES[0] as string })).toContainText("range");

	// A duplicate is refused by the API, inside the dialog.
	await page.getByTestId("egress-add").click();
	await value.fill(`API.${SUFFIX}`);
	await dialog.getByTestId("egress-entry-save").click();
	await expect(dialog.getByTestId("egress-entry-error")).toHaveText(
		"That entry is already listed",
	);
	await dialog.getByRole("button", { name: "Cancel" }).click();

	await page.getByRole("button", { name: `Edit api.${SUFFIX}` }).click();
	await expect(value).toHaveValue(`api.${SUFFIX}`);
	await dialog.getByTestId("egress-entry-label").fill("Course 101 API");
	await dialog.getByTestId("egress-entry-save").click();
	await expect(dialog).toBeHidden();
	await expect(rows.filter({ hasText: `api.${SUFFIX}` })).toContainText(
		"Course 101 API",
	);

	await page.getByRole("button", { name: `Remove ${RANGES[0]}` }).click();
	const confirm = page.getByTestId("egress-remove-dialog");
	await expect(confirm).toContainText("Workspaces stop reaching it");
	await confirm.getByRole("button", { name: "Cancel" }).click();
	await expect(rows.filter({ hasText: RANGES[0] as string })).toHaveCount(1);
	await page.getByRole("button", { name: `Remove ${RANGES[0]}` }).click();
	await confirm.getByRole("button", { name: "Remove" }).click();
	await expect(rows.filter({ hasText: RANGES[0] as string })).toHaveCount(0);
	// The removed row took its button with it, so focus lands on the card heading.
	await expect(
		page.getByRole("heading", { name: "Your hosts and ranges" }),
	).toBeFocused();
});

test("ports are checked and saved", async ({ page }) => {
	await reset("allow-list");
	await open(page);
	const field = page.getByTestId("egress-ports");
	await expect(field).toHaveValue("22, 80, 443");
	await field.fill("443, 99999");
	await page.getByTestId("egress-ports-save").click();
	await expect(page.getByRole("alert")).toContainText("99999 is not a port");
	await field.fill("443, 443");
	await field.press("Enter");
	await expect(page.getByRole("alert")).toContainText("Port 443 is listed twice.");
	await field.fill("8443 443 22");
	await field.press("Enter");
	await expect(field).toHaveValue("22, 443, 8443");
	await page.reload();
	await expect(page.getByTestId("egress-ports")).toHaveValue("22, 443, 8443");
});

test("Test a host explains every answer and can allow an unlisted name", async ({
	page,
}) => {
	await reset("allow-list");
	await query("update settings set egress_presets = '{github}' where id = 1");
	await query(
		"insert into egress_entries (kind, value, label) values ('host', $1, 'Course API'), ('range', $2, 'Lab')",
		[`api.${SUFFIX}`, RANGES[1]],
	);
	await open(page);
	const result = page.getByTestId("egress-test-result");

	expect(await testHost(page, "https://api.github.com/repos/x")).toBe("preset");
	await expect(result).toContainText(
		"Allowed by the GitHub preset, which lists github.com.",
	);
	expect(await testHost(page, `v2.api.${SUFFIX}`)).toBe("entry");
	await expect(result).toContainText(
		`Allowed by your entry api.${SUFFIX} (Course API).`,
	);
	expect(await testHost(page, "198.51.100.7")).toBe("range");
	await expect(result).toContainText("Allowed by your range 198.51.100.0/24 (Lab).");
	expect(await testHost(page, "192.168.1.1")).toBe("denied");
	await expect(result).toContainText("private range 192.168.0.0/16");
	expect(await testHost(page, "93.184.216.34")).toBe("address");
	await expect(result).toContainText("is an address");
	expect(await testHost(page, "no spaces allowed")).toBe("invalid");
	await expect(result).toContainText("not a host name");
	expect(await testHost(page, `docs.${SUFFIX}`)).toBe("not-listed");
	await expect(result).toContainText('"Could not resolve host"');

	await page.getByTestId("egress-test-allow").click();
	const dialog = page.getByTestId("egress-entry-dialog");
	await expect(dialog.getByTestId("egress-entry-value")).toHaveValue(`docs.${SUFFIX}`);
	await dialog.getByTestId("egress-entry-save").click();
	await expect(dialog).toBeHidden();
	await expect(result).toHaveAttribute("data-reason", "entry");
	await expect(page.getByRole("heading", { name: "Test a host" })).toBeFocused();

	await query("update settings set egress_mode = 'open' where id = 1");
	await page.reload();
	expect(await testHost(page, "example.org")).toBe("open");
	await expect(page.getByTestId("egress-test-result")).toContainText("Open mode is on");
});

test("a refused name is allowed from the blocked list", async ({ page }) => {
	await reset("allow-list");
	await query(
		`insert into egress_blocked_names (day, name, source, count)
		 values (current_date, $1, 'dns', 40), (current_date - 1, $1, 'tls', 2),
		        (current_date, $2, 'dns', 5)`,
		[`registry.${SUFFIX}`, `cdn.${SUFFIX}`],
	);
	await open(page);
	const row = page
		.getByTestId("egress-blocked-row")
		.filter({ hasText: `registry.${SUFFIX}` });
	await expect(row).toContainText("42");
	await row.getByRole("button", { name: `Allow registry.${SUFFIX}…` }).click();
	const dialog = page.getByTestId("egress-entry-dialog");
	await expect(dialog.getByTestId("egress-entry-value")).toHaveValue(
		`registry.${SUFFIX}`,
	);
	await dialog.getByTestId("egress-entry-label").fill("Package mirror");
	await dialog.getByTestId("egress-entry-save").click();
	await expect(dialog).toBeHidden();
	await expect(row).toContainText("Listed now");
	await expect(page.getByRole("heading", { name: "Refused names" })).toBeFocused();
	await expect(
		page.getByTestId("egress-entry-row").filter({ hasText: `registry.${SUFFIX}` }),
	).toContainText("Package mirror");
	await expect(
		page
			.getByTestId("egress-blocked-row")
			.filter({ hasText: `cdn.${SUFFIX}` })
			.getByRole("button"),
	).toBeVisible();
	await reset();
});
