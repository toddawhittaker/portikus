import { deflateSync } from "node:zlib";
import { expect, test } from "@playwright/test";
import { MAX_EDITOR_FILE_BYTES } from "../packages/contracts/src/files.ts";
import {
	createProject,
	createStudent,
	query,
	readSeededFile,
	seedFile,
	settledAxe,
	WCAG_TAGS,
	workspacePath,
} from "./helpers";

// e2e cannot import @portikus/contracts; this is past its MAX_TREE_ENTRIES page.
const PAST_ONE_PAGE = 2003;

/** Seed in batches, so the fake agent is not sent thousands of requests at once. */
async function seedAll(
	workspaceId: string,
	slug: string,
	paths: string[],
	content = "",
) {
	for (let start = 0; start < paths.length; start += 200) {
		await Promise.all(
			paths
				.slice(start, start + 200)
				.map((path) => seedFile(workspaceId, slug, path, content)),
		);
	}
}

/** Two folders' worth of listing pages: both places that read a listing read all of it (SPEC.md §11.2). */
test.describe("folders past one listing page", () => {
	test("Move to reaches a folder on the second page", async ({ page, context }) => {
		// Seeding 2,003 folders is slow on a shared runner.
		test.setTimeout(150_000);
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, { name: "Move Many" });
		const folders = Array.from(
			{ length: PAST_ONE_PAGE },
			(_, index) => `d${String(index).padStart(5, "0")}`,
		);
		await seedAll(
			student.workspaceId,
			project.slug,
			folders.map((name) => `pics/${name}/keep.txt`),
		);
		await seedFile(student.workspaceId, project.slug, "note.txt", "hi\n");
		await page.goto(workspacePath(student.workspaceId, project.id));
		await expect(page.getByTestId("file-tree")).toBeVisible({ timeout: 15_000 });

		await page.getByTestId("file-row-note.txt").focus();
		await page.keyboard.press("Shift+F10");
		await page.getByTestId("row-move").click();
		const dialog = page.getByTestId("dialog-move-file");
		await dialog.getByTestId("move-folder-pics").click();
		await expect(dialog.getByTestId("move-destination")).toContainText("/pics");

		// The first page of folders, then the row that loads the rest.
		await expect(dialog.getByTestId("move-folder-pics/d00000")).toBeVisible();
		await expect(dialog.getByTestId("move-folder-pics/d02002")).toHaveCount(0);
		const more = dialog.getByRole("button", { name: "Show more folders" });
		await expect(more).toBeVisible();
		await expect(dialog.getByRole("tree")).toHaveCount(0);
		const results = await (await settledAxe(page))
			.withTags(WCAG_TAGS)
			.include("[data-testid=dialog-move-file]")
			.analyze();
		expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);

		// Keyboard only: the button, Enter, and focus lands on the first new folder.
		await more.focus();
		await expect(more).toBeFocused();
		await page.keyboard.press("Enter");
		await expect(dialog.getByTestId("move-folder-pics/d02000")).toBeFocused();
		await expect(more).toHaveCount(0);

		await dialog.getByTestId("move-folder-pics/d02002").click();
		await expect(dialog.getByTestId("move-destination")).toContainText("/pics/d02002");
		await dialog.getByTestId("dialog-confirm").click();
		await expect(dialog).toHaveCount(0);
		await expect(page.getByTestId("file-row-note.txt")).toHaveCount(0);
		expect(
			await readSeededFile(student.workspaceId, project.slug, "pics/d02002/note.txt"),
		).toBe("hi\n");
	});

	test("a large image far down a long folder still carries its version", async ({
		page,
		context,
	}) => {
		test.setTimeout(150_000);
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, { name: "View Many" });
		const names = Array.from(
			{ length: PAST_ONE_PAGE },
			(_, index) => `f${String(index).padStart(5, "0")}.txt`,
		);
		await seedAll(
			student.workspaceId,
			project.slug,
			names.map((name) => `pics/${name}`),
		);
		// Past the editor limit, so its read has no etag and the listing
		// gives its address a version. It sorts after the 2,003 files above.
		await seedFile(student.workspaceId, project.slug, "pics/zz.png", bigPng());
		const path = "pics/zz.png";
		await query("update projects set layout = $2 where id = $1", [
			project.id,
			JSON.stringify({ tabs: [{ id: `file:${path}`, root: { type: "file", path } }] }),
		]);
		await page.goto(workspacePath(student.workspaceId, project.id));
		const image = page.getByRole("img", { name: "zz.png" });
		await expect(image).toBeVisible({ timeout: 30_000 });
		expect(await image.getAttribute("src")).toMatch(/[&?]v=\d+-\d+$/);
	});
});

/** A real PNG padded past the editor limit with a text chunk. */
function bigPng(): Buffer {
	const crc = (data: Buffer) => {
		let value = 0xffffffff;
		for (const byte of data) {
			value ^= byte;
			for (let bit = 0; bit < 8; bit += 1) {
				value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
			}
		}
		return (value ^ 0xffffffff) >>> 0;
	};
	const chunk = (type: string, data: Buffer) => {
		const length = Buffer.alloc(4);
		length.writeUInt32BE(data.length);
		const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
		const sum = Buffer.alloc(4);
		sum.writeUInt32BE(crc(body));
		return Buffer.concat([length, body, sum]);
	};
	const header = Buffer.alloc(13);
	header.writeUInt32BE(8, 0);
	header.writeUInt32BE(8, 4);
	header[8] = 8;
	header[9] = 2;
	const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(8 * 3, 0x7f)]);
	const pixels = Buffer.concat(Array.from({ length: 8 }, () => row));
	const pad = chunk(
		"tEXt",
		Buffer.concat([
			Buffer.from("pad\0"),
			Buffer.alloc(MAX_EDITOR_FILE_BYTES + 1000, 0x61),
		]),
	);
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(pixels)),
		pad,
		chunk("IEND", Buffer.alloc(0)),
	]);
}
