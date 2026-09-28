import { type Browser, expect, type Page, test } from "@playwright/test";
import {
	createStudent,
	loginAs,
	openToggletip,
	query,
	settledAxe,
	type TestStudent,
	toast,
	WCAG_TAGS,
} from "./helpers";

/**
 * Re-provision of a workspace stuck in `error` (SPEC.md section 20.1), and
 * its accessibility (SPEC.md section 25.8). The worker does not run here, so
 * the test leaves the row as a failed create would and checks that the
 * button sends it back to `provisioning`, audited.
 */

async function openAdmin(page: Page): Promise<void> {
	await loginAs(page, "carol");
	await page.goto("/admin");
	await expect(page.getByTestId("admin-accounts")).toBeVisible({ timeout: 15_000 });
}

/** A student whose workspace failed to create, made in its own context. */
async function failedStudent(
	browser: Browser,
): Promise<TestStudent & { name: string }> {
	const context = await browser.newContext();
	const student = await createStudent(context);
	await context.close();
	const name = `Reprovision ${student.userId.slice(0, 8)}`;
	await query("update users set display_name = $2 where id = $1", [
		student.userId,
		name,
	]);
	await query(
		`update workspaces
		    set state = 'error', error_code = 'OPERATION_FAILED',
		        error_message = 'The workspace could not be created.', updated_at = now()
		  where id = $1`,
		[student.workspaceId],
	);
	return { ...student, name };
}

async function openDetail(page: Page, name: string) {
	await page.getByTestId("admin-filter-text").fill(name);
	await page.getByRole("button", { name: `Show details for ${name}` }).click();
	const panel = page.getByRole("region", { name });
	await expect(panel.getByRole("region", { name: "Error" })).toBeVisible();
	return panel;
}

test("Re-provision sends a workspace in error back to provisioning, audited", async ({
	page,
	browser,
}) => {
	const student = await failedStudent(browser);
	await openAdmin(page);
	const panel = await openDetail(page, student.name);
	const error = panel.getByRole("region", { name: "Error" });
	// What Re-provision does is one click away, in its toggletip.
	await error.getByRole("button", { name: "About Re-provision" }).click();
	await expect(openToggletip(page)).toContainText(
		"Its home folder and files are kept.",
	);
	await page.keyboard.press("Escape");

	await error
		.getByRole("button", { name: `Re-provision ${student.name}'s workspace` })
		.click();
	await expect(toast(page, "Re-provision requested")).toBeVisible();
	// The error clears, the section goes, and focus lands on the panel heading.
	await expect(panel.getByRole("region", { name: "Error" })).toBeHidden();
	await expect(panel.getByRole("heading", { name: student.name })).toBeFocused();

	const rows = await query<{ state: string; error_code: string | null }>(
		"select state, error_code from workspaces where id = $1",
		[student.workspaceId],
	);
	expect(rows).toEqual([{ state: "provisioning", error_code: null }]);
	const audits = await query<{ actor: string }>(
		"select actor from audit_events where target = $1 and action = 'workspace.reprovision_requested'",
		[student.workspaceId],
	);
	expect(audits).toHaveLength(1);
	expect(audits[0]?.actor).toMatch(/^user:/);
});

test("a workspace not in error has no Re-provision button", async ({
	page,
	browser,
}) => {
	const student = await failedStudent(browser);
	// A full pool keeps the row provisioning with its reason shown (SPEC.md section 20.1).
	await query(
		"update workspaces set state = 'provisioning', error_code = 'POOL_FULL' where id = $1",
		[student.workspaceId],
	);
	await openAdmin(page);
	const panel = await openDetail(page, student.name);
	await expect(panel.getByTestId("detail-reprovision")).toHaveCount(0);
});

for (const scheme of ["light", "dark"] as const) {
	test(`the Error section with Re-provision has no automatic violations (${scheme})`, async ({
		page,
		browser,
	}) => {
		await page.emulateMedia({ colorScheme: scheme });
		const student = await failedStudent(browser);
		await openAdmin(page);
		const panel = await openDetail(page, student.name);
		await expect(panel.getByTestId("detail-reprovision")).toBeVisible();
		const results = await (await settledAxe(page)).withTags(WCAG_TAGS).analyze();
		expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
	});
}
