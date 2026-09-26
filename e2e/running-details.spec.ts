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

	test("a row shows a Preview button and keeps its tags under an untruncated name", async ({
		page,
		context,
	}) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		const student = await createStudent(context);
		await seedListening(student.workspaceId, [
			{
				port: 5173,
				process: { pid: 7, command: "node", commandLine: "node vite" },
			},
			{
				port: 8080,
				process: { pid: 9, command: "docker-proxy", commandLine: "docker-proxy" },
				container: { id: "abc", name: "postgres" },
			},
		]);
		const project = await createProject(student.workspaceId, { name: "rows" });
		await page.goto(workspacePath(student.workspaceId, project.id));
		await expect(page.getByTestId("work-tabs")).toBeVisible({ timeout: 15_000 });
		await page.getByTestId("right-pane-tab-running").click();

		// The Docker tag sits on its own line, so the name keeps its full width.
		const row = page.getByTestId("running-row-8080");
		await expect(row.getByText("Docker")).toBeVisible({ timeout: 20_000 });
		const name = row.locator(".pk-portrow-name");
		const clipped = await name.evaluate((el) => el.scrollWidth > el.clientWidth);
		expect(clipped).toBe(false);
		const nameBox = await name.boundingBox();
		const tagBox = await row.getByText("Docker").boundingBox();
		expect(tagBox && nameBox && tagBox.y >= nameBox.y + nameBox.height - 1).toBe(true);

		const preview = page.getByRole("button", { name: "Preview port 5173" });
		await expect(preview).toHaveText("Preview");
		await preview.click();
		await expect(page.getByTestId("preview-host")).toContainText("5173", {
			timeout: 20_000,
		});
	});
});
