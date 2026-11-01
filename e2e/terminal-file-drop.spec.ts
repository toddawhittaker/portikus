import { expect, type Page, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	expectConnected,
	newTerminal,
	readSeededFile,
	seedFile,
	type TestStudent,
	terminalIds,
	workspacePath,
	workTabs,
} from "./helpers";

/**
 * Dropping files on a terminal (SPEC.md §9.6). The fake agent echoes every
 * input frame as `echo:<frame>`, so the rows show exactly what the terminal
 * was sent. A path is typed with a trailing space and never Enter.
 */
test.describe("file drop on a terminal", () => {
	// Monaco is a large chunk the dev server transforms on first use.
	test.describe.configure({ timeout: 90_000 });

	function row(page: Page, path: string) {
		return page.getByTestId(`file-row-${path}`);
	}

	function rows(page: Page, terminalId: string) {
		return page.locator(`[data-testid=terminal-pane-${terminalId}] .xterm-rows`);
	}

	/** A project with two seeded files, showing one connected terminal. */
	async function setUp(page: Page, student: TestStudent) {
		const project = await createProject(student.workspaceId, { name: "Drops" });
		await seedFile(student.workspaceId, project.slug, "notes.md", "# notes\n");
		await seedFile(student.workspaceId, project.slug, "my docs/a b.md", "x\n");
		await page.goto(workspacePath(student.workspaceId, project.id));
		await expect(row(page, "notes.md")).toBeVisible({ timeout: 15_000 });
		await newTerminal(page);
		await expect
			.poll(async () => (await terminalIds(student.workspaceId, project.id)).length)
			.toBe(1);
		const [terminalId] = await terminalIds(student.workspaceId, project.id);
		if (!terminalId) throw new Error("the terminal row was not created");
		await expectConnected(page, terminalId);
		return { project, terminalId };
	}

	/** Dispatch a drag of desktop files onto a point of the pane, as a browser would. */
	async function dropFiles(
		page: Page,
		terminalId: string,
		files: { name: string; content: string; size?: number }[],
		at: { x: number; y: number } = { x: 0.5, y: 0.5 },
	) {
		await page.evaluate(
			([id, given, point]) => {
				const pane = document.querySelector(
					`[data-testid=terminal-leaf-${id}]`,
				) as HTMLElement;
				const target = document.querySelector(
					`[data-testid=terminal-pane-${id}]`,
				) as HTMLElement;
				const box = pane.getBoundingClientRect();
				const init = {
					bubbles: true,
					cancelable: true,
					clientX: box.left + box.width * point.x,
					clientY: box.top + box.height * point.y,
				};
				const data = new DataTransfer();
				for (const file of given) {
					const made = new File([file.content], file.name);
					if (file.size !== undefined) {
						Object.defineProperty(made, "size", { value: file.size });
					}
					data.items.add(made);
				}
				target.dispatchEvent(
					new DragEvent("dragenter", { ...init, dataTransfer: data }),
				);
				target.dispatchEvent(
					new DragEvent("dragover", { ...init, dataTransfer: data }),
				);
				target.dispatchEvent(new DragEvent("drop", { ...init, dataTransfer: data }));
			},
			[terminalId, files, at] as const,
		);
	}

	/** Press on a tree row and carry it to a point, without letting go. */
	async function carryRow(page: Page, path: string, to: { x: number; y: number }) {
		const source = await row(page, path).boundingBox();
		if (!source) throw new Error(`the row ${path} is not on screen`);
		await page.mouse.move(source.x + 20, source.y + 10);
		await page.mouse.down();
		await page.mouse.move(source.x + 30, source.y + 10, { steps: 5 });
		await page.mouse.move(to.x, to.y, { steps: 12 });
		await page.mouse.move(to.x, to.y, { steps: 2 });
	}

	async function pointIn(page: Page, terminalId: string, x: number, y: number) {
		const box = await page.getByTestId(`terminal-leaf-${terminalId}`).boundingBox();
		if (!box) throw new Error("the pane is not on screen");
		return { x: box.x + box.width * x, y: box.y + box.height * y };
	}

	test("files dropped from the desktop are saved and their paths typed without Enter", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const { project, terminalId } = await setUp(page, student);
		const home = `/home/student/projects/${project.slug}`;

		await dropFiles(page, terminalId, [
			{ name: "my shot.png", content: "png-bytes" },
			{ name: "notes.txt", content: "plain" },
		]);

		await expect(rows(page, terminalId)).toContainText(`'${home}/.portikus/pastes/`, {
			timeout: 15_000,
		});
		const seen = (await rows(page, terminalId).textContent()) ?? "";
		const quoted =
			/'(\/home\/student\/projects\/drops\/\.portikus\/pastes\/[0-9T-]+\/my shot\.png)'/.exec(
				seen,
			);
		const plain =
			/(\/home\/student\/projects\/drops\/\.portikus\/pastes\/[0-9T-]+\/notes\.txt) /.exec(
				seen,
			);
		expect(quoted).not.toBeNull();
		expect(plain).not.toBeNull();
		const relative = (path: string) => path.slice(`${home}/`.length);
		expect(
			await readSeededFile(
				student.workspaceId,
				project.slug,
				relative(quoted?.[1] ?? ""),
			),
		).toBe("png-bytes");
		expect(
			await readSeededFile(
				student.workspaceId,
				project.slug,
				relative(plain?.[1] ?? ""),
			),
		).toBe("plain");
		// Typed once, as text with no Enter, and never the file contents.
		expect(seen.split("my shot.png").length - 1).toBe(1);
		expect(seen).not.toContain("png-bytes");
		expect(seen).not.toContain("\\r");
		expect(seen).not.toContain("\\n");
	});

	test("the pane shows a drop target while files are dragged over it", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const { terminalId } = await setUp(page, student);

		await page.evaluate((id) => {
			const target = document.querySelector(
				`[data-testid=terminal-pane-${id}]`,
			) as HTMLElement;
			const box = target.getBoundingClientRect();
			const data = new DataTransfer();
			data.items.add(new File(["x"], "a.png"));
			target.dispatchEvent(
				new DragEvent("dragover", {
					bubbles: true,
					cancelable: true,
					clientX: box.left + box.width / 2,
					clientY: box.top + box.height / 2,
					dataTransfer: data,
				}),
			);
		}, terminalId);

		await expect(page.getByTestId(`file-drop-target-${terminalId}`)).toBeVisible();
		await page.evaluate((id) => {
			const target = document.querySelector(
				`[data-testid=terminal-pane-${id}]`,
			) as HTMLElement;
			target.dispatchEvent(new DragEvent("dragleave", { bubbles: true }));
		}, terminalId);
		await expect(page.getByTestId(`file-drop-target-${terminalId}`)).toHaveCount(0);
	});

	test("a file name with a control character is refused with a toast and nothing is typed", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const { project, terminalId } = await setUp(page, student);

		await dropFiles(page, terminalId, [
			{ name: "fine.png", content: "ok" },
			{ name: "bad\u001b[2Jname.png", content: "no" },
		]);

		await expect(page.getByText(/cannot be dropped/)).toBeVisible({ timeout: 15_000 });
		await page.waitForTimeout(1000);
		await expect(rows(page, terminalId)).not.toContainText(".portikus/pastes");
		// Not even the fine file was saved.
		await expect(
			readSeededFile(student.workspaceId, project.slug, ".portikus/pastes"),
		).rejects.toThrow();
	});

	test("a file over the upload limit is refused with a toast and nothing is typed", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const { terminalId } = await setUp(page, student);

		await dropFiles(page, terminalId, [
			{ name: "huge.bin", content: "x", size: 50 * 1024 * 1024 + 1 },
		]);

		await expect(page.getByText(/must be 50 MB or smaller/)).toBeVisible({
			timeout: 15_000,
		});
		await page.waitForTimeout(1000);
		await expect(rows(page, terminalId)).not.toContainText(".portikus/pastes");
	});

	test("a tree file dropped on the middle of the pane types its quoted path and does not split", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const { project, terminalId } = await setUp(page, student);

		await page.getByTestId("file-row-my docs").click();
		await expect(row(page, "my docs/a b.md")).toBeVisible();
		await carryRow(page, "my docs/a b.md", await pointIn(page, terminalId, 0.5, 0.5));
		await expect(page.getByTestId(`file-drop-target-${terminalId}`)).toBeVisible();
		await page.mouse.up();

		await expect(rows(page, terminalId)).toContainText(
			`'/home/student/projects/${project.slug}/my docs/a b.md' `,
			{ timeout: 15_000 },
		);
		await expect(page.getByTestId(`file-drop-target-${terminalId}`)).toHaveCount(0);
		// Nothing was uploaded and no file pane opened.
		await expect(page.locator('[data-testid^="file-frame-"]')).toHaveCount(0);
		await expect(workTabs(page).getByRole("tab")).toHaveCount(1);
	});

	test("a tree file dropped on a pane edge still opens in a split and types nothing", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const { terminalId } = await setUp(page, student);

		await carryRow(page, "notes.md", await pointIn(page, terminalId, 0.9, 0.5));
		await expect(page.getByTestId(`drop-zone-${terminalId}`)).toHaveAttribute(
			"data-edge",
			"right",
		);
		await expect(page.getByTestId(`file-drop-target-${terminalId}`)).toHaveCount(0);
		await page.mouse.up();

		await expect(page.getByTestId("file-frame-notes.md")).toBeVisible({
			timeout: 15_000,
		});
		await expect(workTabs(page).getByRole("tab")).toHaveCount(1);
		await page.waitForTimeout(1000);
		await expect(rows(page, terminalId)).not.toContainText("notes.md");
	});
	test("a drop that only claims to be a tree drag types nothing", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const { terminalId } = await setUp(page, student);

		await page.evaluate((id) => {
			const target = document.querySelector(
				`[data-testid=terminal-pane-${id}]`,
			) as HTMLElement;
			const box = target.getBoundingClientRect();
			const data = new DataTransfer();
			data.setData("application/x-portikus-tree-path", "/etc/passwd");
			const init = {
				bubbles: true,
				cancelable: true,
				clientX: box.left + box.width / 2,
				clientY: box.top + box.height / 2,
				dataTransfer: data,
			};
			target.dispatchEvent(new DragEvent("dragover", init));
			target.dispatchEvent(new DragEvent("drop", init));
		}, terminalId);

		await expect(page.getByTestId(`file-drop-target-${terminalId}`)).toHaveCount(0);
		await page.waitForTimeout(1000);
		await expect(rows(page, terminalId)).not.toContainText("passwd");
	});

	test("Copy path from the row menu, opened by keyboard, pastes the quoted path into a terminal", async ({
		page,
		context,
	}) => {
		await context.grantPermissions(["clipboard-read", "clipboard-write"]);
		const student = await createStudent(context);
		const { project, terminalId } = await setUp(page, student);

		await page.getByTestId("file-row-my docs").click();
		const target = row(page, "my docs/a b.md");
		await expect(target).toBeVisible();
		await target.focus();
		await page.keyboard.press("Shift+F10");
		await page.getByRole("menuitem", { name: "Copy path" }).click();
		await expect
			.poll(() => page.evaluate(() => navigator.clipboard.readText()))
			.toBe(`'/home/student/projects/${project.slug}/my docs/a b.md'`);

		await page.getByTestId(`terminal-pane-${terminalId}`).click();
		await page.keyboard.press("Control+Shift+V");
		await expect(rows(page, terminalId)).toContainText(
			`'/home/student/projects/${project.slug}/my docs/a b.md'`,
			{ timeout: 15_000 },
		);
	});
});
