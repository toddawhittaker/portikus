import { expect, type Locator, type Page, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	query,
	seedFile,
	type TestProject,
	workspacePath,
} from "./helpers";

/**
 * Check action colours (SPEC.md §18.1, issue #324). The play icon uses the
 * running status token and the stop icon the danger token, in both themes.
 * The accessible names stay "Run …" and "Stop …"; colour is extra.
 */
test.describe("check action colours", () => {
	test("play is the running green and stop is the danger red in both themes", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await openChecks(page, student.workspaceId, "Colours", {
			checks: [
				{ id: "tests", name: "Tests", command: "npm test" },
				{ id: "watch", name: "Watch", command: "sleep 120" },
			],
		});

		await chooseTheme(page, student.userId, "light");
		const lightRunning = await tokenColor(page, "--status-running");
		const lightDanger = await tokenColor(page, "--status-danger");
		await expectTint(page, "check-run-tests", "--status-running", "Run Tests");

		await page.getByTestId("check-run-watch").click();
		await expect(page.getByTestId("check-stop-watch")).toBeVisible({
			timeout: 15_000,
		});
		await expectTint(page, "check-stop-watch", "--status-danger", "Stop Watch");

		await chooseTheme(page, student.userId, "dark");
		// The same token names must resolve to the other theme, not the light values.
		expect(await tokenColor(page, "--status-running")).not.toBe(lightRunning);
		expect(await tokenColor(page, "--status-danger")).not.toBe(lightDanger);
		await expectTint(page, "check-run-tests", "--status-running", "Run Tests");
		await expectTint(page, "check-stop-watch", "--status-danger", "Stop Watch");
	});
});

/** Open a project's Checks pane with the given checks file. */
async function openChecks(
	page: Page,
	workspaceId: string,
	name: string,
	file: unknown,
): Promise<TestProject> {
	const project = await createProject(workspaceId, { name });
	await seedFile(workspaceId, project.slug, "README.md", "# hello\n");
	await seedFile(
		workspaceId,
		project.slug,
		".portikus/checks.json",
		JSON.stringify(file, null, "\t"),
	);
	await page.goto(workspacePath(workspaceId, project.id));
	await expect(page.getByTestId("right-pane-tab-checks")).toBeVisible({
		timeout: 15_000,
	});
	await page.getByTestId("right-pane-tab-checks").click();
	return project;
}

/**
 * Save Light or Dark as the student's appearance and reload. The Settings
 * dialog is not involved; appearance.spec.ts covers it. A reload returns the
 * right pane to Files, so Checks is opened again.
 */
async function chooseTheme(
	page: Page,
	userId: string,
	theme: "light" | "dark",
): Promise<void> {
	await query(
		"update users set editor_settings = editor_settings || $1::jsonb where id = $2",
		[JSON.stringify({ appearance: theme }), userId],
	);
	await page.reload();
	await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
	const tab = page.getByTestId("right-pane-tab-checks");
	await expect(tab).toBeVisible({ timeout: 15_000 });
	await tab.click();
}

/**
 * The icon's used colour matches the status token, at rest and while hovered,
 * and the button keeps the name a screen reader already has. Polling waits
 * out a paint that has not settled yet.
 */
async function expectTint(
	page: Page,
	testId: string,
	token: "--status-running" | "--status-danger",
	name: string,
): Promise<void> {
	const button = page.getByTestId(testId);
	await expect(button).toBeVisible();
	await expect(button).toHaveAttribute("aria-label", name);
	const expected = await tokenColor(page, token);
	// Leave whatever the pointer was over, so the first read is really at rest.
	await page.mouse.move(0, 0);
	await expect.poll(() => iconColor(button)).toBe(expected);
	await button.hover();
	await expect.poll(() => iconColor(button)).toBe(expected);
}

/** The colour the icon is painted with. The stroke is currentColor. */
async function iconColor(button: Locator): Promise<string> {
	return button.locator("svg").evaluate((element) => {
		const style = getComputedStyle(element);
		const stroke = style.stroke.toLowerCase();
		if (stroke === "" || stroke === "none" || stroke === "currentcolor") {
			return style.color;
		}
		return style.stroke;
	});
}

/** Resolve a theme token to the same rgb form the icon's colour uses. */
async function tokenColor(page: Page, token: string): Promise<string> {
	return page.evaluate((name) => {
		const probe = document.createElement("span");
		probe.style.color = `var(${name})`;
		document.body.append(probe);
		const color = getComputedStyle(probe).color;
		probe.remove();
		return color;
	}, token);
}
