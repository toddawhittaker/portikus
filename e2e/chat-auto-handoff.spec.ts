import { expect, type Locator, type Page, test } from "@playwright/test";
import { openChat, receivedFrames, sendMessage } from "./chat-helpers";
import { createStudent, expectNoViolations } from "./helpers";
import { FAKE_AGENT_URL } from "./ports";

/**
 * The automatic handoff (SPEC.md §10.8, §25.8): while the student is away,
 * the host saves a handoff note before the prompt cache goes cold and the
 * chat shows a notice. Start fresh with it goes straight to the new
 * conversation; Copy prompt copies the first message. A send into the
 * cold chat afterwards asks whether to send it to a fresh chat instead.
 * A note whose file changed since it was saved is shown for review before
 * anything is sent. The fake agent stands in for the host's timer, which
 * fires only while nothing waits for the student.
 */

const NOTICE =
	"While you were away, Portikus saved a handoff note so your next message doesn't re-read this whole chat.";
const NOTE_PATH = /\.portikus\/handoffs\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.md/;
const CONTINUE_LINE =
	"Continue from Next steps. Before acting, say in three lines what you understand the task to be.";

async function post(id: string, what: string, body?: object) {
	const sent = await fetch(`${FAKE_AGENT_URL}/__test/chats/${id}/${what}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body ?? {}),
	});
	expect(sent.ok).toBe(true);
}

const CHANGED = "## Goal\n\nSomething the student never wrote.";

/** Figures whose cache was used `agoMinutes` ago; long enough to be worth a note. */
function figures(agoMinutes: number, ttlSeconds: 1800 | 3600) {
	return {
		usedTokens: 300_000,
		windowTokens: 1_000_000,
		cache: { at: Date.now() - agoMinutes * 60_000, ttlSeconds },
		growth: {
			startTokens: 48_000,
			messages: 2,
			requests: 20,
			firstMessageTokens: 66_000,
			firstMessageRequests: 10,
			doneMessages: 2,
			doneTokens: 300_000,
			doneRequests: 20,
		},
	};
}

/** A chat with some work in it, then the host's automatic note and its notice. */
async function awayAndNoted(
	page: Page,
	context: Parameters<typeof createStudent>[0],
	agent: "claude" | "codex" = "claude",
) {
	const student = await createStudent(context);
	const chat = await openChat(page, student.workspaceId, "Auto handoff", agent);
	await sendMessage(chat.view, "Earlier work");
	// The note comes after the reply, as the host's timer waits for it.
	await expect(chat.view.getByText("Earlier work", { exact: true })).toBeVisible();
	await expect(
		chat.view.getByText("Here is the", { exact: false }).first(),
	).toBeVisible();
	// The scripted turn asks cards; the timer waits until nothing does.
	const cards = chat.view.getByTestId("chat-cards");
	await expect(cards).toBeVisible();
	// Skip all on a question card, or a permission or plan card's first choice.
	const answer = chat.view
		.getByTestId("chat-question-card")
		.getByRole("button", { name: "Skip all" })
		.or(
			chat.view
				.getByTestId("chat-permission-card")
				.getByRole("button", { name: /^(Allow|Allow once|Yes, in Auto)$/ }),
		);
	await expect(async () => {
		if ((await cards.count()) > 0) await answer.first().click({ timeout: 2000 });
		await expect(cards).toHaveCount(0, { timeout: 1000 });
	}).toPass({ timeout: 20_000 });
	await expect(chat.view.getByTestId("chat-cards")).toHaveCount(0);
	await post(chat.id, "auto-handoff");
	const notice = chat.view.getByTestId("chat-auto-handoff");
	await expect(notice).toContainText(NOTICE);
	return { ...chat, notice };
}

async function expectFreshStart(view: Locator) {
	await expect(view.getByTestId("chat-fresh-start")).toContainText(
		"Fresh start from handoff.",
	);
	const first = view.getByTestId("chat-user-message").first();
	await expect(first).toContainText("Finish the parser.");
	await expect(first).toContainText(CONTINUE_LINE);
	await expect(view.getByTestId("chat-auto-handoff")).toHaveCount(0);
	await expect(view.getByText("Earlier work", { exact: true })).toHaveCount(0);
}

for (const colorScheme of ["dark", "light"] as const) {
	test(`the notice shows, survives a reload, and Start fresh goes straight to the new conversation (${colorScheme})`, async ({
		page,
		context,
	}) => {
		await page.emulateMedia({ colorScheme });
		const { view, notice } = await awayAndNoted(page, context);
		await expect(notice.getByRole("button", { name: NOTE_PATH })).toBeVisible();
		// The request for the note is marked as Portikus's, not the student's.
		await expect(view.getByTestId("chat-sent-by-portikus")).toHaveText(
			"Sent by Portikus to write a handoff note",
		);
		await expectNoViolations(page, '[data-testid="chat-auto-handoff"]');
		await page.screenshot({
			path: `screenshots/auto-handoff-notice-${colorScheme}.png`,
		});

		await page.reload();
		const again = page.locator('[data-testid^="chat-view-"]').first();
		const replayed = again.getByTestId("chat-auto-handoff");
		await expect(replayed).toContainText(NOTICE, { timeout: 15_000 });

		// Keyboard: Tab reaches Start fresh, Enter presses it.
		const start = replayed.getByRole("button", { name: "Start fresh with it" });
		await start.focus();
		await page.keyboard.press("Enter");
		await expect(again.getByTestId("chat-handoff-card")).toHaveCount(0);
		await expectFreshStart(again);
	});
}

test("Copy prompt puts the note and the first-message prompt on the clipboard", async ({
	page,
	context,
}) => {
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	await page.emulateMedia({ colorScheme: "dark" });
	const { notice } = await awayAndNoted(page, context);
	await notice.getByRole("button", { name: "Copy prompt" }).click();
	await expect(notice.getByTestId("chat-auto-handoff-status")).toHaveText(
		"Prompt copied.",
	);
	const copied = await page.evaluate(() => navigator.clipboard.readText());
	expect(copied).toContain("Finish the parser.");
	expect(copied).toMatch(NOTE_PATH);
	expect(copied.endsWith(CONTINUE_LINE)).toBe(true);
});

test("Copy prompt falls back to a selected field when the clipboard refuses", async ({
	page,
	context,
}) => {
	await page.emulateMedia({ colorScheme: "dark" });
	const { notice } = await awayAndNoted(page, context);
	await page.evaluate(() => {
		Object.defineProperty(navigator, "clipboard", {
			value: { writeText: () => Promise.reject(new Error("refused")) },
		});
	});
	await notice.getByRole("button", { name: "Copy prompt" }).click();
	const field = notice.getByRole("textbox", { name: "Handoff prompt" });
	await expect(field).toBeFocused();
	await expect(field).toHaveValue(new RegExp(CONTINUE_LINE.replaceAll(".", "\\.")));
});

for (const colorScheme of ["dark", "light"] as const) {
	test(`a send into the cold chat asks first and goes to a fresh chat by default (${colorScheme})`, async ({
		page,
		context,
	}) => {
		await page.emulateMedia({ colorScheme });
		const { id, view } = await awayAndNoted(page, context);
		await post(id, "context", figures(70, 3600));
		const estimate = view.getByTestId("composer-restart");
		await expect(estimate).toHaveAttribute("title", /The cache has expired\./);
		await expect(estimate).toHaveAttribute("data-state", "now");
		if (colorScheme === "dark")
			await page.screenshot({
				path: "screenshots/auto-handoff-estimate-cold-dark.png",
			});

		await sendMessage(view, "Now write the parser tests");
		const choice = view.getByTestId("chat-cold-send");
		const fresh = choice.getByRole("button", {
			name: "Send in a fresh chat from the saved note",
		});
		await expect(fresh).toBeFocused();
		await expectNoViolations(page, '[data-testid="chat-cold-send"]');
		if (colorScheme === "dark")
			await page.screenshot({ path: "screenshots/auto-handoff-cold-send-dark.png" });

		// Escape closes the choice and keeps the draft.
		await page.keyboard.press("Escape");
		await expect(choice).toHaveCount(0);
		await expect(view.getByTestId("chat-composer-input")).toHaveText(
			"Now write the parser tests",
		);

		await view.getByTestId("chat-composer-input").press("Enter");
		await view
			.getByRole("button", { name: "Send in a fresh chat from the saved note" })
			.press("Enter");
		await expectFreshStart(view);
		await expect(view.getByTestId("chat-user-message").nth(1)).toContainText(
			"Now write the parser tests",
		);
	});
}

test("Send here anyway sends into the cold chat", async ({ page, context }) => {
	await page.emulateMedia({ colorScheme: "dark" });
	const { id, view } = await awayAndNoted(page, context);
	await post(id, "context", figures(70, 3600));
	await sendMessage(view, "Just here, please");
	await view.getByRole("button", { name: "Send here anyway" }).click();
	await expect(view.getByText("Just here, please", { exact: true })).toBeVisible();
	await expect(view.getByTestId("chat-fresh-start")).toHaveCount(0);
	expect((await receivedFrames(id, "send")).map((frame) => frame.text)).toContain(
		"Just here, please",
	);
});

test("a Codex chat past its 30-minute cache gets the notice and the choice too", async ({
	page,
	context,
}) => {
	await page.emulateMedia({ colorScheme: "dark" });
	const { id, view } = await awayAndNoted(page, context, "codex");
	await post(id, "context", figures(31, 1800));
	await expect(view.getByTestId("composer-cache")).toHaveAttribute(
		"data-state",
		"cold",
	);
	await sendMessage(view, "Carry on");
	await view
		.getByRole("button", { name: "Send in a fresh chat from the saved note" })
		.click();
	await expectFreshStart(view);
});

test("at phone width the notice and the choice fit", async ({ page, context }) => {
	await page.emulateMedia({ colorScheme: "dark" });
	await page.setViewportSize({ width: 360, height: 800 });
	const { id, view, notice } = await awayAndNoted(page, context);
	const inside = (locator: Locator) =>
		locator.evaluate(
			(node) => node.getBoundingClientRect().right <= window.innerWidth + 1,
		);
	expect(await inside(notice)).toBe(true);
	await page.screenshot({ path: "screenshots/auto-handoff-notice-phone-dark.png" });
	await post(id, "context", figures(70, 3600));
	await sendMessage(view, "Phone send");
	const choice = view.getByTestId("chat-cold-send");
	await expect(choice).toBeVisible();
	expect(await inside(choice)).toBe(true);
	await page.screenshot({ path: "screenshots/auto-handoff-cold-send-phone-dark.png" });
	await page.emulateMedia({ colorScheme: "light" });
	await page.screenshot({ path: "screenshots/auto-handoff-cold-send-phone-light.png" });
});

test("Start fresh from a note changed since it was saved shows it first, and Continue sends what is shown", async ({
	page,
	context,
}) => {
	await page.emulateMedia({ colorScheme: "dark" });
	const { id, view, notice } = await awayAndNoted(page, context);
	await post(id, "auto-handoff/note", { markdown: CHANGED });
	await notice.getByRole("button", { name: "Start fresh with it" }).click();
	const card = view.getByTestId("chat-handoff-card");
	await expect(card).toContainText("Something the student never wrote.");
	await expect(view.getByTestId("chat-fresh-start")).toHaveCount(0);
	await expect(card.getByTestId("chat-handoff-continue")).toBeFocused();
	await expectNoViolations(page, '[data-testid="chat-handoff-card"]');
	await page.screenshot({ path: "screenshots/auto-handoff-changed-note-dark.png" });
	await card.getByTestId("chat-handoff-continue").click();
	await expect(view.getByTestId("chat-fresh-start")).toBeVisible();
	await expect(view.getByTestId("chat-user-message").first()).toContainText(
		"Something the student never wrote.",
	);
});

test("Copy prompt of a changed note copies nothing and shows it for review", async ({
	page,
	context,
}) => {
	await context.grantPermissions(["clipboard-read", "clipboard-write"]);
	await page.emulateMedia({ colorScheme: "dark" });
	const { id, view, notice } = await awayAndNoted(page, context);
	await page.evaluate(() => navigator.clipboard.writeText("untouched"));
	await post(id, "auto-handoff/note", { markdown: CHANGED });
	await notice.getByRole("button", { name: "Copy prompt" }).click();
	await expect(view.getByTestId("chat-handoff-card")).toContainText(
		"Something the student never wrote.",
	);
	expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("untouched");
});

for (const colorScheme of ["dark", "light"] as const) {
	test(`a cold send to a fresh chat from a changed note shows it first, then sends the message after it (${colorScheme})`, async ({
		page,
		context,
	}) => {
		await page.emulateMedia({ colorScheme });
		const { id, view } = await awayAndNoted(page, context);
		await post(id, "context", figures(70, 3600));
		await post(id, "auto-handoff/note", { markdown: CHANGED });
		await sendMessage(view, "Now write the parser tests");
		await view
			.getByRole("button", { name: "Send in a fresh chat from the saved note" })
			.click();
		const card = view.getByTestId("chat-handoff-card");
		await expect(card).toContainText("Something the student never wrote.");
		// The message waits in the box until it is sent after the note.
		await expect(view.getByTestId("chat-composer-input")).toHaveText(
			"Now write the parser tests",
		);
		await page.screenshot({
			path: `screenshots/auto-handoff-cold-send-changed-${colorScheme}.png`,
		});
		await card.getByTestId("chat-handoff-continue").click();
		await expect(view.getByTestId("chat-user-message").first()).toContainText(
			"Something the student never wrote.",
		);
		await expect(view.getByTestId("chat-user-message").nth(1)).toContainText(
			"Now write the parser tests",
		);
		await expect(view.getByTestId("chat-composer-input")).toHaveText("");
	});
}

test("a fresh start from the cold-send choice that fails puts the message back and says why", async ({
	page,
	context,
}) => {
	await page.emulateMedia({ colorScheme: "dark" });
	const { id, view } = await awayAndNoted(page, context);
	await post(id, "context", figures(70, 3600));
	await post(id, "handoff-fail");
	await sendMessage(view, "Do not lose me");
	await view
		.getByRole("button", { name: "Send in a fresh chat from the saved note" })
		.click();
	await expect(
		view.getByText(/A fresh conversation could not be started/),
	).toBeVisible();
	await expect(view.getByTestId("chat-composer-input")).toHaveText("Do not lose me");
	await expect(view.getByTestId("chat-composer-error")).toHaveText(
		"The fresh chat did not start, so your message was not sent. It is still here, and the conversation says why.",
	);
	await expectNoViolations(page, '[data-testid="chat-composer"]');
	await page.screenshot({ path: "screenshots/auto-handoff-draft-restored-dark.png" });
});
