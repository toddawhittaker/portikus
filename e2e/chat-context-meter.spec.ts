import {
	type BrowserContext,
	expect,
	type Locator,
	type Page,
	test,
} from "@playwright/test";
import { openChat } from "./chat-helpers";
import { createStudent, expectNoViolations } from "./helpers";
import { FAKE_AGENT_URL } from "./ports";
import { splitPane } from "./split-helpers";

/**
 * Each chat tab's context and prompt-cache readouts (SPEC.md §10.8, §25.8). They sit in that tab's picker row and come from the host's
 * `context` event. The context shows once over half full and warns near
 * full; the cache clock shows whenever the host reports one. The ticking
 * digits are not read, and the status region announces only the moment the
 * cache goes cold and the context passing 80%.
 */

interface Cache {
	at: number;
	ttlSeconds: 300 | 3600;
}

/** Send a `context` event to every attachment of the chat, as the host does. */
async function setContext(
	id: string,
	body: { usedTokens: number; windowTokens: number | null; cache: Cache | null },
) {
	const sent = await fetch(`${FAKE_AGENT_URL}/__test/chats/${id}/context`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	expect(sent.ok).toBe(true);
}

/** A cache written `agoSeconds` ago. */
function written(agoSeconds: number, ttlSeconds: 300 | 3600 = 300): Cache {
	return { at: Date.now() - agoSeconds * 1000, ttlSeconds };
}

async function openMeter(page: Page, context: BrowserContext) {
	const student = await createStudent(context);
	const chat = await openChat(page, student.workspaceId, "Meter");
	await expect(chat.view.getByTestId("composer-model")).toBeVisible({
		timeout: 15_000,
	});
	return chat;
}

/** What a screen reader gets from the readout: the ticking digits are left out. */
async function spoken(readout: Locator): Promise<string> {
	return readout.ariaSnapshot();
}

test("nothing shows until the host reports", async ({ page, context }) => {
	const { view } = await openMeter(page, context);
	await expect(view.getByTestId("composer-context")).toHaveCount(0);
	await expect(view.getByTestId("composer-cache")).toHaveCount(0);
});

test("the context shows once over half full, with the /compact hint", async ({
	page,
	context,
}) => {
	const { id, view } = await openMeter(page, context);
	const meter = view.getByTestId("composer-context");

	await setContext(id, { usedTokens: 90_000, windowTokens: 200_000, cache: null });
	await expect(meter).toHaveCount(0);

	await setContext(id, { usedTokens: 144_000, windowTokens: 200_000, cache: null });
	await expect(meter).toBeVisible();
	await expect(meter).toContainText("Context 72%");
	await expect(meter).toHaveAttribute("title", /\/compact/);
	expect(await spoken(meter)).toContain("Run /compact to free up space.");

	// An unknown window hides the percentage.
	await setContext(id, { usedTokens: 144_000, windowTokens: null, cache: null });
	await expect(meter).toHaveCount(0);
});

test("the cache clock counts down, and its digits are not read", async ({
	page,
	context,
}) => {
	const { id, view } = await openMeter(page, context);
	await setContext(id, { usedTokens: 1000, windowTokens: 200_000, cache: written(10) });
	const cache = view.getByTestId("composer-cache");
	await expect(cache).toContainText(/Cache [45]:\d\d/);
	await expect(cache).toHaveAttribute("data-state", "warm");

	const first = await cache.locator(".pk-ctx-sight").textContent();
	await expect
		.poll(() => cache.locator(".pk-ctx-sight").textContent(), { timeout: 5000 })
		.not.toBe(first);

	const words = await spoken(cache);
	expect(words).toMatch(/Prompt cache: warm, goes cold at \d{1,2}:\d\d/);
	expect(words).not.toMatch(/Cache [45]:\d\d/);
	await expect(cache.locator(".pk-ctx-sight")).toHaveAttribute("aria-hidden", "true");
	// Ticking reaches the status region not at all.
	await expect(view.getByTestId("chat-composer-status")).toHaveText("");
});

test("the last minute warns in words and an icon, then it goes cold and is announced once", async ({
	page,
	context,
}) => {
	const { id, view } = await openMeter(page, context);
	const status = view.getByTestId("chat-composer-status");
	// Four seconds from cold.
	await setContext(id, {
		usedTokens: 1000,
		windowTokens: 200_000,
		cache: written(296),
	});
	const cache = view.getByTestId("composer-cache");
	await expect(cache).toHaveAttribute("data-state", "soon");
	await expect(cache).toContainText("soon");
	await expect(cache.locator("svg")).toBeVisible();
	await expect(status).toHaveText("");

	await expect(cache).toHaveAttribute("data-state", "cold", { timeout: 10_000 });
	await expect(cache).toContainText("Cache cold");
	await expect(status).toContainText("The prompt cache went cold at");
	expect(await spoken(cache)).toContain("Prompt cache: cold");
});

test("a cache already cold on opening is shown but not announced", async ({
	page,
	context,
}) => {
	const { id, view } = await openMeter(page, context);
	await setContext(id, {
		usedTokens: 1000,
		windowTokens: 200_000,
		cache: written(4000, 3600),
	});
	await expect(view.getByTestId("composer-cache")).toContainText("Cache cold");
	await expect(view.getByTestId("chat-composer-status")).toHaveText("");
});

test("a one-hour cache counts from an hour", async ({ page, context }) => {
	const { id, view } = await openMeter(page, context);
	await setContext(id, {
		usedTokens: 1000,
		windowTokens: 200_000,
		cache: written(5, 3600),
	});
	await expect(view.getByTestId("composer-cache")).toContainText(/Cache 59:\d\d/);
});

test("passing 80% warns with an icon and is announced once", async ({
	page,
	context,
}) => {
	const { id, view } = await openMeter(page, context);
	const status = view.getByTestId("chat-composer-status");
	const meter = view.getByTestId("composer-context");
	await setContext(id, { usedTokens: 120_000, windowTokens: 200_000, cache: null });
	await expect(meter).toContainText("Context 60%");
	await expect(meter.locator("svg")).toHaveCount(0);
	await expect(status).toHaveText("");

	await setContext(id, { usedTokens: 170_000, windowTokens: 200_000, cache: null });
	await expect(meter).toContainText("Context 85%");
	await expect(meter.locator("svg")).toBeVisible();
	await expect(status).toHaveText(/^Context is now 85% full\. Run \/compact/);
});

test("each chat tab shows its own conversation's figures", async ({
	page,
	context,
}) => {
	await page.setViewportSize({ width: 1500, height: 900 });
	const { id, view: first } = await openMeter(page, context);
	await splitPane(page, id, "right", "claude-gui");
	const second = page.locator("[data-testid^='chat-view-']").nth(1);
	await expect(second.getByTestId("composer-model")).toBeVisible({ timeout: 15_000 });
	const secondId = (await second.getAttribute("data-testid"))?.replace(
		"chat-view-",
		"",
	);
	if (!secondId) throw new Error("the second chat has no id");

	await setContext(id, {
		usedTokens: 144_000,
		windowTokens: 200_000,
		cache: written(10),
	});
	await setContext(secondId, {
		usedTokens: 190_000,
		windowTokens: 200_000,
		cache: written(4000, 3600),
	});
	await expect(first.getByTestId("composer-context")).toContainText("Context 72%");
	await expect(second.getByTestId("composer-context")).toContainText("Context 95%");
	await expect(first.getByTestId("composer-cache")).toHaveAttribute(
		"data-state",
		"warm",
	);
	await expect(second.getByTestId("composer-cache")).toHaveAttribute(
		"data-state",
		"cold",
	);
});

for (const colorScheme of ["light", "dark"] as const) {
	for (const width of [1800, 420] as const) {
		test(`the readouts fit the row and pass axe at ${width} px (${colorScheme})`, async ({
			page,
			context,
		}) => {
			await page.emulateMedia({ colorScheme });
			await page.setViewportSize({ width, height: 900 });
			const { id, view } = await openMeter(page, context);
			const composer = view.getByTestId("chat-composer");
			const firstLine = () =>
				composer.evaluate((form) => {
					// From the box's own top: the box grows upward from the bottom of the pane.
					const top = (selector: string) =>
						Math.round(
							(form.querySelector(selector)?.getBoundingClientRect().top ?? -1) -
								form.getBoundingClientRect().top,
						);
					return [
						top(".pk-picker"),
						top("[data-testid=chat-composer-send]"),
						top(".pk-composer-tools"),
					];
				});
			const before = await firstLine();
			// Both readouts at their widest: the context in warning, the cache in its last minute.
			await setContext(id, {
				usedTokens: 190_000,
				windowTokens: 200_000,
				cache: written(250),
			});
			await expect(view.getByTestId("composer-context")).toBeVisible();
			await expect(view.getByTestId("composer-cache")).toHaveAttribute(
				"data-state",
				"soon",
			);

			// The readouts add a line; they never move the pickers, Send or the tools.
			expect(await firstLine()).toEqual(before);

			const fit = await composer.evaluate((form) => {
				const group = form.querySelector<HTMLElement>(".pk-composer-picks");
				const send = form.querySelector("[data-testid=chat-composer-send]");
				const pickers = form.querySelector(".pk-picker");
				const edge = form.getBoundingClientRect();
				const readouts = [...form.querySelectorAll<HTMLElement>(".pk-ctx")].map((one) =>
					one.getBoundingClientRect(),
				);
				const meters = form.querySelector(".pk-ctx-row")?.getBoundingClientRect();
				return {
					// The readouts are a line of their own under the pickers and Send.
					underPickers:
						!!meters &&
						!!pickers &&
						!!send &&
						meters.top >= pickers.getBoundingClientRect().bottom - 1 &&
						meters.top >= send.getBoundingClientRect().bottom - 1,
					groupFits: !!group && group.scrollWidth <= group.clientWidth,
					readoutsInside: readouts.every(
						(box) => box.left >= edge.left - 1 && box.right <= edge.right + 1,
					),
					pageScrolls:
						document.documentElement.scrollWidth > document.documentElement.clientWidth,
				};
			});
			expect(fit.underPickers).toBe(true);
			expect(fit.groupFits).toBe(true);
			expect(fit.readoutsInside).toBe(true);
			expect(fit.pageScrolls).toBe(false);
			// Send stays reachable on the first line.
			await expect(view.getByTestId("chat-composer-send")).toBeVisible();

			await expectNoViolations(page, '[data-testid="chat-composer"]');
		});
	}
}
