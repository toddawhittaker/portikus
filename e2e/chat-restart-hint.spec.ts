import { expect, type Page, test } from "@playwright/test";
import { openChat, sendMessage } from "./chat-helpers";
import { createStudent, expectNoViolations } from "./helpers";
import { FAKE_AGENT_URL } from "./ports";

/**
 * The fresh-chat hint on the composer's readout line (SPEC.md §10.8, §25.8):
 * how many more messages before a fresh chat would use less of the plan,
 * estimated from how this chat's context has grown. It warns, and is
 * announced once, when a fresh chat would already save usage.
 */

const WINDOW = 1_000_000;

async function setUsed(
	id: string,
	usedTokens: number,
	growth?: {
		startTokens: number;
		messages: number;
		requests: number;
		firstMessageTokens?: number;
		firstMessageRequests?: number;
		doneMessages?: number;
		doneTokens?: number;
		doneRequests?: number;
	},
) {
	const sent = await fetch(`${FAKE_AGENT_URL}/__test/chats/${id}/context`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ usedTokens, windowTokens: WINDOW, cache: null, growth }),
	});
	expect(sent.ok).toBe(true);
}

async function openHint(page: Page, context: Parameters<typeof createStudent>[0]) {
	const student = await createStudent(context);
	const chat = await openChat(page, student.workspaceId, "Restart");
	await expect(chat.view.getByTestId("composer-model")).toBeAttached({
		timeout: 15_000,
	});
	return chat;
}

for (const colorScheme of ["dark", "light"] as const) {
	test(`the hint counts down as the chat grows, then warns once (${colorScheme})`, async ({
		page,
		context,
	}) => {
		await page.emulateMedia({ colorScheme });
		const { id, view } = await openHint(page, context);
		const hint = view.getByTestId("composer-restart");
		const status = view.getByTestId("chat-composer-status");

		// An empty chat has nothing to estimate from.
		await setUsed(id, 0);
		await expect(view.getByTestId("composer-context")).toBeVisible();
		await expect(hint).toHaveCount(0);

		await setUsed(id, 30_000);
		await sendMessage(view, "first");
		await expect(view.getByText("first", { exact: true })).toBeVisible();
		await sendMessage(view, "second");
		await expect(view.getByText("second", { exact: true })).toBeVisible();
		// The host's counts: a heavy warm-up of 30k to 60k, then 10k for the second message.
		await setUsed(id, 70_000, {
			startTokens: 30_000,
			messages: 2,
			requests: 4,
			firstMessageTokens: 60_000,
			firstMessageRequests: 2,
			doneMessages: 2,
			doneTokens: 70_000,
			doneRequests: 4,
		});

		await expect(hint.locator(".pk-ctx-sight")).toHaveText(
			/^About \d+ more messages? before a fresh chat saves usage$/,
		);
		await expect(hint).toHaveAttribute("data-state", "later");
		await expect(hint).toHaveAttribute("title", /estimate from API prices/);
		await expect(status).toHaveText("");
		await page.screenshot({
			path: `screenshots/restart-hint-later-${colorScheme}.png`,
		});

		await setUsed(id, 400_000);
		await expect(hint).toHaveAttribute("data-state", "now");
		await expect(hint).toHaveClass(/is-warning/);
		await expect(hint.locator("svg")).toHaveCount(1);
		await expect(hint.locator(".pk-ctx-sight")).toHaveText(
			"A fresh chat would now save usage",
		);
		await expect(status).toHaveText(/^A fresh chat would now save usage\./);
		// The ticking count is left out of what a screen reader is told.
		expect(await hint.ariaSnapshot()).not.toMatch(/\d/);
		await expectNoViolations(page, '[data-testid="chat-composer"]');
		await page.screenshot({ path: `screenshots/restart-hint-now-${colorScheme}.png` });

		// Told once in a conversation, however much further it grows.
		await setUsed(id, 30_000);
		await setUsed(id, 450_000);
		await expect(view.getByTestId("composer-context")).toContainText("450k");
		await expect(status).toHaveText(/^A fresh chat would now save usage\./);
	});
}

test("at phone width the hint wraps inside the composer and Send stays put", async ({
	page,
	context,
}) => {
	await page.emulateMedia({ colorScheme: "dark" });
	await page.setViewportSize({ width: 360, height: 800 });
	const { id, view } = await openHint(page, context);
	const composer = view.getByTestId("chat-composer");
	const sendTop = () =>
		composer.evaluate((form) =>
			Math.round(
				(form.querySelector("[data-testid=chat-composer-send]")?.getBoundingClientRect()
					.top ?? -1) - form.getBoundingClientRect().top,
			),
		);
	const before = await sendTop();
	await setUsed(id, 30_000);
	await expect(view.getByTestId("composer-restart")).toBeVisible();
	expect(await sendTop()).toBe(before);
	const inside = await composer.evaluate((form) => {
		const edge = form.getBoundingClientRect();
		const box = form
			.querySelector("[data-testid=composer-restart]")
			?.getBoundingClientRect();
		return !!box && box.left >= edge.left - 1 && box.right <= edge.right + 1;
	});
	expect(inside).toBe(true);
	await page.screenshot({ path: "screenshots/restart-hint-phone-dark.png" });
});

test("a reload keeps the estimate, from the counts the host keeps", async ({
	page,
	context,
}) => {
	await page.emulateMedia({ colorScheme: "dark" });
	const { id, view } = await openHint(page, context);
	await setUsed(id, 30_000, { startTokens: 30_000, messages: 0, requests: 1 });
	await sendMessage(view, "first");
	await expect(view.getByText("first", { exact: true })).toBeVisible();
	await sendMessage(view, "second");
	await expect(view.getByText("second", { exact: true })).toBeVisible();
	// A warm-up and request counts a reloaded browser could not count itself.
	await setUsed(id, 70_000, {
		startTokens: 30_000,
		messages: 2,
		requests: 7,
		firstMessageTokens: 60_000,
		firstMessageRequests: 4,
		doneMessages: 2,
		doneTokens: 70_000,
		doneRequests: 7,
	});
	// Read the estimate only once the new figures have reached the page.
	await expect(view.getByTestId("composer-context")).toContainText("70.0k");
	const sight = view.getByTestId("composer-restart").locator(".pk-ctx-sight");
	await expect(sight).toHaveText(/^About \d+ more messages? before/);
	const before = await sight.textContent();

	await page.reload();
	const again = page.getByTestId(`chat-view-${id}`);
	await expect(again.getByTestId("composer-context")).toContainText("70.0k", {
		timeout: 15_000,
	});
	await expect(
		again.getByTestId("composer-restart").locator(".pk-ctx-sight"),
	).toHaveText(before ?? "");
});
