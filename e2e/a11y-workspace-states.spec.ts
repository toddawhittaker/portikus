/**
 * Automated accessibility checks (SPEC.md section 25.8) on the workspace
 * states a student sees before the work area: the storage-full error screen,
 * the stopped screen with its side panes, and the Workspace dialog with its
 * technical details open, each in the light and dark themes.
 */
import { expect, type Page, test } from "@playwright/test";
import {
	createStudent,
	query,
	seedStorage,
	settledAxe,
	WCAG_TAGS,
	workspacePath,
} from "./helpers";

async function expectNoViolations(page: Page) {
	const results = await (await settledAxe(page)).withTags(WCAG_TAGS).analyze();
	expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

const GIB = 1024 ** 3;

for (const scheme of ["light", "dark"] as const) {
	test(`the storage-full error screen and the Workspace dialog have no automatic violations (${scheme})`, async ({
		page,
		context,
	}) => {
		await page.emulateMedia({ colorScheme: scheme });
		const student = await createStudent(context);
		await query(
			`update workspaces
			    set state = 'error', error_code = 'STORAGE_FULL',
			        error_message = 'Your workspace could not start because its storage is full.',
			        updated_at = now()
			  where id = $1`,
			[student.workspaceId],
		);
		await seedStorage(student.workspaceId, {
			home: { usedBytes: 3 * GIB, totalBytes: 10 * GIB },
			docker: { usedBytes: 99 * GIB, totalBytes: 100 * GIB },
		});
		await page.goto(workspacePath(student.workspaceId));

		const progress = page.getByTestId("workspace-progress");
		await expect(progress.getByRole("button", { name: "Reset Docker…" })).toBeVisible({
			timeout: 15_000,
		});
		await progress.getByText("Technical details").click();
		await expect(progress.getByText("STORAGE_FULL")).toBeVisible();
		await expectNoViolations(page);

		await progress.getByRole("button", { name: "Workspace details" }).click();
		const dialog = page.getByTestId("dialog-workspace-status");
		await expect(dialog.getByRole("heading", { name: "Rebuilds" })).toBeVisible();
		await dialog.getByText("Technical details").click();
		await expect(dialog.getByTestId("workspace-status-image")).toBeVisible();
		await expectNoViolations(page);
	});

	test(`the stopped screen and its side panes have no automatic violations (${scheme})`, async ({
		page,
		context,
	}) => {
		await page.emulateMedia({ colorScheme: scheme });
		const student = await createStudent(context);
		await page.goto(workspacePath(student.workspaceId));
		await expect(page.getByTestId("workspace-state")).toHaveText("Running", {
			timeout: 15_000,
		});
		await query(
			"update workspaces set state = 'stopped', desired_state = 'stopped', updated_at = now() where id = $1",
			[student.workspaceId],
		);
		await expect(
			page.getByText("Start your workspace to see your projects"),
		).toBeVisible({ timeout: 15_000 });
		await expectNoViolations(page);
	});
}
