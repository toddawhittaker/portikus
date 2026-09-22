import { expect, test } from "@playwright/test";
import { createProject, createStudent, seedListening, workspacePath } from "./helpers";

/**
 * The details panel under a selected Running row (SPEC.md §18.2, issue #326).
 * Ports are seeded through the fake agent, the same way the preview tests do.
 */
test.describe("running details", () => {
	test("selecting a row shows what is holding the port", async ({ page, context }) => {
		const student = await createStudent(context);
		await seedListening(student.workspaceId, [
			{
				port: 3000,
				addresses: ["127.0.0.1"],
				process: {
					pid: 4242,
					command: "MainThread",
					commandLine: "python server.py",
				},
			},
			{
				port: 5173,
				process: { pid: 7, command: "node", commandLine: "node vite" },
			},
		]);
		const project = await createProject(student.workspaceId, { name: "running" });
		await page.goto(workspacePath(student.workspaceId, project.id));
		await expect(page.getByTestId("work-tabs")).toBeVisible({ timeout: 15_000 });
		await page.getByTestId("right-pane-tab-running").click();
		await page
			.getByTestId("running-row-3000")
			.locator("button.pk-portrow-select")
			.click({ timeout: 20_000 });

		const details = page.getByTestId("running-details");
		await expect(details).toBeVisible();
		await expect(details).toContainText("3000");
		await expect(details).toContainText("127.0.0.1");
		await expect(details).toContainText("4242");
		await expect(details).toContainText("MainThread");
		await expect(details).toContainText("python server.py");

		await page
			.getByTestId("running-row-5173")
			.locator("button.pk-portrow-select")
			.click();
		await expect(details).toContainText("node vite");
		await expect(details).not.toContainText("python server.py");

		await seedListening(student.workspaceId, []);
		await expect(page.getByTestId("running-row-5173")).toHaveCount(0, {
			timeout: 20_000,
		});
		await expect(details).toHaveCount(0);
	});
});
