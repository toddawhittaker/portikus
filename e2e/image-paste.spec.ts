import { expect, type Locator, type Page, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	readSeededFile,
	type TestProject,
	terminalIds,
	workspacePath,
} from "./helpers";

/**
 * Pasting a picture into a terminal (Epic 9.2 brief, issue #355). The fake
 * agent echoes every input frame as `echo:<frame>`, so the rows show exactly
 * what the terminal was sent. Chromium only, as in clipboard.spec.ts.
 */
test.describe("image paste", () => {
	test.use({ permissions: ["clipboard-read", "clipboard-write"] });

	function rowsOf(page: Page, terminalId: string): Locator {
		return page.locator(`[data-testid=terminal-pane-${terminalId}] .xterm-rows`);
	}

	async function openTerminal(
		page: Page,
		workspaceId: string,
	): Promise<{ project: TestProject; terminalId: string }> {
		const project = await createProject(workspaceId, { name: "Pictures" });
		await page.goto(workspacePath(workspaceId, project.id));
		await expect(page.getByTestId("work-tabs")).toBeVisible({ timeout: 15_000 });
		await page.getByTestId("launcher").click();
		await page.getByRole("menuitem", { name: "Terminal", exact: true }).click();
		await expect
			.poll(async () => (await terminalIds(workspaceId, project.id)).length)
			.toBe(1);
		const [terminalId] = await terminalIds(workspaceId, project.id);
		if (!terminalId) throw new Error("the terminal row was not created");
		await expect(
			page.locator(`[data-testid=terminal-pane-${terminalId}]`),
		).toHaveAttribute("data-connected", "true", { timeout: 15_000 });
		await page
			.locator(`[data-testid=terminal-pane-${terminalId}] .xterm-screen`)
			.click();
		return { project, terminalId };
	}

	/** The path the terminal was sent, which must end in one space and no newline. */
	async function typedPath(
		page: Page,
		terminalId: string,
		slug: string,
	): Promise<string> {
		const pattern = new RegExp(
			`"data":"(/home/student/projects/${slug}/\\.portikus/pastes/[0-9T-]+\\.(png|jpeg)) "\\}`,
		);
		let found = "";
		await expect
			.poll(
				async () => {
					const match = pattern.exec(
						(await rowsOf(page, terminalId).textContent()) ?? "",
					);
					found = match?.[1] ?? "";
					return found;
				},
				{ timeout: 15_000 },
			)
			.not.toBe("");
		return found;
	}

	/** Put a real png on the system clipboard, drawn in the page. */
	async function copyPicture(page: Page): Promise<void> {
		await page.evaluate(async () => {
			const canvas = document.createElement("canvas");
			canvas.width = 4;
			canvas.height = 4;
			const blob = await new Promise<Blob>((resolve) =>
				canvas.toBlob((made) => resolve(made as Blob), "image/png"),
			);
			await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
		});
	}

	/** Fire a paste carrying `parts`, the way the browser hands one over. */
	async function firePaste(
		page: Page,
		terminalId: string,
		parts: { text?: string; file?: { type: string; content: string } },
	): Promise<void> {
		await page.evaluate(
			([id, given]) => {
				const data = new DataTransfer();
				if (given.text) data.items.add(given.text, "text/plain");
				if (given.file) {
					data.items.add(
						new File([given.file.content], "name-from-clipboard", {
							type: given.file.type,
						}),
					);
				}
				const target = document.querySelector(
					`[data-testid=terminal-pane-${id}] textarea`,
				);
				target?.dispatchEvent(
					new ClipboardEvent("paste", {
						clipboardData: data,
						bubbles: true,
						cancelable: true,
					}),
				);
			},
			[terminalId, parts] as const,
		);
	}

	test("Ctrl+V with a picture saves it and types its absolute path", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const { project, terminalId } = await openTerminal(page, student.workspaceId);
		await copyPicture(page);

		await page.keyboard.press("Control+KeyV");

		const path = await typedPath(page, terminalId, project.slug);
		const relative = path.slice(`/home/student/projects/${project.slug}/`.length);
		// The file is there, under the name Portikus chose.
		await readSeededFile(student.workspaceId, project.slug, relative);
		// Only the path reached the shell, once, with no picture bytes.
		const seen = (await rowsOf(page, terminalId).textContent()) ?? "";
		expect(seen.split(path).length - 1).toBe(1);
		expect(seen).not.toContain("PNG");
	});

	test("right-clicking with a picture on the clipboard saves it", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const { project, terminalId } = await openTerminal(page, student.workspaceId);
		await copyPicture(page);

		await page
			.locator(`[data-testid=terminal-pane-${terminalId}] .xterm-screen`)
			.click({ button: "right" });

		const path = await typedPath(page, terminalId, project.slug);
		const relative = path.slice(`/home/student/projects/${project.slug}/`.length);
		await readSeededFile(student.workspaceId, project.slug, relative);
	});

	test("a jpeg is written byte for byte and never typed", async ({ page, context }) => {
		const student = await createStudent(context);
		const { project, terminalId } = await openTerminal(page, student.workspaceId);

		await firePaste(page, terminalId, {
			file: { type: "image/jpeg", content: "jpeg-bytes-marker" },
		});

		const path = await typedPath(page, terminalId, project.slug);
		expect(path).toMatch(/\.jpeg$/);
		expect(path).not.toContain("name-from-clipboard");
		const relative = path.slice(`/home/student/projects/${project.slug}/`.length);
		expect(await readSeededFile(student.workspaceId, project.slug, relative)).toBe(
			"jpeg-bytes-marker",
		);
		await expect(rowsOf(page, terminalId)).not.toContainText("jpeg-bytes-marker");
	});

	test("text beside a picture is typed as text, once", async ({ page, context }) => {
		const student = await createStudent(context);
		const { terminalId } = await openTerminal(page, student.workspaceId);

		await firePaste(page, terminalId, {
			text: "text-beside-picture",
			file: { type: "image/png", content: "png-bytes-marker" },
		});

		await expect(rowsOf(page, terminalId)).toContainText("text-beside-picture", {
			timeout: 15_000,
		});
		await page.waitForTimeout(1500);
		const seen = (await rowsOf(page, terminalId).textContent()) ?? "";
		expect(seen.split("text-beside-picture").length - 1).toBe(1);
		expect(seen).not.toContain(".portikus/pastes");
		expect(seen).not.toContain("png-bytes-marker");
	});

	test("two pastes in the same second keep both pictures", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const { project, terminalId } = await openTerminal(page, student.workspaceId);
		await page.clock.setFixedTime(new Date("2026-09-22T13:40:00Z"));

		await firePaste(page, terminalId, {
			file: { type: "image/png", content: "first" },
		});
		await typedPath(page, terminalId, project.slug);
		await firePaste(page, terminalId, {
			file: { type: "image/png", content: "second" },
		});

		const dir = `/home/student/projects/${project.slug}/.portikus/pastes`;
		await expect(rowsOf(page, terminalId)).toContainText(
			`${dir}/2026-09-22T13-40-00-2.png `,
			{ timeout: 15_000 },
		);
		expect(
			await readSeededFile(
				student.workspaceId,
				project.slug,
				".portikus/pastes/2026-09-22T13-40-00.png",
			),
		).toBe("first");
		expect(
			await readSeededFile(
				student.workspaceId,
				project.slug,
				".portikus/pastes/2026-09-22T13-40-00-2.png",
			),
		).toBe("second");
	});

	test("right-click text goes through the terminal's own paste", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const { terminalId } = await openTerminal(page, student.workspaceId);
		await page.evaluate(() => navigator.clipboard.writeText("line-one\nline-two"));

		await page
			.locator(`[data-testid=terminal-pane-${terminalId}] .xterm-screen`)
			.click({ button: "right" });

		// xterm's paste turns newlines into carriage returns, as a keyboard paste does.
		await expect(rowsOf(page, terminalId)).toContainText("line-one\\rline-two", {
			timeout: 15_000,
		});
		await page.waitForTimeout(1500);
		const seen = (await rowsOf(page, terminalId).textContent()) ?? "";
		expect(seen.split("line-one").length - 1).toBe(1);
	});

	test.describe("where readText is refused, as in Firefox", () => {
		test.beforeEach(async ({ page }) => {
			await page.addInitScript(() => {
				Object.defineProperty(Clipboard.prototype, "readText", { value: undefined });
			});
		});

		test("Ctrl+V still saves the picture", async ({ page, context }) => {
			const student = await createStudent(context);
			const { project, terminalId } = await openTerminal(page, student.workspaceId);
			await copyPicture(page);

			await page.keyboard.press("Control+KeyV");

			const path = await typedPath(page, terminalId, project.slug);
			const relative = path.slice(`/home/student/projects/${project.slug}/`.length);
			await readSeededFile(student.workspaceId, project.slug, relative);
		});

		test("Ctrl+V still types text once", async ({ page, context }) => {
			const student = await createStudent(context);
			const { terminalId } = await openTerminal(page, student.workspaceId);
			await page.evaluate(() => navigator.clipboard.writeText("text-without-readtext"));

			await page.keyboard.press("Control+KeyV");

			await expect(rowsOf(page, terminalId)).toContainText("text-without-readtext", {
				timeout: 15_000,
			});
			await page.waitForTimeout(1500);
			const seen = (await rowsOf(page, terminalId).textContent()) ?? "";
			expect(seen.split("text-without-readtext").length - 1).toBe(1);
		});
	});
});
