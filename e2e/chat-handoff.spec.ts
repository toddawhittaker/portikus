import { expect, type Locator, type Page, test } from "@playwright/test";
import { openChat, sendMessage } from "./chat-helpers";
import { createStudent, expectNoViolations } from "./helpers";
import { FAKE_AGENT_URL } from "./ports";

/**
 * Starting fresh with a handoff note (SPEC.md §10.8, §25.8): once a fresh
 * chat would save usage, a button on the estimate line asks the agent for a
 * note, the student reviews it in a card, and Continue starts a new
 * conversation whose first message is the note. `/handoff` does the same.
 */

const NOTE_PATH = /^\.portikus\/handoffs\/\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.md$/;
const CONTINUE_LINE =
	"Continue from Next steps. Before acting, say in three lines what you understand the task to be.";

/** Context figures past the point where a fresh chat saves usage. */
async function pastThePoint(id: string) {
	const sent = await fetch(`${FAKE_AGENT_URL}/__test/chats/${id}/context`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			usedTokens: 400_000,
			windowTokens: 1_000_000,
			cache: null,
			growth: {
				startTokens: 30_000,
				messages: 2,
				requests: 2,
				firstMessageTokens: 50_000,
				firstMessageRequests: 1,
				doneMessages: 2,
				doneTokens: 400_000,
				doneRequests: 2,
			},
		}),
	});
	expect(sent.ok).toBe(true);
}

async function openAtZero(
	page: Page,
	context: Parameters<typeof createStudent>[0],
	agent: "claude" | "codex" = "claude",
) {
	const student = await createStudent(context);
	const chat = await openChat(page, student.workspaceId, "Handoff", agent);
	await pastThePoint(chat.id);
	await expect(chat.view.getByTestId("composer-restart")).toHaveAttribute(
		"data-state",
		"now",
	);
	return chat;
}

/** The review card, open with the note, its keyboard focus on Continue. */
async function expectReview(view: Locator): Promise<Locator> {
	const card = view.getByRole("region", { name: "Review the handoff note" });
	await expect(card).toBeVisible();
	await expect(card.getByTestId("chat-handoff-note")).toContainText(
		"Finish the parser.",
	);
	await expect(card.getByTestId("chat-handoff-path")).toHaveText(NOTE_PATH);
	await expect(card.getByRole("button", { name: "Continue" })).toBeFocused();
	return card;
}

/** After Continue: the divider, then the note as the new conversation's first message. */
async function expectFreshStart(view: Locator, note: string) {
	await expect(view.getByTestId("chat-handoff-card")).toHaveCount(0);
	const divider = view.getByTestId("chat-fresh-start");
	await expect(divider).toContainText("Fresh start from handoff.");
	const first = view.getByTestId("chat-user-message");
	await expect(first).toHaveCount(1);
	await expect(first).toContainText(note);
	await expect(first).toContainText(CONTINUE_LINE);
	await expect(first.getByTestId("chat-sent-by-portikus")).toHaveText(
		"Sent by Portikus from the handoff",
	);
	// The old conversation is gone, and the estimate starts over with the new one.
	await expect(view.getByText("Earlier question", { exact: true })).toHaveCount(0);
	await expect(view.getByTestId("composer-handoff")).toHaveCount(0);
}

for (const colorScheme of ["dark", "light"] as const) {
	test(`the button at zero asks for a note, and Continue starts fresh from it (${colorScheme})`, async ({
		page,
		context,
	}) => {
		await page.emulateMedia({ colorScheme });
		const { id, view } = await openAtZero(page, context);
		const button = view.getByRole("button", { name: "Start fresh with a handoff" });
		await expect(button).toBeVisible();
		await page.screenshot({ path: `screenshots/handoff-button-${colorScheme}.png` });
		await button.click();

		const card = await expectReview(view);
		// The note's own turn stays in the transcript as a normal reply.
		await expect(view.getByText("The tokenizer works.").first()).toBeVisible();
		await expectNoViolations(page, '[data-testid="chat-handoff-card"]');
		await page.screenshot({ path: `screenshots/handoff-review-${colorScheme}.png` });

		await card.getByRole("button", { name: "Continue" }).click();
		await expectFreshStart(view, "Finish the parser.");
		// The new conversation's first reply brings fresh figures, and the row is back from them.
		const fresh = await fetch(`${FAKE_AGENT_URL}/__test/chats/${id}/context`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				usedTokens: 12_000,
				windowTokens: 1_000_000,
				cache: null,
				growth: { startTokens: 12_000, messages: 1, requests: 1 },
			}),
		});
		expect(fresh.ok).toBe(true);
		await expect(view.getByTestId("composer-context")).toContainText("12.0k");
		// A new conversation has no finished messages, so the estimate is hidden until it has.
		await expect(view.getByTestId("composer-restart")).toHaveCount(0);
		await expect(view.getByTestId("composer-handoff")).toHaveCount(0);
		await expectNoViolations(page, '[data-testid="chat-fresh-start"]');
		await page.screenshot({ path: `screenshots/handoff-fresh-${colorScheme}.png` });

		// The divider's link opens the saved note in the editor.
		await view.getByRole("button", { name: "Open the note" }).click();
		await expect(
			page.getByRole("tab", { name: /T\d{2}-\d{2}-\d{2}Z\.md/ }),
		).toBeVisible();
	});
}

test("typing /handoff in a Codex chat does the same, and an edit goes into the first message", async ({
	page,
	context,
}) => {
	await page.emulateMedia({ colorScheme: "dark" });
	const { view } = await openAtZero(page, context, "codex");
	await sendMessage(view, "/handoff");
	const card = await expectReview(view);
	await card.getByRole("button", { name: "Edit" }).click();
	const field = card.getByRole("textbox", { name: "Handoff note" });
	await expect(field).toBeFocused();
	await field.fill(
		"## Goal\n\nShip the edited plan.\n\n## Next steps\n\nRun the tests.",
	);
	await page.screenshot({ path: "screenshots/handoff-edit-dark.png" });
	await card.getByRole("button", { name: "Save the note" }).click();
	await expect(card.getByTestId("chat-handoff-note")).toContainText(
		"Ship the edited plan.",
	);
	await card.getByRole("button", { name: "Continue" }).click();
	await expectFreshStart(view, "Ship the edited plan.");
});

test("Escape is Cancel: the conversation stays and the note waits no longer", async ({
	page,
	context,
}) => {
	await page.emulateMedia({ colorScheme: "dark" });
	const { view } = await openAtZero(page, context);
	await view.getByRole("button", { name: "Start fresh with a handoff" }).click();
	await expectReview(view);
	// In a taller window the note gets about half the chat.
	await page.setViewportSize({ width: 1280, height: 1000 });
	await page.screenshot({ path: "screenshots/handoff-review-tall-dark.png" });
	await page.keyboard.press("Escape");
	await expect(view.getByTestId("chat-handoff-card")).toHaveCount(0);
	await expect(view.getByTestId("chat-fresh-start")).toHaveCount(0);
	await expect(view.getByText("Earlier question", { exact: true })).toBeVisible();
	// The keyboard goes back to the message box.
	await expect(view.getByTestId("chat-composer-input")).toBeFocused();
	await page.reload();
	const again = page.locator('[data-testid^="chat-view-"]').first();
	await expect(again.getByTestId("composer-model")).toBeAttached({ timeout: 15_000 });
	await expect(again.getByTestId("chat-handoff-card")).toHaveCount(0);
});

test("at phone width the button and the card fit, and Send stays put", async ({
	page,
	context,
}) => {
	await page.emulateMedia({ colorScheme: "dark" });
	await page.setViewportSize({ width: 360, height: 800 });
	const student = await createStudent(context);
	const { id, view } = await openChat(page, student.workspaceId, "Handoff phone");
	const composer = view.getByTestId("chat-composer");
	const place = (testId: string) =>
		composer.evaluate((form, testId) => {
			// From the composer's own top, which moves up as the composer grows.
			const edge = form.getBoundingClientRect();
			const box = form
				.querySelector(`[data-testid=${testId}]`)
				?.getBoundingClientRect();
			return box
				? {
						top: Math.round(box.top - edge.top),
						left: Math.round(box.left - edge.left),
					}
				: null;
		}, testId);
	const send = await place("chat-composer-send");
	const voice = await place(`chat-voice-${id}`);
	await pastThePoint(id);
	const button = view.getByRole("button", { name: "Start fresh with a handoff" });
	await expect(button).toBeVisible();
	expect(await place("chat-composer-send")).toEqual(send);
	expect(await place(`chat-voice-${id}`)).toEqual(voice);
	const inside = await composer.evaluate((form) => {
		const edge = form.getBoundingClientRect();
		const box = form
			.querySelector("[data-testid=composer-handoff]")
			?.getBoundingClientRect();
		return !!box && box.left >= edge.left - 1 && box.right <= edge.right + 1;
	});
	expect(inside).toBe(true);
	await page.screenshot({ path: "screenshots/handoff-phone-dark.png" });
	await button.click();
	const card = await expectReview(view);
	const fits = await card.evaluate(
		(node) => node.getBoundingClientRect().right <= window.innerWidth + 1,
	);
	expect(fits).toBe(true);
	await page.screenshot({ path: "screenshots/handoff-review-phone-dark.png" });
	await page.emulateMedia({ colorScheme: "light" });
	await page.screenshot({ path: "screenshots/handoff-review-phone-light.png" });
});
