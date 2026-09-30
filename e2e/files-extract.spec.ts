import { crc32 } from "node:zlib";
import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	readSeededFile,
	seedFile,
	settledAxe,
	toast,
	WCAG_TAGS,
	workspacePath,
} from "./helpers";

/**
 * "Extract here" in the Files pane (issue #817; SPEC.md §11.1, §11.2). A
 * student uploads a zip, extracts it, and sees its files in the tree; a
 * taken folder name gets a number, and an unsafe zip is explained.
 */

/** A stored zip holding the given files, written by hand. */
function zipOf(files: Record<string, string>): Buffer {
	const parts: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const [path, text] of Object.entries(files)) {
		const name = Buffer.from(path);
		const data = Buffer.from(text);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4);
		local.writeUInt32LE(crc32(data), 14);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(data.length, 22);
		local.writeUInt16LE(name.length, 26);
		const entry = Buffer.alloc(46);
		entry.writeUInt32LE(0x02014b50, 0);
		entry.writeUInt16LE(20, 4);
		entry.writeUInt16LE(20, 6);
		entry.writeUInt32LE(crc32(data), 16);
		entry.writeUInt32LE(data.length, 20);
		entry.writeUInt32LE(data.length, 24);
		entry.writeUInt16LE(name.length, 28);
		entry.writeUInt32LE(offset, 42);
		parts.push(local, name, data);
		central.push(entry, name);
		offset += 30 + name.length + data.length;
	}
	const directory = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(Object.keys(files).length, 8);
	end.writeUInt16LE(Object.keys(files).length, 10);
	end.writeUInt32LE(directory.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...parts, directory, end]);
}

/**
 * Holds the extract request until the returned function is called, so a test
 * can look at the progress toast while the zip is still being unpacked.
 */
async function holdExtract(page: Page): Promise<() => void> {
	let release = () => {};
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route("**/extract", async (route) => {
		await released;
		await route.continue();
	});
	return release;
}

/** A project with a zip uploaded into its root, ready to extract. */
async function withUploadedZip(page: Page, context: BrowserContext) {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Starter" });
	await seedFile(student.workspaceId, project.slug, "README.md", "# hi\n");
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(page.getByTestId("file-tree")).toBeVisible({ timeout: 15_000 });
	await page.getByTestId("files-upload-input").setInputFiles({
		name: "starter.zip",
		mimeType: "application/zip",
		buffer: zipOf({ "README.md": "# starter\n" }),
	});
	await expect(page.getByTestId("file-row-starter.zip")).toBeVisible();
}

async function expectNoViolations(page: Page) {
	const results = await (await settledAxe(page)).withTags(WCAG_TAGS).analyze();
	expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

test.describe("extract here", () => {
	test("the progress toast stays while a slow zip extracts, then gives way to the result", async ({
		page,
		context,
	}) => {
		await withUploadedZip(page, context);
		const release = await holdExtract(page);
		await page.getByTestId("file-menu-starter.zip").click();
		await page.getByTestId("row-extract-starter.zip").click();

		const progress = toast(page, "Extracting starter.zip…");
		await expect(progress).toBeVisible();
		// Longer than a neutral toast's five seconds (SPEC.md section 8.5).
		await page.waitForTimeout(6000);
		await expect(progress).toBeVisible();

		release();
		await expect(toast(page, "Extracted starter.zip into starter")).toBeVisible();
		await expect(progress).toHaveCount(0);
	});

	for (const scheme of ["light", "dark"] as const) {
		test(`the extract toasts have no automatic accessibility violations (${scheme})`, async ({
			page,
			context,
		}) => {
			await page.emulateMedia({ colorScheme: scheme });
			await withUploadedZip(page, context);
			const release = await holdExtract(page);
			await page.getByTestId("file-menu-starter.zip").click();
			await page.getByTestId("row-extract-starter.zip").click();
			await expect(toast(page, "Extracting starter.zip…")).toBeVisible();
			await expectNoViolations(page);

			release();
			await expect(toast(page, "Extracted starter.zip into starter")).toBeVisible();
			await expectNoViolations(page);
		});
	}

	test("an uploaded zip extracts into a new folder shown in the tree", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, { name: "Starter" });
		// A folder already has the zip's name, so the new one gets a number.
		await seedFile(student.workspaceId, project.slug, "starter/mine.txt", "mine\n");
		await page.goto(workspacePath(student.workspaceId, project.id));
		await expect(page.getByTestId("file-tree")).toBeVisible({ timeout: 15_000 });

		await page.getByTestId("files-upload-input").setInputFiles({
			name: "starter.zip",
			mimeType: "application/zip",
			buffer: zipOf({ "README.md": "# starter\n", "src/app.js": "console.log(1);\n" }),
		});
		await expect(page.getByTestId("file-row-starter.zip")).toBeVisible();

		await page.getByTestId("file-menu-starter.zip").click();
		await page.getByTestId("row-extract-starter.zip").click();

		await expect(toast(page, "Extracted starter.zip into starter-2")).toBeVisible();
		await expect(page.getByTestId("file-row-starter-2/README.md")).toBeVisible();
		await page.getByTestId("file-row-starter-2/src").click();
		await expect(page.getByTestId("file-row-starter-2/src/app.js")).toBeVisible();
		expect(
			await readSeededFile(student.workspaceId, project.slug, "starter-2/src/app.js"),
		).toBe("console.log(1);\n");
		expect(
			await readSeededFile(student.workspaceId, project.slug, "starter/mine.txt"),
		).toBe("mine\n");
	});

	test("a zip with an entry that leaves its folder is refused in plain words", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, { name: "Hostile" });
		await seedFile(student.workspaceId, project.slug, "README.md", "# hi\n");
		await page.goto(workspacePath(student.workspaceId, project.id));
		await expect(page.getByTestId("file-tree")).toBeVisible({ timeout: 15_000 });

		await page.getByTestId("files-upload-input").setInputFiles({
			name: "evil.zip",
			mimeType: "application/zip",
			buffer: zipOf({ "../../etc/passwd": "x\n" }),
		});
		await page.getByTestId("file-menu-evil.zip").click();
		await page.getByTestId("row-extract-evil.zip").click();

		const refused = toast(page, "evil.zip was not extracted");
		await expect(refused).toBeVisible();
		await expect(refused).toContainText("would land outside its folder");
		await expect(page.getByTestId("file-row-evil")).toHaveCount(0);
	});
});
