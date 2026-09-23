/**
 * Storage figures and warnings (SPEC.md §18.3, §19.2, §28): the workspace
 * dialog lists the three classes, the status bar warns at 80% and names the
 * class, and at 95% the dialog says what to do next. The fake agent reports
 * whatever figures a test seeds for its workspace.
 */
import { expect, type Page, test } from "@playwright/test";
import { createStudent, seedStorage, workspacePath } from "./helpers";

const GIB = 1024 ** 3;
const percent = (value: number) => ({ usedBytes: value * GIB, totalBytes: 100 * GIB });

/** The WCAG 2 contrast ratio between two rgb() colours. */
function contrast(first: string, second: string): number {
	const luminance = (colour: string) => {
		const [r, g, b] = (colour.match(/[\d.]+/g) ?? []).slice(0, 3).map((part) => {
			const channel = Number(part) / 255;
			return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
		});
		return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
	};
	const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a);
	return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

/** The warning's text colour against the status bar behind it. */
async function warningContrast(page: Page): Promise<number> {
	const colours = await page.getByTestId("storage-warning").evaluate((node) => ({
		text: getComputedStyle(node).color,
		back: getComputedStyle(node.closest("footer") as Element).backgroundColor,
	}));
	return contrast(colours.text, colours.back);
}

test("the dialog lists Projects & home, Docker and Recovery", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await seedStorage(student.workspaceId, {
		home: percent(10),
		docker: percent(20),
		recovery: null,
	});
	await page.goto(workspacePath(student.workspaceId));

	await page.getByTestId("workspace-status").click();
	const dialog = page.getByTestId("dialog-workspace-status");
	await expect(dialog.getByTestId("storage-home")).toHaveText("10.0 GB of 100 GB");
	await expect(dialog.getByTestId("storage-docker")).toHaveText("20.0 GB of 100 GB");
	await expect(dialog.getByTestId("storage-recovery")).toHaveText("Not available");
	await expect(dialog).toContainText("Projects & home");
	await expect(page.getByTestId("storage-warning")).toHaveCount(0);
});

test("at 80% the status bar names Docker", async ({ page, context }) => {
	const student = await createStudent(context);
	await seedStorage(student.workspaceId, {
		docker: percent(80),
		recovery: percent(10),
	});
	await page.goto(workspacePath(student.workspaceId));

	const warning = page.getByTestId("storage-warning");
	await expect(warning).toHaveText("Docker storage is 80% full", { timeout: 15_000 });
	await expect(warning).toHaveAttribute("data-level", "warning");
	await expect(
		page.getByTestId("status-bar").getByRole("status").first(),
	).toBeAttached();
});

test("at 80% the status bar names Recovery", async ({ page, context }) => {
	const student = await createStudent(context);
	await seedStorage(student.workspaceId, { recovery: percent(84) });
	await page.goto(workspacePath(student.workspaceId));

	await expect(page.getByTestId("storage-warning")).toHaveText(
		"Recovery storage is 84% full",
		{ timeout: 15_000 },
	);
});

test("at 95% Docker is nearly full and the dialog suggests Reset Docker", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await seedStorage(student.workspaceId, { docker: percent(96) });
	await page.goto(workspacePath(student.workspaceId));

	const warning = page.getByTestId("storage-warning");
	await expect(warning).toHaveText("Docker storage is nearly full", {
		timeout: 15_000,
	});
	await expect(warning).toHaveAttribute("data-level", "critical");
	// The warning opens the workspace dialog, from the keyboard too.
	await warning.focus();
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("storage-warning-detail")).toContainText(
		"Reset Docker",
	);
	await page.keyboard.press("Escape");
	await expect(warning).toBeFocused();
});

test("at 95% Recovery is nearly full and the dialog says old points go automatically", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await seedStorage(student.workspaceId, { recovery: percent(99) });
	await page.goto(workspacePath(student.workspaceId));

	const warning = page.getByTestId("storage-warning");
	await expect(warning).toHaveText("Recovery storage is nearly full", {
		timeout: 15_000,
	});
	await warning.click();
	await expect(page.getByTestId("storage-warning-detail")).toContainText(
		"Older recovery points are removed automatically",
	);
});

for (const theme of ["light", "dark"] as const) {
	test(`the warnings pass 4.5:1 contrast in the ${theme} theme`, async ({
		page,
		context,
	}) => {
		await context.addInitScript((value) => {
			localStorage.setItem("pk-theme", value);
		}, theme);
		const student = await createStudent(context);
		await seedStorage(student.workspaceId, { docker: percent(85) });
		await page.goto(workspacePath(student.workspaceId));
		await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
		await expect(page.getByTestId("storage-warning")).toBeVisible({ timeout: 15_000 });
		expect(await warningContrast(page)).toBeGreaterThanOrEqual(4.5);

		await seedStorage(student.workspaceId, { docker: percent(97) });
		await page.reload();
		await expect(page.getByTestId("storage-warning")).toHaveAttribute(
			"data-level",
			"critical",
			{ timeout: 15_000 },
		);
		expect(await warningContrast(page)).toBeGreaterThanOrEqual(4.5);
	});
}
