import { expect, type Locator, type Page, test } from "@playwright/test";
import { openChat, openChatOptions } from "./chat-helpers";
import { createStudent, expectNoViolations } from "./helpers";
import { splitPane } from "./split-helpers";

/**
 * The composer's bottom row (SPEC.md §10.2, §10.8, §25.8): attach, the Chat
 * options button with a short summary of the settings, then the microphone
 * and Send at the end, always on one line. The agent, model, effort and
 * permission pickers and the read-aloud switch live in the options panel,
 * each named by its label and value. The composer is a size container, so
 * this holds for a narrow split pane in a wide window too.
 */

const PICKERS = [
	["Agent", "composer-agent", "Claude Code"],
	["Model", "composer-model", "Sonnet"],
	["Version", "composer-version", "Latest (5.5)"],
	["Effort", "composer-effort", "Medium"],
	["Permissions", "composer-mode", "Ask"],
] as const;

interface Row {
	/** Attach, Options, the microphone and Send share one line. */
	oneLine: boolean;
	/** Distance from Send to the inside edge of the composer's box. */
	sendFromEnd: number;
	/** The Options button ends before the microphone starts. */
	optionsClear: boolean;
}

async function rowOf(composer: Locator): Promise<Row> {
	return composer.evaluate((form) => {
		const box = (selector: string) => {
			const found = form.querySelector(selector);
			if (!found) throw new Error(`no ${selector}`);
			return found.getBoundingClientRect();
		};
		const middle = (r: DOMRect) => r.top + r.height / 2;
		const style = getComputedStyle(form);
		const edge = form.getBoundingClientRect();
		const pad = parseFloat(style.paddingRight) + parseFloat(style.borderRightWidth);
		const tools = box(".pk-composer-tools");
		const options = box("[data-testid=composer-options]");
		const send = box("[data-testid=chat-composer-send]");
		const mic = box("[data-testid^=chat-voice-]:not([data-testid*=status])");
		const line = middle(tools);
		return {
			oneLine: [options, mic, send].every((one) => Math.abs(middle(one) - line) < 4),
			sendFromEnd: edge.right - pad - send.right,
			optionsClear: options.right <= mic.left,
		};
	});
}

function expectPinned(row: Row) {
	expect(row.oneLine).toBe(true);
	// Send sits at the end of the line, not a few pixels short of it.
	expect(Math.abs(row.sendFromEnd)).toBeLessThanOrEqual(1);
	expect(row.optionsClear).toBe(true);
}

async function chooseOption(page: Page, view: Locator, testId: string, name: string) {
	await view.getByTestId(testId).click();
	await page.getByRole("menuitemradio", { name, exact: true }).click();
	await expect(page.getByRole("menu")).toHaveCount(0);
}

/** A chat whose pickers have the host's first settings, optionally at the widest values. */
async function openRow(
	page: Page,
	context: Parameters<typeof createStudent>[0],
	widest = false,
) {
	const student = await createStudent(context);
	const chat = await openChat(page, student.workspaceId, "Row");
	await expect(chat.view.getByTestId("composer-model")).toBeAttached({
		timeout: 15_000,
	});
	if (widest) {
		await openChatOptions(chat.view);
		await chooseOption(page, chat.view, "composer-effort", "Extra high");
		await chooseOption(page, chat.view, "composer-mode", "Bypass permissions");
		await page.keyboard.press("Escape");
		await expect(chat.view.getByTestId("composer-picks")).toBeHidden();
	}
	return { ...chat, student };
}

for (const colorScheme of ["light", "dark"] as const) {
	for (const [name, width] of [
		["a wide window", 1800],
		["an 800 px window", 800],
		["a 420 px window", 420],
	] as const) {
		test(`${name}: one line, and the options panel names every setting (${colorScheme})`, async ({
			page,
			context,
		}) => {
			await page.emulateMedia({ colorScheme });
			await page.setViewportSize({ width, height: 900 });
			const { view } = await openRow(page, context);
			expectPinned(await rowOf(view.getByTestId("chat-composer")));

			const options = view.getByTestId("composer-options");
			await expect(options).toHaveAccessibleName("Chat options: Sonnet · Medium · Ask");
			await expect(options).toHaveAttribute("aria-expanded", "false");
			await expect(view.getByTestId("composer-picks")).toBeHidden();
			await expectNoViolations(page, '[data-testid="chat-composer"]');

			await openChatOptions(view);
			await expect(options).toHaveAttribute("aria-expanded", "true");
			for (const [label, testId, value] of PICKERS) {
				const button = view.getByTestId(testId);
				await expect(button).toBeVisible();
				await expect(button).toHaveAccessibleName(`${label} ${value}`);
			}
			// The panel stays inside the window.
			const panel = await view.getByTestId("composer-picks").boundingBox();
			if (!panel) throw new Error("no panel");
			expect(panel.x).toBeGreaterThanOrEqual(0);
			expect(panel.x + panel.width).toBeLessThanOrEqual(width);
			expect(panel.y).toBeGreaterThanOrEqual(0);
			// Opening the panel moves nothing on the row.
			expectPinned(await rowOf(view.getByTestId("chat-composer")));
			await expectNoViolations(page, '[data-testid="chat-composer"]');
		});
	}

	test(`the widest values never push the microphone or Send off the line (${colorScheme})`, async ({
		page,
		context,
	}) => {
		await page.emulateMedia({ colorScheme });
		await page.setViewportSize({ width: 1800, height: 900 });
		const { view } = await openRow(page, context, true);
		const composer = view.getByTestId("chat-composer");
		const holder = view.locator(".pk-chat-composer");
		const options = view.getByTestId("composer-options");
		await expect(options).toHaveAccessibleName(
			"Chat options: Sonnet · Extra high · Bypass permissions",
		);
		// Bypass shows on the closed panel's button too.
		await expect(options).toHaveClass(/is-warning/);
		for (let width = 300; width <= 960; width += 12) {
			await holder.evaluate((el, px) => {
				(el as HTMLElement).style.inlineSize = `${px}px`;
				(el as HTMLElement).style.paddingInline = "0";
			}, width);
			expectPinned(await rowOf(composer));
		}
		await expectNoViolations(page, '[data-testid="chat-composer"]');
	});
}

test("a narrow split pane in a wide window keeps the row on one line", async ({
	page,
	context,
}) => {
	await page.setViewportSize({ width: 1500, height: 900 });
	const { id, view: first } = await openRow(page, context);
	await splitPane(page, id, "right", "claude-gui");
	const second = page.locator("[data-testid^='chat-view-']").nth(1);
	await expect(second.getByTestId("composer-model")).toBeAttached({ timeout: 15_000 });
	await expect(first.getByTestId("chat-composer")).toBeVisible();
	expectPinned(await rowOf(first.getByTestId("chat-composer")));
	expectPinned(await rowOf(second.getByTestId("chat-composer")));
});

test("the row and the panel work from the keyboard alone", async ({
	page,
	context,
}) => {
	await page.setViewportSize({ width: 420, height: 900 });
	const { view } = await openRow(page, context);
	const options = view.getByTestId("composer-options");
	await view.getByTestId("chat-composer-attach").focus();
	await page.keyboard.press("Tab");
	await expect(options).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(view.getByTestId("composer-picks")).toBeVisible();
	// The read-aloud switch in the heading row comes first, then the settings as drawn.
	await page.keyboard.press("Tab");
	await expect(view.getByRole("switch", { name: "Read replies aloud" })).toBeFocused();
	for (const [, testId] of PICKERS) {
		await page.keyboard.press("Tab");
		await expect(view.getByTestId(testId)).toBeFocused();
	}
	// Escape closes the panel and hands focus back to its button.
	await page.keyboard.press("Escape");
	await expect(view.getByTestId("composer-picks")).toBeHidden();
	await expect(options).toBeFocused();
	await page.keyboard.press("Tab");
	await expect(
		view.locator("[data-testid^=chat-voice-]:not([data-testid*=status])"),
	).toBeFocused();
	await page.keyboard.press("Tab");
	await expect(view.getByTestId("chat-composer-send")).toBeFocused();
});

test("a press outside the panel closes it, and the composer's focus ring is one 2px focus-colour line", async ({
	page,
	context,
}) => {
	const { view } = await openRow(page, context);
	await openChatOptions(view);
	await view.getByTestId("chat-composer-input").click();
	await expect(view.getByTestId("composer-picks")).toBeHidden();
	const ring = await view.getByTestId("chat-composer").evaluate((form) => {
		const style = getComputedStyle(form);
		return {
			border: style.borderTopColor,
			outline: style.outlineColor,
			width: style.outlineWidth,
			offset: style.outlineOffset,
		};
	});
	// The 2px outline lies over the 1px border, so one line shows.
	expect(ring.outline).toBe(ring.border);
	expect(ring.width).toBe("2px");
	expect(ring.offset).toBe("-1px");
});

test("on a phone the Options button is a full touch target", async ({
	page,
	context,
}) => {
	await page.setViewportSize({ width: 390, height: 844 });
	const { view } = await openRow(page, context);
	const box = await view.getByTestId("composer-options").boundingBox();
	expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
	expectPinned(await rowOf(view.getByTestId("chat-composer")));
});
