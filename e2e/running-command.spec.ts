import { expect, type Page, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	query,
	seedListening,
	settledAxe,
	workspacePath,
} from "./helpers";

/**
 * The Running tab's "Show the full command" disclosure (SPEC.md §18.2,
 * §24.11). Only the student's own listener has a command line;
 * a Docker row never has the button, even when a command line arrives.
 */
const LONG = "node server.js --port 3000 --host 0.0.0.0 --config ./config/dev.json";

async function openRunning(page: Page, workspaceId: string, projectId: string) {
	await page.goto(workspacePath(workspaceId, projectId));
	await expect(page.getByTestId("work-tabs")).toBeVisible({ timeout: 15_000 });
	await page.getByTestId("right-pane-tab-running").click();
	await expect(page.getByTestId("running-row-3000")).toBeVisible({ timeout: 20_000 });
}

for (const theme of ["light", "dark"] as const) {
	test(`a student's listener reveals its full command (${theme})`, async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await query(
			"update users set editor_settings = editor_settings || $1::jsonb where id = $2",
			[JSON.stringify({ appearance: theme }), student.userId],
		);
		await seedListening(student.workspaceId, [
			{ port: 3000, process: { pid: 7, command: "node", commandLine: LONG } },
			{
				port: 8080,
				process: {
					pid: 9,
					command: "docker-proxy",
					commandLine: "docker-proxy -proto tcp -host-port 8080 -container-port 5432",
				},
				container: { id: "abc", name: "postgres" },
			},
		]);
		const project = await createProject(student.workspaceId, { name: "cmd" });
		await openRunning(page, student.workspaceId, project.id);
		await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
		// A short name keeps its floor and is never cut to "no…".
		const nameCell = page.getByTestId("running-row-3000").locator(".pk-portrow-name");
		await expect(nameCell).toHaveText("node");
		expect(
			await nameCell.evaluate((element) => element.scrollWidth <= element.clientWidth),
		).toBe(true);

		await expect(
			page.getByRole("button", { name: "Show the full command for port 8080" }),
		).toHaveCount(0);
		const toggle = page.getByRole("button", {
			name: "Show the full command for port 3000",
		});
		await expect(toggle).toHaveAttribute("aria-expanded", "false");
		await toggle.focus();
		await page.keyboard.press("Enter");
		await expect(toggle).toHaveAttribute("aria-expanded", "true");
		const text = page.getByTestId("running-command-3000");
		await expect(text).toHaveText(LONG);
		await expect(text).toHaveCSS("white-space", "pre-wrap");
		// The text sits below the row's name, not beside it.
		const name = await page
			.getByTestId("running-row-3000")
			.locator(".pk-portrow-name")
			.boundingBox();
		const shown = await text.boundingBox();
		expect(shown?.y ?? 0).toBeGreaterThan(name?.y ?? 0);

		await page.screenshot({ path: `screenshots/running-command-${theme}.png` });
		const results = await (await settledAxe(page))
			.include("[data-testid='running-list']")
			.analyze();
		expect(results.violations).toEqual([]);

		await page.keyboard.press("Enter");
		await expect(text).toHaveCount(0);
	});
}
