import { deflateSync } from "node:zlib";
import { expect, type Page, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	openFileTab,
	query,
	seedFile,
	settledAxe,
	WCAG_TAGS,
	workspacePath,
} from "./helpers";

/**
 * The file tab shows images and PDFs instead of only offering a download,
 * and a Markdown preview shows the images its file points at by a relative
 * path (#816, SPEC.md §13.2, §13.4). Student files are untrusted, so an SVG
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

/** A one-page PDF with a line of text on it. */
function pdf(): Buffer {
	const text = "BT /F1 24 Tf 40 100 Td (Assignment one) Tj ET";
	const objects = [
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
		`<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
		"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
	];
	let out = "%PDF-1.4\n";
	const offsets: number[] = [];
	objects.forEach((object, index) => {
		offsets.push(out.length);
		out += `${index + 1} 0 obj\n${object}\nendobj\n`;
	});
	const xref = out.length;
	out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	out += offsets
		.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
		.join("");
	out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
	return Buffer.from(out, "latin1");
}

/** An SVG that would set a flag on the page if any of its script ran. */
const HOSTILE_SVG = [
	'<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80" onload="top.svgRan = true">',
	'<rect width="120" height="80" fill="#2f7d6d"/>',
	"<script>top.svgRan = true; parent.svgRan = true;</script>",
	"</svg>",
].join("");

/** Axe over the file tab's own pane: the viewer, its bar and the view buttons. */
async function expectNoViolations(page: Page, path: string) {
	const results = await (await settledAxe(page))
		.include(`[data-testid="file-pane-${path}"]`)
		.withTags(WCAG_TAGS)
		.analyze();
	expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

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
		await expect(page.getByText(`${bytes.length} bytes`)).toBeVisible();
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
			await expectNoViolations(page, "shot.png");
		});

		test(`the PDF viewer has no automatic accessibility violations (${scheme})`, async ({
			page,
			context,
		}) => {
			await page.emulateMedia({ colorScheme: scheme });
			const student = await createStudent(context);
			await openFileTab(page, student, "A11y pdf", "brief.pdf", pdf());
			await expect(page.getByTitle("brief.pdf, PDF")).toBeVisible({ timeout: 15_000 });
			await expectNoViolations(page, "brief.pdf");
		});
	}
});
