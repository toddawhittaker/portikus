/**
 * The storage meters pass the shared WCAG scan in both themes, in the
 * student's workspace dialog and in the administrator's Resources section,
 * with one class past the warning level and one critical (SPEC.md §19.2,
 * §25.8). Each meter is named by its visible label, and the critical one is
 * described by the next step written under it.
 */
import { expect, test } from "@playwright/test";
import {
	createStudent,
	expectNoViolations,
	openAdmin,
	openDetail,
	seedStorage,
	studentIn,
	workspacePath,
} from "./helpers";

const GIB = 1024 ** 3;
const percent = (value: number) => ({ usedBytes: value * GIB, totalBytes: 100 * GIB });
const FIGURES = { home: percent(85), docker: percent(96), recovery: percent(10) };

for (const theme of ["light", "dark"] as const) {
	test(`the workspace dialog's meters pass axe in the ${theme} theme`, async ({
		page,
		context,
	}) => {
		await context.addInitScript((value) => {
			localStorage.setItem("pk-theme", value);
		}, theme);
		const student = await createStudent(context);
		await seedStorage(student.workspaceId, FIGURES);
		await page.goto(workspacePath(student.workspaceId));
		await expect(page.locator("html")).toHaveAttribute("data-theme", theme);

		await page.getByTestId("workspace-status").click();
		const dialog = page.getByTestId("dialog-workspace-status");
		await expect(dialog.getByTestId("storage-meter-home")).toHaveAttribute(
			"data-level",
			"warning",
		);
		await expect(dialog.getByTestId("storage-meter-docker")).toHaveAttribute(
			"data-level",
			"critical",
		);
		const docker = dialog.getByRole("meter", { name: "Docker", exact: true });
		await expect(docker).toHaveAccessibleDescription(
			"Use Reset Docker in the workspace dialog, or run docker system prune.",
		);
		await expect(
			dialog.getByRole("meter", { name: "Projects and home", exact: true }),
		).toHaveAccessibleDescription("");

		await expectNoViolations(page, '[data-testid="dialog-workspace-status"]');
	});

	test(`the admin Resources section's meters pass axe in the ${theme} theme`, async ({
		page,
		context,
		browser,
	}) => {
		await context.addInitScript((value) => {
			localStorage.setItem("pk-theme", value);
		}, theme);
		const student = await studentIn(browser, "Meters");
		await seedStorage(student.workspaceId, FIGURES);
		await openAdmin(page);
		await expect(page.locator("html")).toHaveAttribute("data-theme", theme);

		const panel = await openDetail(page, student.name, "Resources");
		const resources = panel.getByRole("region", { name: "Resources" });
		await expect(resources.getByTestId("storage-meter-docker")).toHaveAttribute(
			"data-level",
			"critical",
		);
		// The administrator reads what they can do, not the student's step.
		const step = `Close to the limit. Raise it with Edit quotas, or ask ${student.name} to reset Docker.`;
		await expect(resources.getByTestId("storage-step-docker")).toHaveText(step);
		await expect(
			resources.getByRole("meter", { name: "Docker", exact: true }),
		).toHaveAccessibleDescription(step);

		await expectNoViolations(page, '[aria-labelledby="detail-resources"]');
	});
}

// Value texts of very different widths: a short one, a long one with "nearly
// full", and a four-digit size.
const UNEVEN_FIGURES = {
	home: { usedBytes: Math.round(4.1 * GIB), totalBytes: 20 * GIB },
	docker: { usedBytes: 96 * GIB, totalBytes: 100 * GIB },
	recovery: { usedBytes: 512 * GIB, totalBytes: 1000 * GIB },
};

for (const theme of ["light", "dark"] as const) {
	for (const [name, width] of [
		["default", 1280],
		["narrow", 320],
	] as const) {
		test(`the three storage bars are the same length whatever their value text (${theme}, ${name})`, async ({
			page,
			context,
		}) => {
			await context.addInitScript((value) => {
				localStorage.setItem("pk-theme", value);
			}, theme);
			const student = await createStudent(context);
			await seedStorage(student.workspaceId, UNEVEN_FIGURES);
			await page.setViewportSize({ width, height: 900 });
			await page.goto(workspacePath(student.workspaceId));
			await page.getByTestId("workspace-status").click();
			const dialog = page.getByTestId("dialog-workspace-status");
			const bars = dialog.locator('[data-testid="storage-meters"] meter');
			await expect(bars).toHaveCount(3);
			const widths = await bars.evaluateAll((nodes) =>
				nodes.map((node) => node.getBoundingClientRect().width),
			);
			expect(widths.every((w) => w > 0)).toBe(true);
			for (const w of widths)
				expect(Math.abs(w - (widths[0] as number))).toBeLessThan(0.5);
			await page.screenshot({
				path: `screenshots/storage-meters-${theme}-${name}.png`,
			});
		});
	}
}
