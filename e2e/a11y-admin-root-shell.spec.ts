/**
 * Automated accessibility checks (SPEC.md section 25.8) on the admin Root
 * shell tab (ADR 0051): the empty tab, then two shells side by side, in the
 * light and dark themes and at the narrowest admin window.
 */
import { expect, type Locator, type Page, test } from "@playwright/test";
import { createSignedInUser, expectNoViolations, routeApi } from "./helpers";

for (const scheme of ["light", "dark"] as const) {
	test(`the Root shell tab has no automatic violations (${scheme})`, async ({
		page,
	}) => {
		await page.emulateMedia({ colorScheme: scheme });
		// The smallest admin window (SPEC.md section 20.1).
		await page.setViewportSize({ width: 768, height: 720 });
		await createSignedInUser(page.context(), "administrator");
		await page.goto("/admin/shell");
		await expect(page.getByText("No root shells open")).toBeVisible({
			timeout: 15_000,
		});
		await expectNoViolations(page);

		await page.getByRole("button", { name: "Open a root shell" }).click();
		const leaf = page.locator('[data-testid^="terminal-leaf-"]').first();
		const id = ((await leaf.getAttribute("data-testid")) ?? "").replace(
			"terminal-leaf-",
			"",
		);
		await expect(page.getByTestId(`terminal-pane-${id}`)).toHaveAttribute(
			"data-connected",
			"true",
			{ timeout: 15_000 },
		);
		await page.getByTestId(`terminal-actions-${id}`).click();
		await page.getByTestId("split-right").click();
		await expect(page.locator('[data-testid^="terminal-leaf-"]')).toHaveCount(2);
		const input = page.locator(
			`[data-testid="terminal-pane-${id}"] .xterm-helper-textarea`,
		);
		await expect(input).toHaveAccessibleDescription(/Alt\+Shift\+Q/);
		await expectNoViolations(page);
	});
}

test("Alt+Shift+Q leaves a root shell for its tab", async ({ page }) => {
	await createSignedInUser(page.context(), "administrator");
	await page.goto("/admin/shell");
	await page.getByRole("button", { name: "Open a root shell" }).click();
	const tab = page.getByRole("tab", { name: "Root shell 1" });
	await expect(tab).toBeVisible({ timeout: 15_000 });
	await page.locator(".xterm-screen").click();
	await page.keyboard.press("Alt+Shift+Q");
	await expect(tab).toBeFocused();
});

/** The ids of the root-shell panes in the shown tab, in order. */
async function paneIds(page: Page): Promise<string[]> {
	const ids = await page
		.locator('.pk-termgroup:not([hidden]) [data-testid^="terminal-leaf-"]')
		.evaluateAll((nodes) =>
			nodes.map((node) => node.getAttribute("data-testid") ?? ""),
		);
	return ids.map((id) => id.replace("terminal-leaf-", ""));
}

function input(page: Page, shellId: string): Locator {
	return page.locator(
		`[data-testid="terminal-pane-${shellId}"] .xterm-helper-textarea`,
	);
}

async function openShellTab(page: Page): Promise<string> {
	await createSignedInUser(page.context(), "administrator");
	await page.goto("/admin/shell");
	await page.getByRole("button", { name: "Open a root shell" }).click();
	await expect(page.locator('[data-testid^="terminal-leaf-"]')).toHaveCount(1, {
		timeout: 15_000,
	});
	const [id] = await paneIds(page);
	if (!id) throw new Error("no root shell pane");
	return id;
}

for (const scheme of ["light", "dark"] as const) {
	test(`a refused shell puts the keyboard on Try again, and passes axe (${scheme})`, async ({
		page,
	}) => {
		await page.emulateMedia({ colorScheme: scheme });
		await page.routeWebSocket(/\/admin\/root-shell\/ws/, (socket) => {
			socket.close({ code: 1000 });
		});
		await openShellTab(page);
		const retry = page.getByRole("button", { name: "Try again" });
		await expect(retry).toBeFocused({ timeout: 15_000 });
		await expect(page.getByTestId("root-shell-announce")).toHaveText(
			"A root shell could not start on the host.",
		);
		await expectNoViolations(page);
	});

	test(`the cap and restart flags pass axe, and losses together are announced once (${scheme})`, async ({
		page,
	}) => {
		await page.emulateMedia({ colorScheme: scheme });
		let code = 4429;
		await page.routeWebSocket(/\/admin\/root-shell\/ws/, (socket) => {
			socket.close({ code });
		});
		const id = await openShellTab(page);
		await expect(page.getByTestId(`root-shell-lost-${id}`)).toContainText(
			"too many terminals",
		);
		await expectNoViolations(page);

		code = 1001;
		await page.getByTestId("root-shell-new").click();
		await page.getByTestId("root-shell-new").click();
		const [restarted] = await paneIds(page);
		await expect(page.getByTestId(`root-shell-lost-${restarted}`)).toContainText(
			"Portikus restarted",
		);
		// One of the two is in a hidden tab; both are in the one announcement.
		await expect(page.getByTestId("root-shell-announce")).toHaveText(
			"Portikus restarted, so 2 root shells ended.",
		);
		await expectNoViolations(page);
	});

	test(`the Close this tab dialog passes axe and returns the keyboard to the tab now shown (${scheme})`, async ({
		page,
	}) => {
		await page.emulateMedia({ colorScheme: scheme });
		const first = await openShellTab(page);
		await page.getByTestId(`terminal-actions-${first}`).click();
		await page.getByTestId("split-right").click();
		await expect(page.locator('[data-testid^="terminal-leaf-"]')).toHaveCount(2);
		await page.getByTestId("root-shell-new").click();
		await expect(page.getByRole("tab")).toHaveCount(2);

		await page.getByRole("tab", { name: "Root shell 1" }).click();
		await page
			.getByRole("tab", { name: "Root shell 1" })
			.locator('[data-testid$="-close"]')
			.click();
		const dialog = page.getByRole("alertdialog", { name: "Close this tab?" });
		await expect(dialog).toBeVisible();
		await expectNoViolations(page);
		await dialog.getByRole("button", { name: "Close tab" }).click();

		const shown = page.getByRole("tab", { name: "Root shell 3" });
		await expect(shown).toHaveAttribute("aria-selected", "true");
		await expect(shown).toBeFocused();
	});
}

test("Close in a pane's menu moves the keyboard to the next pane, then to New root shell", async ({
	page,
}) => {
	const first = await openShellTab(page);
	await page.getByTestId(`terminal-actions-${first}`).click();
	await page.getByTestId("split-right").click();
	await expect(page.locator('[data-testid^="terminal-leaf-"]')).toHaveCount(2);
	const second = (await paneIds(page)).find((id) => id !== first) ?? "";

	await page.getByTestId(`terminal-actions-${first}`).focus();
	await page.keyboard.press("Enter");
	await page.getByRole("menuitem", { name: "Close" }).press("Enter");
	await expect(input(page, second)).toBeFocused();

	await page.getByTestId(`terminal-actions-${second}`).focus();
	await page.keyboard.press("Enter");
	await page.getByRole("menuitem", { name: "Close" }).press("Enter");
	await expect(page.getByTestId("root-shell-new")).toBeFocused();
});

for (const scheme of ["light", "dark"] as const) {
	test(`a root shell pane's actions menu passes axe while open (${scheme})`, async ({
		page,
	}) => {
		await page.emulateMedia({ colorScheme: scheme });
		const id = await openShellTab(page);
		await expect(page.getByTestId(`terminal-pane-${id}`)).toHaveAttribute(
			"data-connected",
			"true",
			{ timeout: 15_000 },
		);
		await page.getByTestId(`terminal-actions-${id}`).click();
		await expect(page.getByRole("menuitem", { name: "Close" })).toBeVisible();
		// The open menu hides the page behind it from assistive technology, so scan the menu alone.
		await expectNoViolations(page, '[role="menu"]');
	});

	test(`a shell hung up for a lost database says so and passes axe (${scheme})`, async ({
		page,
	}) => {
		await page.emulateMedia({ colorScheme: scheme });
		await page.routeWebSocket(/\/admin\/root-shell\/ws/, (socket) => {
			socket.send(Buffer.from("root@fake:~# "));
			socket.close({ code: 1011 });
		});
		const id = await openShellTab(page);
		await expect(page.getByTestId(`root-shell-lost-${id}`)).toContainText(
			"Anything running in tmux keeps running.",
		);
		await expect(page.getByTestId("root-shell-announce")).toHaveText(
			"Portikus lost its database connection, so a root shell was hung up.",
		);
		await expectNoViolations(page);
	});

	test(`the root-shells-off page passes axe (${scheme})`, async ({ page }) => {
		await page.emulateMedia({ colorScheme: scheme });
		await routeApi(page, "**/admin/root-shell", (route) =>
			route.fulfill({ json: { enabled: false } }),
		);
		await createSignedInUser(page.context(), "administrator");
		await page.goto("/admin/shell");
		await expect(page.getByTestId("root-shell-off")).toContainText(
			"Root shells are turned off on this server",
			{ timeout: 15_000 },
		);
		await expectNoViolations(page);
	});
}
