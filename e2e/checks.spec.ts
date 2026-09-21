import { expect, type Page, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	readSeededFile,
	seedFile,
	type TestProject,
	workspacePath,
} from "./helpers";

/**
 * Project checks (SPEC.md §18.1): the commands `.portikus/checks.json`
 * configures, running them, seeing the real output in a read-only panel, and
 * editing the file from the browser. A project with no checks file stays
 * usable.
 */
test.describe("checks", () => {
	const CHECKS = {
		checks: [
			{ id: "tests", name: "Tests", command: "npm test" },
			{ id: "lint", name: "Lint", command: "npm run lint false" },
		],
	};

	/** Open a project's Checks pane, with the given checks file if any. */
	async function openChecks(
		page: Page,
		workspaceId: string,
		name: string,
		file?: unknown,
	): Promise<TestProject> {
		const project = await createProject(workspaceId, { name });
		await seedFile(workspaceId, project.slug, "README.md", "# hello\n");
		if (file !== undefined) {
			await seedFile(
				workspaceId,
				project.slug,
				".portikus/checks.json",
				JSON.stringify(file, null, "\t"),
			);
		}
		await page.goto(workspacePath(workspaceId, project.id));
		await expect(page.getByTestId("right-pane-tab-checks")).toBeVisible({
			timeout: 15_000,
		});
		await page.getByTestId("right-pane-tab-checks").click();
		return project;
	}

	test("a project with no checks file says so and offers to add one", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await openChecks(page, student.workspaceId, "Empty");

		await expect(page.getByText("No checks configured")).toBeVisible();
		await expect(page.getByTestId("checks-empty-edit")).toBeVisible();
		// The file tree is still right there: no checks file is not an error.
		await page.getByTestId("right-pane-tab-files").click();
		await expect(page.getByTestId("file-row-README.md")).toBeVisible();
	});

	test("configured checks show their real command", async ({ page, context }) => {
		const student = await createStudent(context);
		await openChecks(page, student.workspaceId, "Configured", CHECKS);

		await expect(page.getByTestId("checks-list")).toBeVisible();
		await expect(page.getByText("npm test")).toBeVisible();
		await expect(page.getByText("npm run lint false")).toBeVisible();
		await expect(page.getByTestId("check-state-tests")).toContainText("Not run yet");
	});

	test("a passing check shows Passed and its output", async ({ page, context }) => {
		const student = await createStudent(context);
		await openChecks(page, student.workspaceId, "Passing", CHECKS);

		await page.getByTestId("check-run-tests").click();

		await expect(page.getByTestId("check-state-tests")).toContainText("Passed", {
			timeout: 15_000,
		});
		const output = page.getByTestId("check-output-tests");
		await expect(output).toContainText("npm test", { timeout: 15_000 });
		await expect(output).toContainText("all tests passed");
		await expect(output).toContainText("exit code 0");
	});

	test("a failing check shows Failed and its exit code", async ({ page, context }) => {
		const student = await createStudent(context);
		await openChecks(page, student.workspaceId, "Failing", CHECKS);

		await page.getByTestId("check-run-lint").click();

		await expect(page.getByTestId("check-state-lint")).toContainText("Failed", {
			timeout: 15_000,
		});
		const output = page.getByTestId("check-output-lint");
		await expect(output).toContainText("1 test failed", { timeout: 15_000 });
		await expect(output).toContainText("exit code 1");
	});

	test("the edit dialog writes the checks file into the project", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await openChecks(page, student.workspaceId, "Editing");

		await page.getByTestId("checks-empty-edit").click();
		await expect(page.getByTestId("dialog-edit-checks")).toBeVisible();
		await page.getByTestId("check-name-0").fill("Unit tests");
		await page.getByTestId("check-command-0").fill("pytest -q");
		await page.getByTestId("dialog-confirm").click();

		await expect(page.getByTestId("dialog-edit-checks")).toHaveCount(0);
		await expect(page.getByTestId("checks-list")).toBeVisible();
		await expect(page.getByText("pytest -q")).toBeVisible();

		// The file really is in the project, where a student or agent can read it.
		const written = await readSeededFile(
			student.workspaceId,
			project.slug,
			".portikus/checks.json",
		);
		expect(JSON.parse(written)).toEqual({
			checks: [{ id: "unit-tests", name: "Unit tests", command: "pytest -q" }],
		});
	});

	test("an existing checks file can be added to from the dialog", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await openChecks(page, student.workspaceId, "Adding", {
			checks: [{ id: "tests", name: "Tests", command: "npm test" }],
		});

		await page.getByTestId("checks-edit").click();
		await page.getByTestId("check-add").click();
		await page.getByTestId("check-name-1").fill("Build");
		await page.getByTestId("check-command-1").fill("npm run build");
		await page.getByTestId("dialog-confirm").click();

		await expect(page.getByText("npm run build")).toBeVisible();
		const written = await readSeededFile(
			student.workspaceId,
			project.slug,
			".portikus/checks.json",
		);
		expect(JSON.parse(written).checks).toEqual([
			{ id: "tests", name: "Tests", command: "npm test" },
			{ id: "build", name: "Build", command: "npm run build" },
		]);
	});

	test("a check that keeps going can be stopped", async ({ page, context }) => {
		const student = await createStudent(context);
		await openChecks(page, student.workspaceId, "Stopping", {
			checks: [{ id: "watch", name: "Watch", command: "sleep 30" }],
		});

		await page.getByTestId("check-run-watch").click();
		await expect(page.getByTestId("check-state-watch")).toContainText("Running", {
			timeout: 15_000,
		});

		await page.getByTestId("check-stop-watch").click();
		await expect(page.getByTestId("check-state-watch")).toContainText("Failed", {
			timeout: 15_000,
		});
	});

	/** Issue #274: one neutral selection tone, never the green of a passed check. */
	test("the selected check is picked out in a neutral tone", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await openChecks(page, student.workspaceId, "Selecting", CHECKS);
		await expect(page.getByTestId("checks-list")).toBeVisible();

		await page.getByTestId("check-item-lint").getByText("npm run lint false").click();

		const selected = await rowBackground(page, "lint");
		const other = await rowBackground(page, "tests");
		expect(selected).not.toBe(other);
		// A warm neutral: red is never below green, so the row cannot read green.
		const [red, green, blue] = channels(selected);
		expect(red).toBeGreaterThanOrEqual(green);
		expect(green).toBeGreaterThanOrEqual(blue);
	});

	/** Issue #274: a long command must not push the Run button out of the pane. */
	test("a 120-character command leaves the Run button inside the pane", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const command = `docker run --rm -p 8080:80 --name bar-project ${"x".repeat(74)}`;
		expect(command).toHaveLength(120);
		await openChecks(page, student.workspaceId, "Overflowing", {
			checks: [{ id: "tests", name: "Tests", command }],
		});

		const button = page.getByTestId("check-run-tests");
		await expect(button).toBeVisible();
		const buttonBox = await button.boundingBox();
		const paneBox = await page.getByTestId("checks-list").boundingBox();
		if (!buttonBox || !paneBox) throw new Error("no box");
		expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(
			paneBox.x + paneBox.width + 1,
		);
		expect(buttonBox.x).toBeGreaterThanOrEqual(paneBox.x - 1);
	});
});

/** The computed background of one check's row. */
async function rowBackground(page: Page, checkId: string): Promise<string> {
	return await page
		.getByTestId(`check-item-${checkId}`)
		.locator(".pk-check-row")
		.evaluate((element) => getComputedStyle(element).backgroundColor);
}

/** The red, green and blue of a computed `rgb(...)` colour. */
function channels(colour: string): [number, number, number] {
	const parts = colour.match(/\d+/g) ?? [];
	return [Number(parts[0]), Number(parts[1]), Number(parts[2])];
}
