import { expect, type Locator, type Page, test } from "@playwright/test";
import {
	lockSharedState,
	loginAs,
	query,
	SETTINGS_ROW_LOCK,
	settledAxe,
	WCAG_TAGS,
} from "./helpers";
import { expectTokenFill } from "./token-colour";

/**
 * The Settings tab (SPEC.md section 20.1): five sections, each with its
 * own Save, a section index beside them on a wide page and above them on a
 * narrow one, and rows that lay out by their card's width. These tests
 * write the one settings row, so they run one after another under a lock
 * every worker shares. Each save sends only the fields it changed.
 */
test.describe.configure({ mode: "serial" });

let release: (() => Promise<void>) | undefined;

test.beforeAll(async () => {
	// The wait for other workers' repeats counts against this hook.
	test.setTimeout(600_000);
	release = await lockSharedState(SETTINGS_ROW_LOCK);
});

test.afterAll(async () => {
	await query("update settings set account_email_enabled = false where id = 1");
	await release?.();
});

async function box(locator: Locator) {
	const found = await locator.boundingBox();
	if (!found) throw new Error("not visible");
	return found;
}

async function open(page: Page) {
	await loginAs(page, "carol");
	await page.goto("/admin/settings");
	await expect(page.getByTestId("settings-idleStopMinutes")).not.toHaveValue("", {
		timeout: 15_000,
	});
	await expect(page.getByTestId("notify-loading")).toHaveCount(0);
}

const SECTIONS = [
	"When workspaces stop",
	"Resource guard",
	"Student tools",
	"Acceptable use",
	"Email and alerts",
];

test.describe("at 1280 px", () => {
	test.use({ viewport: { width: 1280, height: 900 } });

	test("five cards in one column, the index beside them, rows label left and box right", async ({
		page,
	}) => {
		await open(page);
		const column = page.getByTestId("settings-sections");
		await expect(column.getByRole("heading", { level: 3 })).toHaveText(SECTIONS);
		const cards = column.locator(":scope > section");
		await expect(cards).toHaveCount(5);
		for (let index = 0; index < 5; index++) {
			await expectTokenFill(cards.nth(index), "--surface-raised");
			await expect(cards.nth(index)).toHaveCSS("border-left-width", "1px");
		}
		const index = page.getByRole("navigation", { name: "Settings sections" });
		const indexBox = await box(index);
		const columnBox = await box(column);
		expect(indexBox.x + indexBox.width).toBeLessThan(columnBox.x);
		// The index stays in view while the page scrolls.
		await expect(index).toHaveCSS("position", "sticky");

		// The label sits left of its box, on the same row.
		const label = await box(page.locator('label[for="settings-idleStopMinutes"]'));
		const input = await box(page.getByTestId("settings-idleStopMinutes"));
		expect(input.x).toBeGreaterThan(label.x + label.width);
		expect(Math.abs(input.y - label.y)).toBeLessThan(input.height);
		await expect(page.getByTestId("log-level-select")).toHaveCount(0);
	});

	test("an index link moves to its section without asking, even with unsaved changes", async ({
		page,
	}) => {
		await open(page);
		await page.getByTestId("settings-idleStopMinutes").fill("45");
		await page
			.getByRole("navigation", { name: "Settings sections" })
			.getByRole("link", { name: "Acceptable use" })
			.click();
		await expect(page).toHaveURL(/\/admin\/settings#settings-aup$/);
		await expect(page.getByRole("alertdialog")).toHaveCount(0);
		await expect(
			page.getByRole("heading", { name: "Acceptable use" }),
		).toBeInViewport();
		await expect(page.getByTestId("settings-idleStopMinutes")).toHaveValue("45");
	});
});

test.describe("at 390 px", () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test("the index wraps above the sections, rows stack, and nothing scrolls sideways", async ({
		page,
	}) => {
		await open(page);
		const index = await box(
			page.getByRole("navigation", { name: "Settings sections" }),
		);
		const first = await box(page.getByTestId("settings-stop"));
		expect(index.y + index.height).toBeLessThanOrEqual(first.y);
		const label = await box(page.locator('label[for="settings-idleStopMinutes"]'));
		const input = await box(page.getByTestId("settings-idleStopMinutes"));
		expect(input.y).toBeGreaterThan(label.y + label.height);
		const overflow = await page
			.getByTestId("page-admin")
			.evaluate((main) => main.scrollWidth - main.clientWidth);
		expect(overflow).toBeLessThanOrEqual(0);
	});
});

test("the grace period is shown and saved in minutes, stored in seconds", async ({
	page,
}) => {
	const [before] = await query<{ seconds: number }>(
		"select shutdown_grace_seconds as seconds from settings where id = 1",
	);
	try {
		await open(page);
		const input = page.getByRole("textbox", { name: "Disconnect grace" });
		await input.fill("90");
		await expect(page.getByTestId("settings-stop-state")).toHaveText(
			"1 unsaved change",
		);
		// Enter saves: the section is one form.
		await input.press("Enter");
		await expect(page.getByTestId("settings-stop-state")).toHaveText("Saved.");
		const [row] = await query<{ seconds: number }>(
			"select shutdown_grace_seconds as seconds from settings where id = 1",
		);
		expect(row?.seconds).toBe(5400);
		await page.reload();
		await expect(page.getByTestId("settings-shutdownGraceSeconds")).toHaveValue("90", {
			timeout: 15_000,
		});
		await expect(page.getByTestId("settings-last-changed")).toContainText(
			"Last changed",
		);

		await page.getByTestId("settings-shutdownGraceSeconds").fill("ten");
		await page.getByRole("button", { name: "Save stop times" }).click();
		await expect(page.locator("#settings-shutdownGraceSeconds-err")).toHaveText(
			"Enter a number of minutes, 0 or more.",
		);
		await expect(page.getByTestId("settings-shutdownGraceSeconds")).toBeFocused();
	} finally {
		await query("update settings set shutdown_grace_seconds = $1 where id = 1", [
			before?.seconds ?? 600,
		]);
	}
});

test("the stop times work from the keyboard alone, with no help buttons between fields", async ({
	page,
}) => {
	const [before] = await query<{ minutes: number }>(
		"select idle_stop_minutes as minutes from settings where id = 1",
	);
	try {
		await open(page);
		await page.getByTestId("settings-shutdownGraceSeconds").focus();
		await page.keyboard.press("Tab");
		await expect(page.getByTestId("settings-idleStopMinutes")).toBeFocused();
		await page.keyboard.press("ControlOrMeta+A");
		await page.keyboard.type("45");
		await page.keyboard.press("Tab");
		await expect(page.getByTestId("settings-keepRunningMaxHours")).toBeFocused();
		await page.keyboard.press("Tab");
		await expect(page.getByRole("button", { name: "Discard changes" })).toBeFocused();
		await page.keyboard.press("Tab");
		await expect(page.getByRole("button", { name: "Save stop times" })).toBeFocused();
		await page.keyboard.press("Enter");
		await expect(page.getByTestId("settings-stop-state")).toHaveText("Saved.");
		const [row] = await query<{ minutes: number }>(
			"select idle_stop_minutes as minutes from settings where id = 1",
		);
		expect(row?.minutes).toBe(45);
	} finally {
		await query("update settings set idle_stop_minutes = $1 where id = 1", [
			before?.minutes ?? 60,
		]);
	}
});

for (const colorScheme of ["light", "dark"] as const) {
	test(`the Settings tab has no automatic accessibility violations (${colorScheme})`, async ({
		page,
	}) => {
		await page.emulateMedia({ colorScheme });
		await open(page);
		// With an unsaved change and an error showing, so those states are checked too.
		await page.getByTestId("settings-shutdownGraceSeconds").fill("15");
		await page.getByRole("textbox", { name: "Measuring period" }).fill("1");
		await page.getByRole("button", { name: "Save resource guard" }).click();
		await expect(page.getByTestId("settings-guard-state")).toHaveText(/^Not saved\./);
		const results = await (await settledAxe(page)).withTags(WCAG_TAGS).analyze();
		expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
	});
}

/** A computed colour property of `node` equals what a theme token resolves to in the same document. */
async function expectToken(
	node: Locator,
	property: "backgroundColor" | "borderTopColor" | "color",
	token: string,
) {
	const { actual, expected } = await node.evaluate(
		(element, [prop, name]) => {
			const probe = document.createElement("span");
			// A border colour reads back as its own property only once it is set as one.
			const set = prop === "borderTopColor" ? "borderColor" : prop;
			probe.style[set as "color"] = `var(${name})`;
			element.append(probe);
			const colour = getComputedStyle(probe)[prop as "color"];
			probe.remove();
			return { actual: getComputedStyle(element)[prop as "color"], expected: colour };
		},
		[property, token],
	);
	expect(actual).toBe(expected);
}

for (const colorScheme of ["light", "dark"] as const) {
	test(`a Coming later row is drawn muted and cannot be ticked (${colorScheme})`, async ({
		page,
	}) => {
		await page.emulateMedia({ colorScheme });
		await open(page);
		const tools = page.getByRole("region", { name: "Student tools" });
		const java = tools.getByRole("checkbox", { name: "Java", exact: true });
		const label = tools.locator("label.pk-check", {
			has: page.getByRole("checkbox", { name: "Java", exact: true }),
		});
		const face = label.locator(".pk-check-box");
		const python = tools.locator("label.pk-check", {
			has: page.getByRole("checkbox", { name: "Python" }),
		});

		await expect(java).toHaveAttribute("aria-disabled", "true");
		await expectToken(face, "backgroundColor", "--surface-sunken");
		await expectToken(face, "borderTopColor", "--line");
		await expectToken(label, "color", "--ink-muted");
		// An available language keeps the raised box with the stronger line.
		await expectToken(python.locator(".pk-check-box"), "borderTopColor", "--accent");

		// Hovering changes nothing.
		await label.hover();
		await expectToken(face, "backgroundColor", "--surface-sunken");
		await expectToken(face, "borderTopColor", "--line");

		// Neither a click nor Space ticks it, and nothing becomes unsaved.
		await label.click({ force: true });
		await expect(java).not.toBeChecked();
		await java.focus();
		await page.keyboard.press("Space");
		await expect(java).not.toBeChecked();
		// The focus ring is unchanged, so the row can still be found by keyboard.
		await expect(face).toHaveCSS("outline-style", "solid");
		await expect(page.getByTestId("settings-tools-state")).toHaveText(
			"No unsaved changes.",
		);
	});
}

test("account email waits for Save, says it uses the mail server, and each change is audited", async ({
	page,
}) => {
	await query("update settings set account_email_enabled = false where id = 1");
	await open(page);
	const section = page.getByTestId("settings-mail");
	const box = section.getByRole("checkbox", {
		name: "Email password reset and invitation links",
	});
	await expect(box).toHaveAccessibleDescription(
		/Sends through the mail server above\./,
	);
	await expect(box).not.toBeChecked();

	await section.getByText("Email password reset and invitation links").click();
	await expect(box).toBeChecked();
	// Nothing saves on a click.
	const [unsaved] = await query<{ on: boolean }>(
		"select account_email_enabled as on from settings where id = 1",
	);
	expect(unsaved?.on).toBe(false);
	await section.getByRole("button", { name: "Save email and alerts" }).click();
	await expect(page.getByTestId("settings-mail-state")).toHaveText("Saved.");
	const audit = await query<{ metadata: unknown }>(
		"select metadata from audit_events where action = 'settings.account_email_updated' order by id desc limit 1",
	);
	expect(audit[0]?.metadata).toMatchObject({ from: false, to: true });

	await page.reload();
	await expect(box).toBeChecked({ timeout: 15_000 });
	await section.getByText("Email password reset and invitation links").click();
	await section.getByRole("button", { name: "Save email and alerts" }).click();
	await expect(page.getByTestId("settings-mail-state")).toHaveText("Saved.");
	await expect(box).not.toBeChecked();
});
