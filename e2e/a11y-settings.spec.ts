/**
 * Screen-reader mode and the accessibility parts of Settings (SPEC.md §13.5
 * and §25.8), and how Settings saves:
 * each preference at once, announced by one status line.
 */
import { expect, type Page, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	expectConnected,
	expectNoViolations,
	openFileTab,
	terminalIds,
	WEB_ORIGIN,
	workspacePath,
	workTabs,
} from "./helpers";

async function openSettings(page: Page) {
	await page.getByTestId("me").click();
	await page.getByRole("menuitem", { name: "Settings" }).click();
	const dialog = page.getByTestId("dialog-editor-settings");
	await expect(dialog).toBeVisible();
	return dialog;
}

async function openTerminal(page: Page, workspaceId: string, projectId: string) {
	await page.getByTestId("launcher").click();
	await page.getByTestId("launcher-terminal").click();
	await expect(page.getByRole("tab", { name: "Terminal 1" })).toBeVisible();
	await expect
		.poll(() => terminalIds(workspaceId, projectId), { timeout: 15_000 })
		.toHaveLength(1);
	const [id] = await terminalIds(workspaceId, projectId);
	if (!id) throw new Error("the terminal row was not created");
	await expectConnected(page, id);
	return page.getByTestId(`terminal-pane-${id}`);
}

/** The name every test here gives notes.txt's editor. */
const EDITOR_NAME = "Editor, notes.txt. Ctrl+M makes Tab leave the editor.";

/** Store the student's choice before the page loads, as an earlier visit would. */
async function storeScreenReaderMode(page: Page, on: boolean) {
	const res = await page.request.put("/me/settings", {
		data: { screenReaderMode: on },
		headers: { origin: WEB_ORIGIN },
	});
	expect(res.status()).toBe(200);
}

test("screen-reader mode is off by default in terminals and the editor", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await openFileTab(page, student, "SR Default", "notes.txt", "first line\n");
	await expect(
		page.getByRole("button", { name: "Turn on screen-reader mode" }),
	).toBeAttached();
	// Off is Monaco's "auto", which keeps the editor's own name: the file
	// and the way out, never "not accessible" (SPEC.md §13.5).
	const input = page
		.locator('[data-testid="file-pane-notes.txt"] [aria-roledescription="editor"]')
		.first();
	await expect(input).toHaveAttribute("aria-label", EDITOR_NAME);
	// Without screen-reader support Monaco puts no text in its input.
	await input.focus();
	await expect(input).toHaveText("");
});

test("turning on screen-reader mode in Settings gives an open terminal its accessibility tree", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "SR Settings" });
	await storeScreenReaderMode(page, false);
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
	const pane = await openTerminal(page, student.workspaceId, project.id);
	await expect(pane.locator(".xterm-accessibility-tree")).toHaveCount(0);

	const dialog = await openSettings(page);
	const box = dialog.getByRole("checkbox", { name: /Screen reader mode/ });
	await expect(box).not.toBeChecked();
	await box.check();
	await expect(dialog.getByRole("status")).toHaveText("Saved");
	await dialog.getByTestId("settings-close").click();
	await expect(dialog).toHaveCount(0);

	// Applied to the terminal already open, without a reload.
	await expect(pane.locator(".xterm-accessibility-tree")).toHaveCount(1);
});

test("the first Tab stop turns screen-reader mode on and off and says so", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "SR Skip" });
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });

	// A fresh page: the first Tab lands on the toggle, shown while focused.
	await page.keyboard.press("Tab");
	const toggle = page.getByRole("button", { name: "Turn on screen-reader mode" });
	await expect(toggle).toBeFocused();
	await expect(toggle).toBeInViewport();

	await page.keyboard.press("Enter");
	await expect(page.getByTestId("screen-reader-status")).toHaveText(
		"Screen-reader mode is on.",
	);
	await expect(
		page.getByRole("button", { name: "Turn off screen-reader mode" }),
	).toBeFocused();

	// A terminal opened now starts in the mode.
	const pane = await openTerminal(page, student.workspaceId, project.id);
	await expect(pane.locator(".xterm-accessibility-tree")).toHaveCount(1);

	// Saved for the student: it survives a reload, and turns off the same way.
	await page.reload();
	await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
	await page.getByTestId("screen-reader-toggle").focus();
	await expect(
		page.getByRole("button", { name: "Turn off screen-reader mode" }),
	).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("screen-reader-status")).toHaveText(
		"Screen-reader mode is off.",
	);
});

test("screen-reader mode turns on the editor's own screen-reader support", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await storeScreenReaderMode(page, false);
	await openFileTab(
		page,
		student,
		"SR Editor",
		"notes.txt",
		"first line\nsecond line\n",
	);
	// Monaco's input, a textarea or a native edit-context element by browser.
	const input = page
		.locator('[data-testid="file-pane-notes.txt"] [aria-roledescription="editor"]')
		.first();
	await expect(input).toHaveAttribute("aria-label", EDITOR_NAME);

	await page.getByTestId("screen-reader-toggle").focus();
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("screen-reader-status")).toHaveText(
		"Screen-reader mode is on.",
	);

	// Support is forced on: the name stays, and Monaco now writes the text
	// around the cursor into its input for the screen reader to read.
	await expect(input).toHaveAttribute("aria-label", EDITOR_NAME);
	await input.focus();
	await expect(input).toContainText("first line");
});

test("the terminal colours switch is named Light terminal", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await page.goto(workspacePath(student.workspaceId));
	await expect(page.getByTestId("app-header")).toBeVisible({ timeout: 15_000 });

	const dialog = await openSettings(page);
	const toggle = dialog.getByRole("switch", { name: "Light terminal" });
	await expect(toggle).not.toBeChecked();
	await toggle.check();
	await expect(dialog.getByRole("switch", { name: "Light terminal" })).toBeChecked();
});

/** The keys and the library limits are on the Help page. */
test("Accessibility points to the keys on the Help page in a new tab", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await page.goto(workspacePath(student.workspaceId));
	await expect(page.getByTestId("app-header")).toBeVisible({ timeout: 15_000 });

	const dialog = await openSettings(page);
	await expect(
		dialog.getByRole("button", { name: "Keyboard and screen readers" }),
	).toHaveCount(0);
	const region = dialog.getByRole("region", { name: "Accessibility" });
	const link = region.getByRole("link", { name: "Help (opens in a new tab)" });
	await expect(link).toHaveAttribute("href", "/help#student-keyboard");
	await expect(link).toHaveAttribute("target", "_blank");

	// Search still finds it, under its old name.
	await dialog.getByLabel("Search").fill("keyboard");
	await dialog.getByRole("button", { name: "Keyboard and screen readers" }).click();
	await expect(link).toBeInViewport();
});

/**
 * A preference is saved as it changes, the status line says so,
 * and closing keeps it. A typed delay is saved when Escape closes the dialog.
 */
test("preferences save at once, Saved is announced, and Escape keeps a typed delay", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await page.goto(workspacePath(student.workspaceId));
	await expect(page.getByTestId("app-header")).toBeVisible({ timeout: 15_000 });

	let dialog = await openSettings(page);
	await expect(dialog.getByRole("button", { name: "Save", exact: true })).toHaveCount(
		0,
	);
	await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(
		0,
	);
	const status = dialog.getByRole("status");
	await expect(status).toHaveText("");

	await dialog.getByRole("checkbox", { name: /Word wrap/ }).click();
	await expect(status).toHaveText("Saved");
	await dialog.getByTestId("editor-settings-delay").fill("17");
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);

	await expect
		.poll(async () => {
			const res = await page.request.get("/me/settings");
			const body = (await res.json()) as {
				wordWrap: boolean;
				autoSaveDelaySeconds: number;
			};
			return [body.wordWrap, body.autoSaveDelaySeconds];
		})
		.toEqual([false, 17]);

	await page.reload();
	await expect(page.getByTestId("app-header")).toBeVisible({ timeout: 15_000 });
	dialog = await openSettings(page);
	await expect(dialog.getByRole("checkbox", { name: /Word wrap/ })).not.toBeChecked();
	await expect(dialog.getByTestId("editor-settings-delay")).toHaveValue("17");
});

test("each field reads label, control, then hint, and the hint describes the control", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await page.goto(workspacePath(student.workspaceId));
	await expect(page.getByTestId("app-header")).toBeVisible({ timeout: 15_000 });
	const dialog = await openSettings(page);

	const delay = dialog.getByRole("textbox", { name: "Auto-save delay", exact: true });
	await expect(delay).toHaveAccessibleDescription("Seconds, 1 to 60");
	await expect(
		dialog.getByRole("group", { name: "Color scheme" }),
	).toHaveAccessibleDescription("Light, dark, or follow this computer.");
	await expect(
		dialog.getByRole("switch", { name: "Light terminal" }),
	).toHaveAccessibleDescription("What a new terminal starts with.");

	// The hint sits below the control, as in every other field.
	const below = async (control: string, hint: string) => {
		const a = await dialog.getByRole("radio", { name: control }).boundingBox();
		const b = await dialog.getByText(hint, { exact: true }).boundingBox();
		return a !== null && b !== null && b.y >= a.y + a.height;
	};
	expect(await below("System", "Light, dark, or follow this computer.")).toBe(true);

	// The short label drops the unit, so search still finds the field by it.
	await dialog.getByLabel("Search").fill("seconds");
	await dialog.getByRole("button", { name: "Auto-save delay", exact: true }).click();
	await expect(delay).toBeFocused();
});

for (const colorScheme of ["light", "dark"] as const) {
	test(`Settings Preferences and Profile have no axe violations in ${colorScheme}`, async ({
		page,
		context,
	}) => {
		await page.emulateMedia({ colorScheme });
		const student = await createStudent(context);
		await page.goto(workspacePath(student.workspaceId));
		await expect(page.getByTestId("app-header")).toBeVisible({ timeout: 15_000 });

		const dialog = await openSettings(page);
		await dialog.getByRole("checkbox", { name: /Word wrap/ }).click();
		await expect(dialog.getByRole("status")).toHaveText("Saved");
		await expectNoViolations(page, "[data-testid=dialog-editor-settings]");

		// A toggletip opens from the keyboard, is checked with the dialog, and
		// Escape closes only the tip.
		const help = dialog.getByRole("button", { name: "About Screen reader mode" });
		await help.focus();
		await page.keyboard.press("Enter");
		const tip = page.locator(".pk-toggletip-content");
		await expect(tip).toContainText("does not reach a terminal");
		await expectNoViolations(
			page,
			"[data-testid=dialog-editor-settings]",
			".pk-toggletip-content",
		);
		await page.keyboard.press("Escape");
		await expect(tip).toHaveCount(0);
		await expect(dialog).toBeVisible();
		await expect(help).toBeFocused();

		await dialog.getByRole("button", { name: "Profile", exact: true }).click();
		// The picture field with its error showing: a file over the cap is refused before it is sent.
		await dialog.getByLabel("Profile picture").setInputFiles({
			name: "big.png",
			mimeType: "image/png",
			buffer: Buffer.alloc(1024 * 1024 + 1),
		});
		await expect(dialog.getByTestId("profile-picture-error")).toBeVisible();
		await dialog.getByLabel("Personal site").fill("javascript:alert(1)");
		await expect(dialog.getByText("Give an https:// link")).toBeVisible();
		await dialog.getByRole("button", { name: "About Workspace label" }).click();
		await expect(tip).toContainText("preview addresses");
		await expectNoViolations(
			page,
			"[data-testid=dialog-editor-settings]",
			".pk-toggletip-content",
		);
	});
}

test("a failed save is announced as an alert", async ({ page, context }) => {
	const student = await createStudent(context);
	await page.goto(workspacePath(student.workspaceId));
	await expect(page.getByTestId("app-header")).toBeVisible({ timeout: 15_000 });
	await page.route("**/me/settings", (route) =>
		route.request().method() === "PUT"
			? route.fulfill({
					status: 500,
					contentType: "application/json",
					body: JSON.stringify({ code: "INTERNAL", message: "Could not save." }),
				})
			: route.fallback(),
	);

	const dialog = await openSettings(page);
	const wrap = dialog.getByRole("checkbox", { name: /Word wrap/ });
	await expect(wrap).toBeChecked();
	await wrap.click();
	await expect(dialog.getByRole("alert")).toContainText("Could not save.");
	// The box goes back to what the server still holds.
	await expect(wrap).toBeChecked();
});
