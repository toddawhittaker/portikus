import { expect, type Page, test } from "@playwright/test";
import { createStudent, openFileTab, seedGit } from "./helpers";

/**
 * The editor colour scheme (SPEC.md §13.1, §25.8): a student picks a scheme in
 * Settings, every open editor switches at once with no reload, the editor keeps
 * following the page's light or dark appearance, and the choice is kept.
 */
test.describe("editor colour scheme", () => {
	// Monaco is a large chunk the dev server transforms on first use.
	test.describe.configure({ timeout: 90_000 });

	const PATH = "main.py";
	const CONTENT = 'def total(a, b):\n    return a + b\n\nprint("done")\n';

	// The colours the schemes publish, as the browser reports them.
	const PORTIKUS = {
		dark: { background: "rgb(23, 22, 20)", keyword: "rgb(244, 149, 124)" },
		light: { background: "rgb(255, 253, 248)", keyword: "rgb(178, 58, 30)" },
	};
	const VSCODE = {
		dark: { background: "rgb(31, 31, 31)", keyword: "rgb(86, 156, 214)" },
		light: { background: "rgb(255, 255, 255)", keyword: "rgb(0, 0, 255)" },
	};

	// The other five, from the same files the schemes are copied from: the
	// background is the TEXT or editor.background colour, the keyword the
	// scheme's keyword colour. High contrast leaves its background to Monaco's
	// own high contrast themes, which are black and white.
	const REFERENCE: {
		label: string;
		dark: { background: string; keyword: string };
		light: { background: string; keyword: string };
	}[] = [
		{
			label: "IntelliJ",
			dark: { background: "rgb(43, 43, 43)", keyword: "rgb(204, 120, 50)" },
			light: { background: "rgb(255, 255, 255)", keyword: "rgb(0, 51, 179)" },
		},
		{
			label: "GitHub",
			dark: { background: "rgb(13, 17, 23)", keyword: "rgb(255, 123, 114)" },
			light: { background: "rgb(255, 255, 255)", keyword: "rgb(207, 34, 46)" },
		},
		{
			label: "Solarized",
			dark: { background: "rgb(0, 43, 54)", keyword: "rgb(133, 153, 0)" },
			light: { background: "rgb(253, 246, 227)", keyword: "rgb(133, 153, 0)" },
		},
		{
			label: "Catppuccin",
			dark: { background: "rgb(30, 30, 46)", keyword: "rgb(203, 166, 247)" },
			light: { background: "rgb(239, 241, 245)", keyword: "rgb(136, 57, 239)" },
		},
		{
			label: "High contrast",
			dark: { background: "rgb(0, 0, 0)", keyword: "rgb(86, 156, 214)" },
			light: { background: "rgb(255, 255, 255)", keyword: "rgb(15, 74, 133)" },
		},
	];

	/** The editor's painted background and the colour of the `def` keyword. */
	async function editorColours(page: Page) {
		const editor = page.getByTestId(`editor-${PATH}`);
		const background = await editor
			.locator(".monaco-editor-background")
			.first()
			.evaluate((node) => getComputedStyle(node).backgroundColor);
		const keyword = await editor
			.locator(".view-lines span span", { hasText: /^def$/ })
			.first()
			.evaluate((node) => getComputedStyle(node).color);
		return { background, keyword };
	}

	async function openSettings(page: Page) {
		await page.getByTestId("me").click();
		await page.getByRole("menuitem", { name: "Settings" }).click();
		await expect(page.getByTestId("dialog-editor-settings")).toBeVisible();
	}

	async function closeSettings(page: Page) {
		await page.getByTestId("settings-close").click();
		await expect(page.getByTestId("dialog-editor-settings")).toHaveCount(0);
	}

	async function chooseAppearance(page: Page, name: "Light" | "Dark") {
		await openSettings(page);
		await page.getByRole("radio", { name }).check();
		await expect(page.locator("html")).toHaveAttribute(
			"data-theme",
			name.toLowerCase(),
		);
		await closeSettings(page);
	}

	async function chooseScheme(page: Page, label: string) {
		await openSettings(page);
		const saved = page.waitForResponse(
			(response) =>
				response.url().endsWith("/me/settings") &&
				response.request().method() === "PUT",
		);
		await page.getByLabel("Editor color scheme").click();
		await page.getByRole("option", { name: label }).click();
		expect((await saved).ok()).toBe(true);
		await closeSettings(page);
	}

	test("the scheme switches open editors without a reload, in dark and light, and is kept", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await openFileTab(page, student, "Schemes", PATH, CONTENT);
		await expect(
			page.getByTestId(`editor-${PATH}`).locator(".view-lines"),
		).toContainText("def total", { timeout: 60_000 });
		// A marker on the page proves nothing reloaded.
		await page.evaluate(() => {
			(window as unknown as { kept: boolean }).kept = true;
		});

		// Dark first. The default is Portikus.
		await chooseAppearance(page, "Dark");
		await expect.poll(() => editorColours(page)).toEqual(PORTIKUS.dark);
		await chooseScheme(page, "VS Code");
		await expect.poll(() => editorColours(page)).toEqual(VSCODE.dark);

		// Light: the same scheme, its other half.
		await chooseAppearance(page, "Light");
		await expect.poll(() => editorColours(page)).toEqual(VSCODE.light);
		await chooseScheme(page, "Portikus");
		await expect.poll(() => editorColours(page)).toEqual(PORTIKUS.light);
		await chooseScheme(page, "VS Code");
		await expect.poll(() => editorColours(page)).toEqual(VSCODE.light);

		expect(
			await page.evaluate(() => (window as unknown as { kept?: boolean }).kept),
		).toBe(true);

		// The choice is saved per user, so a reload keeps it.
		await page.reload();
		await expect(
			page.getByTestId(`editor-${PATH}`).locator(".view-lines"),
		).toContainText("def total", { timeout: 60_000 });
		await expect.poll(() => editorColours(page)).toEqual(VSCODE.light);
		await openSettings(page);
		await expect(page.getByLabel("Editor color scheme")).toContainText("VS Code");
	});

	test("each reference scheme paints its published background and keyword colour, dark then light", async ({
		page,
		context,
	}) => {
		test.setTimeout(240_000);
		const student = await createStudent(context);
		await openFileTab(page, student, "Schemes", PATH, CONTENT);
		await expect(
			page.getByTestId(`editor-${PATH}`).locator(".view-lines"),
		).toContainText("def total", { timeout: 60_000 });

		for (const mode of ["dark", "light"] as const) {
			await chooseAppearance(page, mode === "dark" ? "Dark" : "Light");
			for (const scheme of REFERENCE) {
				await chooseScheme(page, scheme.label);
				await expect
					.poll(() => editorColours(page), { message: `${scheme.label} ${mode}` })
					.toEqual(scheme[mode]);
			}
		}

		// The select lists all seven schemes, Portikus first.
		await openSettings(page);
		await page.getByLabel("Editor color scheme").click();
		await expect(page.getByRole("option")).toHaveText([
			"Portikus",
			"VS Code",
			"IntelliJ",
			"GitHub",
			"Solarized",
			"Catppuccin",
			"High contrast",
		]);
	});
	/** Opens the pane's actions menu, then its Color scheme submenu, by pointer. */
	async function openSchemeMenu(page: Page) {
		await page.getByTestId(`file-frame-actions-${PATH}`).click();
		await page.getByTestId("editor-scheme-menu").click();
		await expect(page.getByRole("menu", { name: "Color scheme" })).toBeVisible();
	}

	test("the editor pane's menu offers the schemes as a submenu, and a choice recolours the editor and shows in Settings", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await openFileTab(page, student, "Scheme menu", PATH, CONTENT);
		await expect(
			page.getByTestId(`editor-${PATH}`).locator(".view-lines"),
		).toContainText("def total", { timeout: 60_000 });
		await page.evaluate(() => {
			(window as unknown as { kept: boolean }).kept = true;
		});
		await chooseAppearance(page, "Dark");
		await expect.poll(() => editorColours(page)).toEqual(PORTIKUS.dark);

		await openSchemeMenu(page);
		const submenu = page.getByRole("menu", { name: "Color scheme" });
		// All seven, in Settings' order, with the one in use ticked.
		await expect(submenu.getByRole("menuitemradio")).toHaveText([
			"Portikus",
			"VS Code",
			"IntelliJ",
			"GitHub",
			"Solarized",
			"Catppuccin",
			"High contrast",
		]);
		await expect(
			submenu.getByRole("menuitemradio", { name: "Portikus" }),
		).toHaveAttribute("aria-checked", "true");

		const saved = page.waitForResponse(
			(response) =>
				response.url().endsWith("/me/settings") &&
				response.request().method() === "PUT",
		);
		// Moved in small steps, as a hand does, so the menu does not read the
		// jump from the Color scheme item as the pointer leaving it.
		const target = await submenu
			.getByRole("menuitemradio", { name: "VS Code" })
			.boundingBox();
		if (!target) throw new Error("the VS Code item has no box");
		await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, {
			steps: 15,
		});
		await page.mouse.down();
		await page.mouse.up();
		expect((await saved).ok()).toBe(true);
		await expect.poll(() => editorColours(page)).toEqual(VSCODE.dark);
		expect(
			await page.evaluate(() => (window as unknown as { kept?: boolean }).kept),
		).toBe(true);

		// The tick moved with the choice.
		await openSchemeMenu(page);
		await expect(
			page
				.getByRole("menu", { name: "Color scheme" })
				.getByRole("menuitemradio", { name: "VS Code" }),
		).toHaveAttribute("aria-checked", "true");
		await page.keyboard.press("Escape");
		await page.keyboard.press("Escape");

		// Settings shows the same choice.
		await openSettings(page);
		await expect(page.getByLabel("Editor color scheme")).toContainText("VS Code");
		await closeSettings(page);

		// And a choice made in Settings is the one ticked in the menu.
		await chooseScheme(page, "Solarized");
		await openSchemeMenu(page);
		await expect(
			page
				.getByRole("menu", { name: "Color scheme" })
				.getByRole("menuitemradio", { name: "Solarized" }),
		).toHaveAttribute("aria-checked", "true");
	});

	test("the keyboard alone opens the submenu, picks a scheme and steps back with Escape", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await openFileTab(page, student, "Scheme keys", PATH, CONTENT);
		await expect(
			page.getByTestId(`editor-${PATH}`).locator(".view-lines"),
		).toContainText("def total", { timeout: 60_000 });
		await chooseAppearance(page, "Dark");
		await expect.poll(() => editorColours(page)).toEqual(PORTIKUS.dark);

		await page.getByTestId(`file-frame-actions-${PATH}`).focus();
		await page.keyboard.press("Enter");
		const trigger = page.getByTestId("editor-scheme-menu");
		// The pane is alone, so the move items are unavailable and the arrow
		// keys skip them; the submenu is the first stop.
		await expect(trigger).toBeFocused();

		await page.keyboard.press("ArrowRight");
		const submenu = page.getByRole("menu", { name: "Color scheme" });
		await expect(submenu).toBeVisible();
		// Escape steps back to the parent menu, still open, on the submenu item.
		await page.keyboard.press("Escape");
		await expect(submenu).toHaveCount(0);
		await expect(trigger).toBeFocused();
		await expect(page.getByRole("menu", { name: /^Actions for / })).toBeVisible();

		await page.keyboard.press("ArrowRight");
		await expect(submenu).toBeVisible();
		// The submenu opens on its first item, Portikus; one step down is VS Code.
		await page.keyboard.press("ArrowDown");
		await expect(submenu.getByRole("menuitemradio", { name: "VS Code" })).toBeFocused();
		await page.keyboard.press("Enter");
		await expect.poll(() => editorColours(page)).toEqual(VSCODE.dark);
		// The menu closes after a choice and the keyboard comes back to the pane.
		await expect(page.getByRole("menu")).toHaveCount(0);
		await expect(page.getByTestId(`file-frame-actions-${PATH}`)).toBeFocused();
	});

	test("the pane menu offers the schemes in Diff mode too, and the choice carries between Diff and Edit", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await openFileTab(page, student, "Scheme diff", PATH, CONTENT);
		await seedGit(student.workspaceId, project.slug, {
			diffs: {
				[PATH]: {
					status: "M",
					before: "def total(a, b):\n    return a\n",
					after: CONTENT,
					binary: false,
					tooLarge: false,
				},
			},
		});
		await expect(
			page.getByTestId(`editor-${PATH}`).locator(".view-lines"),
		).toContainText("def total", { timeout: 60_000 });
		await chooseAppearance(page, "Dark");
		await expect.poll(() => editorColours(page)).toEqual(PORTIKUS.dark);

		const diff = page.getByTestId(`diff-editor-${PATH}`);
		const diffBackground = () =>
			diff
				.locator(".monaco-editor-background")
				.first()
				.evaluate((node) => getComputedStyle(node).backgroundColor);
		await page.getByTestId(`file-view-diff-${PATH}`).click();
		await expect(diff.locator(".monaco-diff-editor")).toBeVisible({ timeout: 60_000 });
		await expect.poll(diffBackground).toBe(PORTIKUS.dark.background);
		await page.evaluate(() => {
			(window as unknown as { kept: boolean }).kept = true;
		});

		await openSchemeMenu(page);
		// Moved in small steps, as in the Edit test above.
		const target = await page
			.getByRole("menuitemradio", { name: "VS Code" })
			.boundingBox();
		if (!target) throw new Error("the VS Code item has no box");
		await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, {
			steps: 15,
		});
		await page.mouse.down();
		await page.mouse.up();
		await expect.poll(diffBackground).toBe(VSCODE.dark.background);
		expect(
			await page.evaluate(() => (window as unknown as { kept?: boolean }).kept),
		).toBe(true);

		// Edit shows the same scheme.
		await page.getByTestId(`file-view-edit-${PATH}`).click();
		await expect.poll(() => editorColours(page)).toEqual(VSCODE.dark);
	});
});
