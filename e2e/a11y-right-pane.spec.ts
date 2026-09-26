import { expect, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	loginAs,
	query,
	seedFile,
	seedListening,
	seedSearch,
	settledAxe,
	workspacePath,
} from "./helpers";

/**
 * Accessibility of the right pane, preview, search, admin and page titles
 * (SPEC.md §25.8; issues #363, #365, #371, #374).
 */
test.describe("right pane accessibility", () => {
	test("the pane switcher is one Tab stop the arrow keys walk", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, { name: "Arrow keys" });
		await page.goto(workspacePath(student.workspaceId, project.id));

		const files = page.getByRole("tab", { name: "Files" });
		await expect(files).toHaveAttribute("aria-selected", "true", { timeout: 15_000 });
		await files.focus();
		await page.keyboard.press("ArrowRight");

		const checks = page.getByRole("tab", { name: "Checks" });
		await expect(checks).toBeFocused();
		await expect(checks).toHaveAttribute("aria-selected", "true");
		await expect(page.getByRole("tabpanel", { name: "Checks" })).toBeVisible();

		await page.keyboard.press("End");
		await expect(page.getByRole("tab", { name: "Monitor" })).toBeFocused();
		await page.keyboard.press("Home");
		await expect(files).toBeFocused();
		await expect(page.getByRole("tabpanel", { name: "Files" })).toBeVisible();
	});

	test("a preview state is announced in a status region", async ({ page, context }) => {
		const student = await createStudent(context);
		// Nothing listens, so the saved preview tab opens inactive.
		await seedListening(student.workspaceId, []);
		const project = await createProject(student.workspaceId, { name: "Announced" });
		await query("update projects set layout = $2 where id = $1", [
			project.id,
			JSON.stringify({
				tabs: [{ id: "preview:5199", root: { type: "preview", port: 5199 } }],
			}),
		]);

		await page.goto(workspacePath(student.workspaceId, project.id));

		await expect(page.getByRole("status").filter({ hasText: "port 5199" })).toHaveText(
			"Nothing is running on port 5199",
			{ timeout: 20_000 },
		);
	});

	test("the search result count is announced in a status region", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, { name: "Counted" });
		await page.goto(workspacePath(student.workspaceId, project.id));
		await page.getByTestId("search-open").click();
		await seedSearch(student.workspaceId, project.slug, [
			{ path: "a.ts", line: 1, column: 1, text: "needle", before: [], after: [] },
			{ path: "b.ts", line: 2, column: 1, text: "needle", before: [], after: [] },
		]);

		await page.getByTestId("search-input").fill("needle");

		await expect(page.getByTestId("search-status")).toHaveText("2 matches in 2 files");
		await expect(page.getByTestId("search-status")).toHaveAttribute("role", "status");

		// Closing the search hands focus back to the button that opened it.
		await page.getByTestId("search-close").click();
		await expect(page.getByTestId("search-open")).toBeFocused();
	});

	test("the workspace tab is named after the project", async ({ page, context }) => {
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, { name: "Titled" });
		await page.goto(workspacePath(student.workspaceId, project.id));
		await expect(page).toHaveTitle("Titled, Portikus", { timeout: 15_000 });
	});
});

test.describe("right pane headings and panel contrast (Epic 20)", () => {
	test("each tab's pane has a screen-reader heading and no repeated visible title", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, { name: "Headings" });
		await page.goto(workspacePath(student.workspaceId, project.id));
		for (const name of ["Files", "Checks", "Running", "Monitor"]) {
			await page.getByRole("tab", { name }).click();
			const panel = page.getByRole("tabpanel", { name });
			const heading = panel.getByRole("heading", { level: 2, name, exact: true });
			await expect(heading).toHaveCount(1, { timeout: 15_000 });
			await expect(heading).toHaveClass("sr-only");
			await expect(panel.locator(".pk-pane-title")).toHaveCount(0);
		}
	});

	test("the Checks and Running panel heads pass contrast in the light theme", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await query(
			"update users set editor_settings = editor_settings || $1::jsonb where id = $2",
			[JSON.stringify({ appearance: "light" }), student.userId],
		);
		await seedListening(student.workspaceId, [
			{ port: 3000, process: { pid: 42, command: "node", commandLine: "node app" } },
		]);
		const project = await createProject(student.workspaceId, { name: "Contrast" });
		await seedFile(
			student.workspaceId,
			project.slug,
			".portikus/checks.json",
			JSON.stringify({ checks: [{ id: "tests", name: "Tests", command: "npm test" }] }),
		);
		await page.goto(workspacePath(student.workspaceId, project.id));
		await expect(page.locator("html")).toHaveAttribute("data-theme", "light", {
			timeout: 15_000,
		});

		await page.getByTestId("right-pane-tab-checks").click();
		await page.getByTestId("check-run-tests").click();
		await expect(page.locator(".pk-check-panel-head")).toBeVisible({ timeout: 15_000 });
		const checks = await (await settledAxe(page))
			.include(".pk-check-panel-head")
			.withRules(["color-contrast"])
			.analyze();
		expect(checks.violations).toEqual([]);

		await page.getByTestId("right-pane-tab-running").click();
		await page
			.getByTestId("running-row-3000")
			.locator("button.pk-portrow-select")
			.click({ timeout: 20_000 });
		await expect(page.locator(".pk-running-panel-head")).toBeVisible();
		const running = await (await settledAxe(page))
			.include(".pk-running-panel")
			.withRules(["color-contrast"])
			.analyze();
		expect(running.violations).toEqual([]);
	});
});

test.describe("admin and standalone page accessibility", () => {
	test("every admin user row has its own field and button names", async ({ page }) => {
		// Log alice in first, so the table has more than one row.
		await loginAs(page, "alice");
		await page.context().clearCookies();
		await loginAs(page, "carol");
		await page.goto("/admin");
		await expect(page).toHaveTitle("Administration, Portikus", { timeout: 15_000 });

		// Other tests add students with repeated names, so compare two known rows.
		// Each row's details button is named after its user (Epic 11).
		const table = page.getByTestId("admin-accounts");
		await expect(
			table.getByRole("button", { name: /^Show details for Carol Admin, / }),
		).toBeVisible();
		await table
			.getByRole("button", { name: /^Show details for Alice Student, / })
			.click();

		// The grace override moved into the detail panel and keeps its names.
		const panel = page.getByRole("region", { name: "Alice Student" });
		await expect(
			panel.getByRole("textbox", {
				name: "Grace period override (seconds)",
				exact: true,
			}),
		).toBeVisible();
		await expect(
			panel.getByRole("button", { name: "Save Alice Student", exact: true }),
		).toBeVisible();
	});

	test("the standalone pages have their own titles", async ({ page }) => {
		await page.goto("/");
		await expect(page).toHaveTitle("Sign in, Portikus", { timeout: 15_000 });
		await page.goto("/session-ended");
		await expect(page).toHaveTitle("Session ended, Portikus");
		await page.goto("/not-authorized");
		await expect(page).toHaveTitle("Not authorized, Portikus");
	});
});
