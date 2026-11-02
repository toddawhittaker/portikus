import { chromium, expect, test } from "@playwright/test";
import { createStudent, settledAxe, toast, WCAG_TAGS, workspacePath } from "./helpers";
import { FAKE_AGENT_URL } from "./ports";

/**
 * The reinstall note after a rebuild (SPEC.md §22.3, ADR 0042). The fake
 * agent stands in for the agent's comparison of the apt list with the
 * running image; each test seeds what it would answer.
 */

async function seedNote(workspaceId: string, packages: string[]): Promise<void> {
	const response = await fetch(`${FAKE_AGENT_URL}/__test/reinstall-note`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ key: workspaceId, packages }),
	});
	if (!response.ok)
		throw new Error(`the fake agent refused the note: ${response.status}`);
}

async function agentNote(workspaceId: string): Promise<string[]> {
	const response = await fetch(
		`${FAKE_AGENT_URL}/__test/reinstall-note?key=${workspaceId}`,
	);
	return ((await response.json()) as { packages: string[] }).packages;
}

const LEAD =
	"Packages you had installed with sudo apt were removed when your workspace was rebuilt";

test("after a rebuild the student sees what to reinstall and can copy the line", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await seedNote(student.workspaceId, ["python3-venv", "htop"]);
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);

	await page.goto(workspacePath(student.workspaceId));

	const notice = page.getByTestId("reinstall-notice");
	await expect(notice).toBeVisible({ timeout: 15_000 });
	// One sentence that ends with the packages, each in code style.
	const title = notice.getByTestId("reinstall-title");
	await expect(title).toHaveText(`${LEAD}: python3-venv, htop.`);
	await expect(title.locator("code")).toHaveText(["python3-venv", "htop"]);
	// The always-mounted status region announces the same words (SPEC.md §25.8).
	await expect(page.getByTestId("reinstall-announce")).toHaveText(
		`${LEAD}: python3-venv, htop.`,
	);
	await expect(notice).toContainText("Reinstall them with:");
	const command = notice.getByTestId("reinstall-command");
	await expect(command).toHaveText("sudo apt install python3-venv htop");
	// The icon replaces the old text button.
	await expect(notice.getByRole("button", { name: "Copy command" })).toHaveCount(1);
	await expect(notice.getByText("Copy command", { exact: true })).toHaveCount(0);

	const copy = notice.getByRole("button", { name: "Copy command" });
	const reveal = notice.getByTestId("reinstall-copy-wrap");

	// Hidden until the pointer is over the command.
	await page.mouse.move(0, 0);
	await expect(reveal).toHaveCSS("opacity", "0");
	await command.hover();
	await expect(reveal).toHaveCSS("opacity", "1");

	for (const scheme of ["light", "dark"] as const) {
		await page.emulateMedia({ colorScheme: scheme });
		await command.hover();
		await expect(reveal).toHaveCSS("opacity", "1");
		const results = await (await settledAxe(page))
			.include('[data-testid="reinstall-notice"]')
			.withTags(WCAG_TAGS)
			.analyze();
		expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
	}

	await copy.click();
	await expect(toast(page, "Command copied")).toBeVisible();
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
		"sudo apt install python3-venv htop",
	);
});

test("the copy icon shows on keyboard focus with a visible ring and copies on Enter", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await seedNote(student.workspaceId, ["htop"]);
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	await page.goto(workspacePath(student.workspaceId));
	const notice = page.getByTestId("reinstall-notice");
	await expect(notice).toBeVisible({ timeout: 15_000 });

	const copy = notice.getByRole("button", { name: "Copy command" });
	const reveal = notice.getByTestId("reinstall-copy-wrap");
	await page.mouse.move(0, 0);
	await expect(reveal).toHaveCSS("opacity", "0");

	for (const scheme of ["light", "dark"] as const) {
		await page.emulateMedia({ colorScheme: scheme });
		await copy.focus();
		await page.keyboard.press("Shift+Tab");
		await page.keyboard.press("Tab");
		await expect(copy).toBeFocused();
		await expect(reveal).toHaveCSS("opacity", "1");
		await expect(copy).toHaveCSS("outline-style", "solid");
		const results = await (await settledAxe(page))
			.include('[data-testid="reinstall-notice"]')
			.withTags(WCAG_TAGS)
			.analyze();
		expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
		await page.evaluate(() => (document.activeElement as HTMLElement).blur());
		await expect(reveal).toHaveCSS("opacity", "0");
	}

	await copy.focus();
	await page.keyboard.press("Enter");
	await expect(toast(page, "Command copied")).toBeVisible();
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
		"sudo apt install htop",
	);
});

test("one package reads as one sentence", async ({ page, context }) => {
	const student = await createStudent(context);
	await seedNote(student.workspaceId, ["file"]);
	await page.goto(workspacePath(student.workspaceId));
	const notice = page.getByTestId("reinstall-notice");
	await expect(notice).toBeVisible({ timeout: 15_000 });
	await expect(notice.getByTestId("reinstall-title")).toHaveText(`${LEAD}: file.`);
	await expect(notice.getByTestId("reinstall-command")).toHaveText(
		"sudo apt install file",
	);
});

test("at 360 px wide the notice does not scroll sideways and the icon stays reachable", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await seedNote(student.workspaceId, [
		"python3-venv",
		"build-essential",
		"libssl-dev-with-a-very-long-name-that-has-no-break-points-at-all",
	]);
	await page.setViewportSize({ width: 360, height: 800 });
	await page.goto(workspacePath(student.workspaceId));
	const notice = page.getByTestId("reinstall-notice");
	await expect(notice).toBeVisible({ timeout: 15_000 });

	const fits = await notice.evaluate((node) => ({
		notice: node.scrollWidth <= node.clientWidth,
		page: document.documentElement.scrollWidth <= document.documentElement.clientWidth,
	}));
	expect(fits).toEqual({ notice: true, page: true });

	const copy = notice.getByRole("button", { name: "Copy command" });
	const command = await notice.getByTestId("reinstall-command").boundingBox();
	await copy.focus();
	const icon = await copy.boundingBox();
	// The icon sits inside the command block.
	expect(icon && command && icon.x >= command.x).toBe(true);
	expect(icon && command && icon.x + icon.width <= command.x + command.width).toBe(
		true,
	);
	await expect(copy).toBeVisible();
});

test.describe("on a touch screen", () => {
	test.use({ hasTouch: true, isMobile: true });

	test("the copy icon is shown without any hover", async ({ page, context }) => {
		const student = await createStudent(context);
		await seedNote(student.workspaceId, ["htop"]);
		await page.goto(workspacePath(student.workspaceId));
		const notice = page.getByTestId("reinstall-notice");
		await expect(notice).toBeVisible({ timeout: 15_000 });
		await expect(notice.getByTestId("reinstall-copy-wrap")).toHaveCSS("opacity", "1");
	});
});

// A touchscreen laptop: a fine, hovering primary pointer (the trackpad) plus a
// coarse one (the screen). Playwright's hasTouch flips both, and test.use cannot
// set launch arguments inside a describe, so this test starts its own browser.
test("on a touchscreen laptop the copy icon is shown for a finger tap", async ({
	baseURL,
}) => {
	const browser = await chromium.launch({
		args: [
			"--blink-settings=primaryPointerType=4,availablePointerTypes=6,primaryHoverType=2,availableHoverTypes=2",
		],
	});
	try {
		const context = await browser.newContext({ baseURL });
		const page = await context.newPage();
		const student = await createStudent(context);
		await seedNote(student.workspaceId, ["htop"]);
		await page.goto(workspacePath(student.workspaceId));
		const notice = page.getByTestId("reinstall-notice");
		await expect(notice).toBeVisible({ timeout: 15_000 });
		expect(
			await page.evaluate(() => ({
				fine: matchMedia("(pointer: fine)").matches,
				hover: matchMedia("(hover: hover)").matches,
				anyCoarse: matchMedia("(any-pointer: coarse)").matches,
			})),
		).toEqual({ fine: true, hover: true, anyCoarse: true });
		await expect(notice.getByTestId("reinstall-copy-wrap")).toHaveCSS("opacity", "1");
	} finally {
		await browser.close();
	}
});

test("dismissing the note asks the workspace and it stays gone after a reload", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await seedNote(student.workspaceId, ["htop"]);
	await page.goto(workspacePath(student.workspaceId));
	const notice = page.getByTestId("reinstall-notice");
	await expect(notice).toBeVisible({ timeout: 15_000 });

	await notice.getByRole("button", { name: "Dismiss the reinstall notice" }).click();

	await expect(notice).toHaveCount(0);
	await expect(page.getByRole("main", { name: "Work area" })).toBeFocused();
	expect(await agentNote(student.workspaceId)).toEqual([]);
	await page.reload();
	await expect(page.getByTestId("workspace-state")).toHaveText("Running", {
		timeout: 15_000,
	});
	await expect(page.getByTestId("reinstall-notice")).toHaveCount(0);
});

test("with nothing removed there is no note", async ({ page, context }) => {
	const student = await createStudent(context);
	await page.goto(workspacePath(student.workspaceId));
	await expect(page.getByTestId("workspace-state")).toHaveText("Running", {
		timeout: 15_000,
	});
	await expect(page.getByTestId("reinstall-notice")).toHaveCount(0);
});
