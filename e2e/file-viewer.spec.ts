import { deflateSync } from "node:zlib";
import { expect, test } from "@playwright/test";
import { MAX_EDITOR_FILE_BYTES } from "../packages/contracts/src/files.ts";
import {
	createProject,
	createStudent,
	expectNoViolations,
	openFileTab,
	pushEvent,
	query,
	seedFile,
	workspacePath,
} from "./helpers";
import { pdf } from "./pdf-fixture";

/**
 * The file tab shows images and PDFs instead of only offering a download,
 * and a Markdown preview shows the images its file points at by a relative
 * path (SPEC.md §13.2, §13.4). Student files are untrusted, so an SVG
 * must never run its script on the app's origin (SPEC.md §24.3).
 */

/** CRC-32 as PNG chunks need it. */
function crc32(data: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of data) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1) {
			crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
		}
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
	const length = Buffer.alloc(4);
	length.writeUInt32BE(data.length);
	const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
	const crc = Buffer.alloc(4);
	crc.writeUInt32BE(crc32(body));
	return Buffer.concat([length, body, crc]);
}

/** A real PNG of one colour, so the browser decodes it and reports its size. */
function png(width: number, height: number, rgb: [number, number, number]): Buffer {
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8; // bit depth
	header[9] = 2; // truecolour
	const row = Buffer.concat([
		Buffer.from([0]),
		Buffer.from(Array(width).fill(rgb).flat()),
	]);
	const pixels = Buffer.concat(Array.from({ length: height }, () => row));
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(pixels)),
		chunk("IEND", Buffer.alloc(0)),
	]);
}

/**
 * A real PNG padded past the editor limit with a text chunk, so its read
 * comes back too large and carries no etag. `extra` changes its size.
 */
function bigPng(width: number, height: number, extra: number): Buffer {
	const plain = png(width, height, [47, 125, 109]);
	const end = plain.length - 12;
	const pad = chunk(
		"tEXt",
		Buffer.concat([
			Buffer.from("pad\0"),
			Buffer.alloc(MAX_EDITOR_FILE_BYTES + extra, 0x61),
		]),
	);
	return Buffer.concat([plain.subarray(0, end), pad, plain.subarray(end)]);
}

/** An SVG that would set a flag on the page if any of its script ran. */
const HOSTILE_SVG = [
	'<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80" onload="top.svgRan = true">',
	'<rect width="120" height="80" fill="#2f7d6d"/>',
	"<script>top.svgRan = true; parent.svgRan = true;</script>",
	"</svg>",
].join("");

test.describe("file viewer", () => {
	// Monaco is a large chunk the dev server transforms on first use.
	test.describe.configure({ timeout: 90_000 });

	test("a PNG opens fit to the tab with its dimensions and size", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const path = "assets/shot.png";
		const bytes = png(64, 40, [47, 125, 109]);
		await openFileTab(page, student, "Png", path, bytes);

		const image = page.getByRole("img", { name: "shot.png" });
		await expect(image).toBeVisible({ timeout: 15_000 });
		await expect
			.poll(() => image.evaluate((node) => (node as HTMLImageElement).naturalWidth))
			.toBe(64);
		await expect(page.getByTestId("file-image-dimensions")).toHaveText(
			"64 × 40 pixels",
		);
		await expect(page.getByText(`${bytes.length} B`)).toBeVisible();
		await expect(page.getByText("Not a text file")).toHaveCount(0);
		await expect(page.getByTestId(`editor-${path}`)).toHaveCount(0);
		// Download is still one press away.
		await expect(page.getByRole("button", { name: "Download shot.png" })).toBeVisible();

		// The image is served as an image, never as something to sniff or run.
		const src = await image.getAttribute("src");
		expect(src).toContain("inline=1");
		const response = await page.request.get(src ?? "");
		expect(response.headers()["content-type"]).toBe("image/png");
		expect(response.headers()["x-content-type-options"]).toBe("nosniff");
		expect(response.headers()["content-security-policy"]).toMatch(/^sandbox;/);
	});

	test("an image past the editor limit refreshes when it changes on disk", async ({
		page,
		context,
	}) => {
		// A large file's read has no etag, so its size and modified time from
		// the listing make the change a new address (SPEC.md §13.2, §11.4).
		const student = await createStudent(context);
		const path = "big.png";
		const project = await openFileTab(page, student, "Big", path, bigPng(64, 40, 0));
		const image = page.getByRole("img", { name: "big.png" });
		await expect
			.poll(() => image.evaluate((node) => (node as HTMLImageElement).naturalWidth), {
				timeout: 15_000,
			})
			.toBe(64);

		await seedFile(student.workspaceId, project.slug, path, bigPng(32, 20, 1000));
		await expect
			.poll(() =>
				pushEvent(student.workspaceId, project.slug, {
					type: "fs",
					paths: [path],
					git: false,
					truncated: false,
				}),
			)
			.toBeGreaterThan(0);
		await expect
			.poll(() => image.evaluate((node) => (node as HTMLImageElement).naturalWidth), {
				timeout: 15_000,
			})
			.toBe(32);
	});

	test("an SVG shows its picture and its script does not run", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const path = "logo.svg";
		const project = await openFileTab(page, student, "Svg", path, HOSTILE_SVG);

		const image = page.getByRole("img", { name: "logo.svg" });
		await expect(image).toBeVisible({ timeout: 15_000 });
		await expect(page.getByTestId("file-image-dimensions")).toHaveText(
			"120 × 80 pixels",
		);
		// Drawn through img: the markup never becomes part of the page.
		await expect(page.locator("svg script")).toHaveCount(0);
		expect(await page.evaluate(() => (window as { svgRan?: boolean }).svgRan)).toBe(
			undefined,
		);

		// The text is one button away, and the picture comes back.
		await page.getByTestId(`file-view-edit-${path}`).click();
		await expect(
			page.getByTestId(`editor-${path}`).locator(".view-lines"),
		).toContainText("<rect", { timeout: 60_000 });
		await page.getByTestId(`file-view-view-${path}`).click();
		await expect(image).toBeVisible();
		await expect(page.getByTestId(`file-view-view-${path}`)).toBeFocused();

		// The same file from the file route carries a sandbox policy, so even
		// opened on its own it has no script and no access to the session.
		const response = await page.request.get(
			`/workspaces/${student.workspaceId}/projects/${project.id}/file?path=logo.svg&inline=1`,
		);
		expect(response.status()).toBe(200);
		expect(response.headers()["content-type"]).toBe("image/svg+xml");
		expect(response.headers()["x-content-type-options"]).toBe("nosniff");
		expect(response.headers()["content-security-policy"]).toContain("sandbox");
		expect(response.headers()["content-security-policy"]).toContain(
			"default-src 'none'",
		);
		expect(await page.evaluate(() => (window as { svgRan?: boolean }).svgRan)).toBe(
			undefined,
		);
	});

	test("a PDF opens in the browser's own viewer", async ({ page, context }) => {
		const student = await createStudent(context);
		const path = "brief.pdf";
		await openFileTab(page, student, "Pdf", path, pdf());

		const frame = page.getByTitle("brief.pdf, PDF");
		await expect(frame).toBeVisible({ timeout: 15_000 });
		// A copy held in the page, so the frame never loads the app's address.
		expect(await frame.getAttribute("src")).toMatch(/^blob:/);
		await expect(page.getByText("Not a text file")).toHaveCount(0);
		await expect(
			page.getByRole("button", { name: "Download brief.pdf" }),
		).toBeVisible();
	});

	test("a Markdown image in a nested folder resolves against that folder", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, { name: "Md images" });
		const path = "docs/guide/README.md";
		await seedFile(
			student.workspaceId,
			project.slug,
			"docs/guide/diagram.png",
			png(30, 20, [200, 80, 40]),
		);
		await seedFile(
			student.workspaceId,
			project.slug,
			"docs/logo.png",
			png(12, 12, [0, 0, 0]),
		);
		await seedFile(
			student.workspaceId,
			project.slug,
			path,
			"# Guide\n\n![Diagram](./diagram.png)\n\n![Logo](../logo.png)\n",
		);
		await query("update projects set layout = $2 where id = $1", [
			project.id,
			JSON.stringify({ tabs: [{ id: `file:${path}`, root: { type: "file", path } }] }),
		]);
		await page.goto(workspacePath(student.workspaceId, project.id));

		const preview = page.getByTestId("markdown-preview");
		await expect(preview).toBeVisible({ timeout: 30_000 });
		const diagram = preview.getByRole("img", { name: "Diagram" });
		await expect(diagram).toHaveAttribute(
			"src",
			new RegExp(`path=${encodeURIComponent("docs/guide/diagram.png")}&inline=1`),
		);
		// It really loaded, rather than breaking against the app's address.
		await expect
			.poll(() => diagram.evaluate((node) => (node as HTMLImageElement).naturalWidth))
			.toBe(30);
		const logo = preview.getByRole("img", { name: "Logo" });
		await expect
			.poll(() => logo.evaluate((node) => (node as HTMLImageElement).naturalWidth))
			.toBe(12);
	});

	test("an unknown binary file still offers the download panel", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await openFileTab(page, student, "Bin", "data.bin", "\u0000\u0001\u0002");
		await expect(page.getByText("Not a text file")).toBeVisible({ timeout: 15_000 });
		await expect(page.getByRole("button", { name: "Download data.bin" })).toBeVisible();
		await expect(page.getByRole("img", { name: "data.bin" })).toHaveCount(0);
	});

	for (const scheme of ["light", "dark"] as const) {
		test(`the image viewer has no automatic accessibility violations (${scheme})`, async ({
			page,
			context,
		}) => {
			await page.emulateMedia({ colorScheme: scheme });
			const student = await createStudent(context);
			await openFileTab(page, student, "A11y", "shot.png", png(64, 40, [47, 125, 109]));
			await expect(page.getByTestId("file-image-dimensions")).toBeVisible({
				timeout: 15_000,
			});
			await expectNoViolations(page);
		});

		test(`the PDF viewer has no automatic accessibility violations (${scheme})`, async ({
			page,
			context,
		}) => {
			await page.emulateMedia({ colorScheme: scheme });
			const student = await createStudent(context);
			await openFileTab(page, student, "A11y pdf", "brief.pdf", pdf());
			await expect(page.getByTitle("brief.pdf, PDF")).toBeVisible({ timeout: 15_000 });
			await expectNoViolations(page);
		});

		test(`an SVG in View, Edit and Diff has no automatic accessibility violations (${scheme})`, async ({
			page,
			context,
		}) => {
			await page.emulateMedia({ colorScheme: scheme });
			const student = await createStudent(context);
			const path = "logo.svg";
			await openFileTab(page, student, "A11y svg", path, HOSTILE_SVG);
			await expect(page.getByTestId("file-image-dimensions")).toBeVisible({
				timeout: 15_000,
			});
			await expectNoViolations(page);

			await page.getByTestId(`file-view-edit-${path}`).click();
			await expect(
				page.getByTestId(`editor-${path}`).locator(".view-lines"),
			).toContainText("<rect", { timeout: 60_000 });
			await expectNoViolations(page);

			await page.getByTestId(`file-view-diff-${path}`).click();
			await expect(page.getByTestId(`file-view-diff-${path}`)).toHaveAttribute(
				"aria-pressed",
				"true",
			);
			await expectNoViolations(page);
		});
	}
});
