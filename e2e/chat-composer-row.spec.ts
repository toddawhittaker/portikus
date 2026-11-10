import { expect, type Locator, type Page, test } from "@playwright/test";
import { openChat } from "./chat-helpers";
import { createStudent, expectNoViolations } from "./helpers";
import { splitPane } from "./split-helpers";

/**
 * The composer's bottom row (SPEC.md §10.2, §25.8). The microphone and Send
 * stay at the end of the first line; only the pickers move, as a group, to a
 * line of their own. A narrow composer shows each picker's value alone, but
 * every button keeps its prefix word in its name. The composer is a size
 * container, so these hold for a narrow split pane in a wide window too.
 */

/** Where the composer's container queries switch, measured against the widest values. */
const LABELS_FULL_FROM_REM = 55;
const ONE_LINE_FROM_REM = 40;

const PICKERS = [
	["Agent", "composer-agent", "Claude Code"],
	["Model", "composer-model", "Sonnet"],
	["Effort", "composer-effort", "Medium"],
	["Permissions", "composer-mode", "Ask"],
] as const;

interface Row {
	/** The composer's inside width, which the container queries read. */
	inside: number;
	/** The pickers share the first line with the tools, microphone and Send. */
	oneLine: boolean;
	/** The four pickers sit on one line among themselves. */
	pickersTogether: boolean;
	/** The prefix word is showing. */
	fullLabels: boolean;
	/** Distance from Send to the inside edge of the composer's box. */
	sendFromEnd: number;
	/** Tools, microphone and Send share one line. */
	actionsOnFirstLine: boolean;
	/** Nothing in the picker group sticks out sideways. */
	fits: boolean;
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
		const padLeft = parseFloat(style.paddingLeft) + parseFloat(style.borderLeftWidth);
		const tools = box(".pk-composer-tools");
		const send = box("[data-testid=chat-composer-send]");
		const mic = box("[data-testid^=chat-voice-]:not([data-testid*=status])");
		const picks = box(".pk-composer-picks");
		const tops = [...form.querySelectorAll<HTMLElement>(".pk-picker")].map((one) =>
			Math.round(one.getBoundingClientRect().top),
		);
		const label = box("[data-testid=composer-agent] .pk-picker-label");
		const group = form.querySelector<HTMLElement>(".pk-composer-picks");
		return {
			inside: edge.width - pad - padLeft,
			oneLine: Math.abs(middle(picks) - middle(tools)) < 4,
			pickersTogether: new Set(tops).size === 1,
			fullLabels: label.width > 4,
			sendFromEnd: edge.right - pad - send.right,
			actionsOnFirstLine:
				Math.abs(middle(mic) - middle(tools)) < 4 &&
				Math.abs(middle(send) - middle(tools)) < 4,
			fits: !group || group.scrollWidth <= group.clientWidth,
		};
	});
}

/** The invariants that hold at every width. */
function expectPinned(row: Row) {
	expect(row.actionsOnFirstLine).toBe(true);
	// Send sits at the end of the line, not a few pixels short of it.
	expect(Math.abs(row.sendFromEnd)).toBeLessThanOrEqual(1);
	// Below this the four widest short values cannot share a line, so the group wraps inside.
	if (row.inside >= 440) expect(row.pickersTogether).toBe(true);
	expect(row.fits).toBe(true);
}

/** The labels and the line follow the composer's own width, in rem. */
function expectBreakpoints(row: Row) {
	const rem = 16;
	expect(row.fullLabels).toBe(row.inside >= LABELS_FULL_FROM_REM * rem);
	expect(row.oneLine).toBe(row.inside >= ONE_LINE_FROM_REM * rem);
	// Full labels are never the reason the pickers wrap.
	if (row.fullLabels) expect(row.oneLine).toBe(true);
}

function picker(view: Locator, testId: string): Locator {
	return view.getByTestId(testId);
}

async function chooseOption(page: Page, view: Locator, testId: string, name: string) {
	await picker(view, testId).click();
	await page.getByRole("menuitemradio", { name, exact: true }).click();
	await expect(page.getByRole("menu")).toHaveCount(0);
}

/** A chat whose pickers have the host's first settings, optionally at the widest values. */
async function openPickers(
	page: Page,
	context: Parameters<typeof createStudent>[0],
	widest = false,
) {
	const student = await createStudent(context);
	const chat = await openChat(page, student.workspaceId, "Row");
	await expect(picker(chat.view, "composer-model")).toBeVisible({ timeout: 15_000 });
	if (widest) {
		await chooseOption(page, chat.view, "composer-effort", "Extra high");
		await chooseOption(page, chat.view, "composer-mode", "Bypass permissions");
	}
	return { ...chat, student };
}

for (const colorScheme of ["light", "dark"] as const) {
	for (const [name, width] of [
		["a wide window", 1800],
		["an 800 px window", 800],
		["a 420 px window", 420],
	] as const) {
		test(`${name}: the microphone and Send stay on the first line (${colorScheme})`, async ({
			page,
			context,
		}) => {
			await page.emulateMedia({ colorScheme });
			await page.setViewportSize({ width, height: 900 });
			const { view } = await openPickers(page, context);
			const row = await rowOf(view.getByTestId("chat-composer"));
			expectPinned(row);
			expectBreakpoints(row);
			if (width === 1800) {
				expect(row.fullLabels).toBe(true);
				expect(row.oneLine).toBe(true);
			}
			if (width === 420) {
				expect(row.fullLabels).toBe(false);
				expect(row.oneLine).toBe(false);
			}

			// Visible words follow the width; names and tooltips never do.
			for (const [label, testId, value] of PICKERS) {
				const button = picker(view, testId);
				await expect(button).toHaveAccessibleName(`${label} ${value}`);
				// A native title shows on mouse hover only (SPEC.md §25.8).
				await expect(button).not.toHaveAttribute("title");
			}
			// Keyboard focus shows the whole label in the short form, and nothing in
			// the full form, where every word is already on screen.
			const tip = page.locator(".pk-tooltip");
			await view.getByTestId("chat-composer-attach").focus();
			for (const [label, testId, value] of PICKERS) {
				await page.keyboard.press("Tab");
				const button = picker(view, testId);
				await expect(button).toBeFocused();
				if (row.fullLabels) {
					await expect(tip).toHaveCount(0);
				} else {
					await expect(tip).toBeVisible();
					await expect(tip).toHaveText(`${label} ${value}`);
					await expectNoViolations(page, ".pk-tooltip");
				}
				// The name carries the words once; the tooltip adds no description.
				await expect(button).toHaveAccessibleName(`${label} ${value}`);
				await expect(button).toHaveAccessibleDescription("");
			}
			// The agent's second word is hidden by the same rule as the prefix.
			const more = await picker(view, "composer-agent")
				.locator(".pk-picker-more")
				.boundingBox();
			expect((more?.width ?? 0) > 4).toBe(row.fullLabels);

			await expectNoViolations(page, '[data-testid="chat-composer"]');
		});
	}

	test(`the widest values never push the microphone or Send off the first line (${colorScheme})`, async ({
		page,
		context,
	}) => {
		await page.emulateMedia({ colorScheme });
		await page.setViewportSize({ width: 1800, height: 900 });
		const { view } = await openPickers(page, context, true);
		const composer = view.getByTestId("chat-composer");
		const holder = view.locator(".pk-chat-composer");
		const seen = new Set<string>();
		// Every 12 px across the range, a little either side of both breakpoints.
		for (let width = 340; width <= 960; width += 12) {
			await holder.evaluate((el, px) => {
				(el as HTMLElement).style.inlineSize = `${px}px`;
				(el as HTMLElement).style.paddingInline = "0";
			}, width);
			const row = await rowOf(composer);
			expectPinned(row);
			expectBreakpoints(row);
			seen.add(`${row.fullLabels}/${row.oneLine}`);
		}
		// All three states were reached: full on one line, short on one line, short below.
		expect([...seen].sort()).toEqual(["false/false", "false/true", "true/true"]);
		await expect(picker(view, "composer-mode")).toHaveAccessibleName(
			"Permissions Bypass permissions",
		);
		await expectNoViolations(page, '[data-testid="chat-composer"]');
	});
}

test("a narrow split pane in a wide window gets the short form from its own width", async ({
	page,
	context,
}) => {
	await page.setViewportSize({ width: 1500, height: 900 });
	const { id, view: first } = await openPickers(page, context);
	await splitPane(page, id, "right", "claude-gui");
	const second = page.locator("[data-testid^='chat-view-']").nth(1);
	await expect(second.getByTestId("composer-model")).toBeVisible({ timeout: 15_000 });
	await expect(first.getByTestId("chat-composer")).toBeVisible();

	const rows = [
		await rowOf(first.getByTestId("chat-composer")),
		await rowOf(second.getByTestId("chat-composer")),
	];
	for (const row of rows) {
		expectPinned(row);
		expectBreakpoints(row);
		// Half of the window is narrower than the full-label width.
		expect(row.inside).toBeLessThan(LABELS_FULL_FROM_REM * 16);
		expect(row.fullLabels).toBe(false);
	}
	await expect(picker(second, "composer-agent")).toHaveAccessibleName(
		"Agent Claude Code",
	);
});

test("the row stays reachable from the keyboard in the short form", async ({
	page,
	context,
}) => {
	await page.setViewportSize({ width: 420, height: 900 });
	const { view } = await openPickers(page, context);
	await view.getByTestId("chat-composer-attach").focus();
	for (const [, testId] of PICKERS) {
		await page.keyboard.press("Tab");
		await expect(picker(view, testId)).toBeFocused();
	}
	// The read-aloud switch ends the row of settings.
	await page.keyboard.press("Tab");
	await expect(view.getByRole("switch", { name: "Read replies aloud" })).toBeFocused();
	await page.keyboard.press("Tab");
	await expect(
		view.locator("[data-testid^=chat-voice-]:not([data-testid*=status])"),
	).toBeFocused();
	await page.keyboard.press("Tab");
	await expect(view.getByTestId("chat-composer-send")).toBeFocused();
});
