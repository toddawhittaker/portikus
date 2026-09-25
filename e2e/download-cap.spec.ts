import { expect, test } from "@playwright/test";
import { MAX_DOWNLOAD_BYTES } from "../packages/contracts/src/files.ts";
import {
	createProject,
	createStudent,
	seedFile,
	toast,
	workspacePath,
} from "./helpers";
import { FAKE_AGENT_URL } from "./ports";

/**
 * The download size cap (#399, docs/archive/epics/EPIC-12B.md "Part B decisions"). A download over
 * 1 GB is refused before anything is zipped, and the student is told the
 * limit and what to do instead, rather than seeing a failed download.
 */
test.describe("download size cap", () => {
	/** A file the fake agent reports as larger than the cap, without holding it. */
	async function seedHugeFile(workspaceId: string, slug: string, path: string) {
		const response = await fetch(`${FAKE_AGENT_URL}/__test/files`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				key: workspaceId,
				path: `${slug}/${path}`,
				content: "",
				apparentSize: MAX_DOWNLOAD_BYTES + 1,
			}),
		});
		expect(response.status).toBe(204);
	}

	const LIMIT = "Downloads are limited to 1 GB";
	const ADVICE = "Download a smaller folder, leave out node_modules, or use Git";

	test("a project over the cap shows the limit instead of downloading", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, { name: "Huge" });
		await seedFile(student.workspaceId, project.slug, "README.md", "# hi\n");
		await seedHugeFile(student.workspaceId, project.slug, "data/big.bin");
		await page.goto(workspacePath(student.workspaceId, project.id));

		let downloads = 0;
		page.on("download", () => {
			downloads += 1;
		});
		await page.getByTestId(`project-menu-${project.id}`).click();
		await page.getByTestId("project-download").click();

		await expect(toast(page, LIMIT)).toBeVisible();
		await expect(toast(page, LIMIT)).toContainText(ADVICE);
		expect(downloads).toBe(0);
	});

	test("a folder over the cap is refused, and a smaller one still downloads", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, { name: "Split" });
		await seedFile(student.workspaceId, project.slug, "src/app.ts", "x\n");
		await seedHugeFile(student.workspaceId, project.slug, "data/big.bin");
		await page.goto(workspacePath(student.workspaceId, project.id));
		await expect(page.getByTestId("file-tree")).toBeVisible({ timeout: 15_000 });

		await page.getByTestId("file-menu-data").click();
		await page.getByTestId("row-download-data").click();
		await expect(toast(page, LIMIT)).toContainText(ADVICE);

		const downloadPromise = page.waitForEvent("download");
		await page.getByTestId("file-menu-src").click();
		await page.getByTestId("row-download-src").click();
		expect((await downloadPromise).suggestedFilename()).toBe("src.zip");
	});

	test("a file tab's Download button over the cap shows the limit", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, { name: "Tab" });
		await seedHugeFile(student.workspaceId, project.slug, "data/big.bin");
		await page.goto(workspacePath(student.workspaceId, project.id));
		await page.getByTestId("file-row-data").click();
		await page.getByTestId("file-row-data/big.bin").click();
		await expect(page.getByText("This file is too large to edit here")).toBeVisible();

		let downloads = 0;
		page.on("download", () => {
			downloads += 1;
		});
		await page.getByRole("button", { name: "Download big.bin" }).press("Enter");

		await expect(toast(page, LIMIT)).toContainText(ADVICE);
		expect(downloads).toBe(0);
	});
});
