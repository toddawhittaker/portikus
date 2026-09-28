import { type Browser, expect, type Page, test } from "@playwright/test";
import {
	createStudent,
	loginAs,
	query,
	settledAxe,
	type TestStudent,
	toast,
	WCAG_TAGS,
} from "./helpers";

/**
 * Per-workspace CPU, memory and process limits as the administrator sets
 * them (SPEC.md section 20.1), and the Limits dialog's accessibility
 * (SPEC.md section 25.8). The worker does not run here, so the test writes
 * `limits_applied` as the worker would once the controller has set the keys.
 */

const GIB = 1024 ** 3;

/**
 * A fixed Health report, so the site values do not depend on the samples
 * other specs write to the shared table. Incus spells 4 GB in powers of ten.
 */
const HEALTH = {
	sampledAt: new Date().toISOString(),
	workerStale: false,
	controller: { reachable: true, errorCode: null },
	host: {
		loadAverage: [0.5, 0.4, 0.3],
		cpuCount: 4,
		memory: { usedBytes: 4 * GIB, totalBytes: 16 * GIB },
		pool: { usedBytes: 40 * GIB, totalBytes: 100 * GIB, metadataPercent: 10 },
		profileLimits: { cpu: "2", memory: "4GiB", processes: "2000" },
		image: { fingerprint: null, serial: null },
	},
	workspacesByState: {},
	agents: { answering: 0, running: 0 },
	last24h: {
		startFailures: 0,
		stopFailures: 0,
		forcedStops: 0,
		provisionFailures: 0,
		controllerOutages: 0,
		signInFailures: 0,
		previewRefusals: 0,
	},
	guard: [],
};

const ALL_SITE =
	"2 CPUs (site value) · 4 GiB memory (site value) · 2,000 processes (site value)";

async function openAdmin(page: Page): Promise<void> {
	await page.route("**/admin/health", (route) => route.fulfill({ json: HEALTH }));
	await loginAs(page, "carol");
	await page.goto("/admin");
	await expect(page.getByTestId("admin-accounts")).toBeVisible({ timeout: 15_000 });
}

/** A student with a workspace, made in a context of its own so carol keeps her session. */
async function studentIn(browser: Browser): Promise<TestStudent & { name: string }> {
	const context = await browser.newContext();
	const student = await createStudent(context);
	await context.close();
	const name = `Limits ${student.userId.slice(0, 8)}`;
	await query("update users set display_name = $2 where id = $1", [
		student.userId,
		name,
	]);
	return { ...student, name };
}

async function openDetail(page: Page, name: string) {
	await page.getByTestId("admin-filter-text").fill(name);
	await page.getByRole("button", { name: `Show details for ${name}` }).click();
	const panel = page.getByRole("region", { name });
	await expect(panel.getByRole("region", { name: "Resources" })).toBeVisible();
	return panel;
}

async function expectNoViolations(page: Page) {
	const results = await (await settledAxe(page)).withTags(WCAG_TAGS).analyze();
	expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

test("an administrator sets limits, sees them pending, then applied", async ({
	page,
	browser,
}) => {
	const student = await studentIn(browser);
	await openAdmin(page);
	const panel = await openDetail(page, student.name);
	const limits = panel.getByTestId("detail-limits");
	await expect(limits).toHaveText(ALL_SITE);

	const open = panel.getByRole("button", {
		name: `Edit limits for ${student.name}'s workspace`,
	});
	await open.click();
	const dialog = page.getByRole("dialog", {
		name: `Limits for ${student.name}'s workspace`,
	});
	// Each blank field says what it falls back to (S4), memory in MiB and GiB (N6).
	await expect(dialog.getByLabel("Memory (MiB)")).toHaveAccessibleDescription(
		"Site value: 4,096 MiB (4 GiB). Below what the workspace uses now, the kernel stops its largest process.",
	);
	await expect(dialog.getByLabel("CPUs")).toHaveAccessibleDescription(
		"Site value: 2. At most the host's CPU count.",
	);
	await expect(dialog).toContainText("terminals keep their own limit of 1,700");

	// A value out of range is refused in the form and nothing is sent.
	await dialog.getByLabel("CPUs").fill("0");
	await dialog.getByTestId("limits-save").click();
	await expect(dialog.getByRole("alert")).toHaveText(
		"Enter a whole number from 1 to 64, or leave it blank.",
	);

	await dialog.getByLabel("CPUs").fill("3");
	await dialog.getByLabel("Memory (MiB)").fill("6144");
	await dialog.getByTestId("limits-save").click();
	await expect(toast(page, "Limits saved")).toBeVisible();
	await expect(dialog).toBeHidden();
	await expect(open).toBeFocused();

	await expect(limits).toHaveText(
		"3 CPUs · 6 GiB memory · 2,000 processes (site value)",
	);
	await expect(panel.getByTestId("detail-limits-pending")).toHaveText(
		"Limits saved. They take effect within a minute.",
	);

	const rows = await query<{ limits_config: unknown }>(
		"select limits_config from workspaces where id = $1",
		[student.workspaceId],
	);
	expect(rows[0]?.limits_config).toEqual({ cpu: 3, memoryMiB: 6144 });
	const audits = await query<{ action: string; metadata: unknown }>(
		"select action, metadata from audit_events where target = $1 and action = 'workspace.limits_updated'",
		[student.workspaceId],
	);
	expect(audits).toEqual([
		{
			action: "workspace.limits_updated",
			metadata: { from: {}, to: { cpu: 3, memoryMiB: 6144 } },
		},
	]);

	// What the worker records once the controller has set the keys.
	await query("update workspaces set limits_applied = limits_config where id = $1", [
		student.workspaceId,
	]);
	await expect(panel.getByTestId("detail-limits-pending")).toBeHidden({
		timeout: 15_000,
	});
});

test("blank fields return a workspace to the site limits", async ({
	page,
	browser,
}) => {
	const student = await studentIn(browser);
	await query(
		"update workspaces set limits_config = $2, limits_applied = $2 where id = $1",
		[student.workspaceId, JSON.stringify({ processes: 2000 })],
	);
	await openAdmin(page);
	const panel = await openDetail(page, student.name);
	await expect(panel.getByTestId("detail-limits")).toHaveText(
		"2 CPUs (site value) · 4 GiB memory (site value) · 2,000 processes",
	);
	await panel
		.getByRole("button", { name: `Edit limits for ${student.name}'s workspace` })
		.click();
	const dialog = page.getByRole("dialog", {
		name: `Limits for ${student.name}'s workspace`,
	});
	await expect(dialog.getByLabel("Processes")).toHaveValue("2000");
	await dialog.getByLabel("Processes").fill("");
	await dialog.getByTestId("limits-save").click();
	await expect(toast(page, "Limits saved")).toBeVisible();
	await expect(panel.getByTestId("detail-limits")).toHaveText(ALL_SITE);
	const rows = await query<{ limits_config: unknown }>(
		"select limits_config from workspaces where id = $1",
		[student.workspaceId],
	);
	expect(rows[0]?.limits_config).toBeNull();
});

for (const scheme of ["light", "dark"] as const) {
	test(`the Limits dialog has no automatic violations (${scheme})`, async ({
		page,
		browser,
	}) => {
		await page.emulateMedia({ colorScheme: scheme });
		const student = await studentIn(browser);
		await query("update workspaces set limits_config = $2 where id = $1", [
			student.workspaceId,
			JSON.stringify({ cpu: 2 }),
		]);
		await openAdmin(page);
		const panel = await openDetail(page, student.name);
		await expect(panel.getByTestId("detail-limits-pending")).toBeVisible();
		await expectNoViolations(page);

		await panel
			.getByRole("button", { name: `Edit limits for ${student.name}'s workspace` })
			.click();
		const dialog = page.getByRole("dialog", {
			name: `Limits for ${student.name}'s workspace`,
		});
		await dialog.getByLabel("Memory (MiB)").fill("1");
		await dialog.getByTestId("limits-save").click();
		await expect(dialog.getByRole("alert")).toBeVisible();
		await expectNoViolations(page);
	});
}
