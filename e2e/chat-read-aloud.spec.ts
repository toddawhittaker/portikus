import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { makeChatTab, openChatOptions, scriptedChat } from "./chat-helpers";
import { expectNoViolations, newTerminal, query } from "./helpers";

/**
 * Reading Claude's replies aloud (SPEC.md §10.8, §25.8, §25.10, ADR 0071),
 * against a fake `speechSynthesis` installed before the page loads. Only
 * Claude's written replies are read; Stop, Escape and sending end the
 * speech at once; the controls are hidden where the API is missing.
 */

const SETTLED = "The test passes now.";
const FIRST = "Let me run the tests.";
const OUTPUT = "TOOL OUTPUT SHOULD NEVER BE SPOKEN";
const QUESTION = "Does the test pass?";
const TOOL = {
	id: "t1",
	name: "Bash",
	title: "npm test",
	input: { command: "npm test" },
};

interface Fake {
	spoken: string[];
	cancelled: number;
}

/** Records what is spoken; an utterance ends only when the test finishes it. */
function installFakeSpeech(): void {
	const state = { spoken: [] as string[], cancelled: 0 };
	let current: { onend: (() => void) | null } | null = null;
	class Utterance {
		lang = "";
		voice = null;
		onend: (() => void) | null = null;
		onerror: (() => void) | null = null;
		constructor(public text: string) {}
	}
	const synth = Object.assign(new EventTarget(), {
		getVoices: () => [],
		speak(utterance: Utterance) {
			state.spoken.push(utterance.text);
			current = utterance;
		},
		cancel() {
			state.cancelled += 1;
			current = null;
		},
	});
	Object.defineProperty(window, "speechSynthesis", {
		value: synth,
		configurable: true,
	});
	Object.defineProperty(window, "SpeechSynthesisUtterance", {
		value: Utterance,
		configurable: true,
	});
	Object.defineProperty(window, "__fakeSpeech", { value: state });
	Object.defineProperty(window, "__finishUtterance", {
		value: () => current?.onend?.(),
	});
}

/** The browser has no speech at all. */
function removeSpeech(): void {
	Object.defineProperty(window, "speechSynthesis", {
		value: undefined,
		configurable: true,
	});
	Object.defineProperty(window, "SpeechSynthesisUtterance", {
		value: undefined,
		configurable: true,
	});
}

async function fake(page: Page): Promise<Fake> {
	return page.evaluate(
		() => (window as unknown as { __fakeSpeech: Fake }).__fakeSpeech,
	);
}

async function spoken(page: Page): Promise<string[]> {
	return (await fake(page)).spoken;
}

/**
 * A chat whose host replies to each message with a turn: some words, a tool
 * call with output, then the answer.
 */
async function openChat(
	page: Page,
	context: BrowserContext,
	{ speech = true }: { speech?: boolean } = {},
) {
	await context.addInitScript(speech ? installFakeSpeech : removeSpeech);
	const { id, project, student } = await makeChatTab(page, context);
	await page.routeWebSocket(/\/chat$/, (ws) => {
		const send = scriptedChat(ws, "00000000-0000-4000-8000-000000000000");
		send("snapshot", { cards: [], turnRunning: false, truncated: false });
		send("message", { id: "u1", role: "user", markdown: QUESTION });
		send("turn.started", { at: Date.now() - 5_000 });
		send("message", { id: "a1", role: "assistant", markdown: FIRST });
		send("tool.started", TOOL);
		send("tool.output", { id: "t1", part: { type: "text", text: OUTPUT } });
		send("tool.finished", { id: "t1", isError: false });
		send("message", { id: "a2", role: "assistant", markdown: SETTLED });
		send("turn.finished", { at: Date.now(), status: "done" });
		send("settings", {
			agent: "claude",
			model: "default",
			effort: "high",
			mode: "default",
		});
		ws.onMessage((raw) => {
			const message = JSON.parse(String(raw));
			if (message.type === "set") {
				send("settings", {
					agent: "claude",
					model: "default",
					effort: message.effort ?? "high",
					mode: "default",
				});
			}
			if (message.type !== "send") return;
			send("message", { id: "u2", role: "user", markdown: message.text });
			send("turn.started", { at: Date.now() });
			send("tool.started", { ...TOOL, id: "t2" });
			send("tool.output", { id: "t2", part: { type: "text", text: OUTPUT } });
			send("tool.finished", { id: "t2", isError: false });
			send("message", {
				id: "a3",
				role: "assistant",
				markdown: "All **finished** now.",
			});
			send("turn.finished", { at: Date.now(), status: "done" });
		});
	});
	await page.reload();
	const view = page.getByTestId(`chat-view-${id}`);
	await expect(view).toBeVisible({ timeout: 15_000 });
	await expect(view.getByTestId("composer-model")).toBeAttached({ timeout: 15_000 });
	return { view, project, student, id };
}

async function savedReadAloud(projectId: string): Promise<unknown> {
	const [row] = await query<{ chat_settings: { readAloud?: boolean } | null }>(
		"select chat_settings from projects where id = $1",
		[projectId],
	);
	return row?.chat_settings?.readAloud;
}

for (const colorScheme of ["light", "dark"] as const) {
	test(`a reply's speaker button reads it, becomes Stop, and stops it (${colorScheme})`, async ({
		page,
		context,
	}) => {
		test.setTimeout(90_000);
		await page.emulateMedia({ colorScheme });
		const { view } = await openChat(page, context);
		const replies = view.getByTestId("chat-assistant-message");
		// Claude's replies have it, one each; the student's message, the tool and the Working line do not.
		await expect(replies).toHaveCount(2);
		await expect(view.getByTestId("chat-speak")).toHaveCount(2);
		await view.getByTestId("chat-worked").locator("summary").first().click();
		await expect(view.getByTestId("chat-speak")).toHaveCount(2);

		const reply = replies.filter({ hasText: SETTLED });
		const speaker = reply.getByRole("button", { name: "Read aloud" });
		// Out of sight until hover or focus, like Copy, and beside it.
		await expect(speaker).toBeAttached();
		await reply.hover();
		await speaker.click();
		await expect.poll(() => spoken(page)).toEqual([SETTLED]);
		const stopping = reply.getByRole("button", { name: "Stop reading aloud" });
		await expect(stopping).toBeVisible();
		await expect(stopping).toBeFocused();
		await expect(reply.locator(".pk-chat-copy")).toHaveCount(1);
		await expect(reply.locator(".pk-chat-speak")).toHaveCount(1);
		await expectNoViolations(page, `[data-testid^="chat-view-"]`);

		await stopping.click();
		await expect(reply.getByRole("button", { name: "Read aloud" })).toBeVisible();
		expect((await fake(page)).cancelled).toBeGreaterThan(0);
		// No tool output, narration or the student's words were ever spoken.
		expect((await spoken(page)).join(" ")).not.toContain(OUTPUT);
		expect((await spoken(page)).join(" ")).not.toContain(QUESTION);
		await expectNoViolations(page, `[data-testid^="chat-view-"]`);
	});
}

test("reading one reply stops the one before it, and finishing returns the button", async ({
	page,
	context,
}) => {
	const { view } = await openChat(page, context);
	const replies = view.getByTestId("chat-assistant-message");
	const first = replies.filter({ hasText: FIRST });
	const last = replies.filter({ hasText: SETTLED });
	await first.getByRole("button", { name: "Read aloud" }).click();
	await expect(first.getByRole("button", { name: "Stop reading aloud" })).toBeVisible();
	await last.getByRole("button", { name: "Read aloud" }).click();
	await expect(last.getByRole("button", { name: "Stop reading aloud" })).toBeVisible();
	await expect(first.getByRole("button", { name: "Read aloud" })).toBeVisible();
	expect(await spoken(page)).toEqual([FIRST, SETTLED]);

	await page.evaluate(() =>
		(window as unknown as { __finishUtterance: () => void }).__finishUtterance(),
	);
	await expect(last.getByRole("button", { name: "Read aloud" })).toBeVisible();
});

test("Escape stops the speech, but Escape in an open menu only closes the menu", async ({
	page,
	context,
}) => {
	const { view } = await openChat(page, context);
	const reply = view.getByTestId("chat-assistant-message").filter({ hasText: SETTLED });
	await reply.getByRole("button", { name: "Read aloud" }).click();
	await expect(reply.getByRole("button", { name: "Stop reading aloud" })).toBeVisible();

	await openChatOptions(view);
	await view.getByTestId("composer-model").click();
	await expect(page.getByRole("menu", { name: /^Model / })).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.getByRole("menu", { name: /^Model / })).toHaveCount(0);
	await expect(reply.getByRole("button", { name: "Stop reading aloud" })).toBeVisible();

	await view.getByTestId("chat-composer-input").click();
	await page.keyboard.press("Escape");
	await expect(reply.getByRole("button", { name: "Read aloud" })).toBeVisible();
});

test("sending a message stops the speech at once", async ({ page, context }) => {
	const { view } = await openChat(page, context);
	const reply = view.getByTestId("chat-assistant-message").filter({ hasText: SETTLED });
	await reply.getByRole("button", { name: "Read aloud" }).click();
	await expect(reply.getByRole("button", { name: "Stop reading aloud" })).toBeVisible();
	await view.getByTestId("chat-composer-input").click();
	await page.keyboard.type("Thanks");
	await page.keyboard.press("Enter");
	await expect(reply.getByRole("button", { name: "Read aloud" })).toBeVisible();
	// The switch is off, so the answer to this message is not read.
	await expect(view.getByTestId("chat-scroll").getByText("finished")).toBeVisible();
	expect(await spoken(page)).toEqual([SETTLED]);
});

test("leaving the chat tab stops the speech", async ({ page, context }) => {
	const { view } = await openChat(page, context);
	const reply = view.getByTestId("chat-assistant-message").filter({ hasText: SETTLED });
	await reply.getByRole("button", { name: "Read aloud" }).click();
	await expect(reply.getByRole("button", { name: "Stop reading aloud" })).toBeVisible();
	const before = (await fake(page)).cancelled;
	await newTerminal(page);
	await expect(view).toBeHidden();
	await expect.poll(async () => (await fake(page)).cancelled).toBeGreaterThan(before);
});

for (const colorScheme of ["light", "dark"] as const) {
	test(`the switch reads each finished reply, is remembered per project and passes axe (${colorScheme})`, async ({
		page,
		context,
	}) => {
		test.setTimeout(90_000);
		await page.emulateMedia({ colorScheme });
		const { view, project, id } = await openChat(page, context);
		await openChatOptions(view);
		const toggle = view.getByRole("switch", { name: "Read replies aloud" });
		await expect(toggle).toHaveAttribute("aria-checked", "false");
		await expect(toggle).toContainText("Off");
		await expectNoViolations(page, `[data-testid^="chat-view-"]`);

		// Keyboard: Space flips it.
		await toggle.focus();
		await page.keyboard.press("Space");
		await expect(toggle).toHaveAttribute("aria-checked", "true");
		await expect(toggle).toContainText("On");
		await expect.poll(() => savedReadAloud(project.id)).toBe(true);
		await expectNoViolations(page, `[data-testid^="chat-view-"]`);
		// Switching on reads nothing already there.
		expect(await spoken(page)).toEqual([]);

		await view.getByTestId("chat-composer-input").click();
		await page.keyboard.type("Run it again");
		await page.keyboard.press("Enter");
		await expect.poll(() => spoken(page)).toEqual(["All finished now."]);
		expect((await spoken(page)).join(" ")).not.toContain(OUTPUT);

		// The pickers' own saves keep it.
		await openChatOptions(view);
		await view.getByTestId("composer-effort").click();
		await page.getByRole("menuitemradio", { name: "Low" }).click();
		await expect
			.poll(async () => {
				const [row] = await query<{ chat_settings: unknown }>(
					"select chat_settings from projects where id = $1",
					[project.id],
				);
				return row?.chat_settings;
			})
			.toMatchObject({ effort: "low", readAloud: true });

		await page.reload();
		await expect(
			page.getByTestId(`chat-view-${id}`).getByTestId("composer-model"),
		).toBeAttached({ timeout: 15_000 });
		await openChatOptions(page.getByTestId(`chat-view-${id}`));
		await expect(
			page.getByTestId(`chat-view-${id}`).getByRole("switch", {
				name: "Read replies aloud",
			}),
		).toHaveAttribute("aria-checked", "true");

		// And off again.
		await page.getByRole("switch", { name: "Read replies aloud" }).click();
		await expect.poll(() => savedReadAloud(project.id)).toBe(false);
	});
}

test("the controls are hidden where the browser cannot speak", async ({
	page,
	context,
}) => {
	const { view } = await openChat(page, context, { speech: false });
	await expect(view.getByTestId("chat-assistant-message").first()).toBeVisible();
	await expect(view.getByTestId("chat-speak")).toHaveCount(0);
	await expect(view.getByRole("switch")).toHaveCount(0);
	await expect(
		view.getByRole("button", { name: "Copy message" }).first(),
	).toBeAttached();
	await expectNoViolations(page, `[data-testid^="chat-view-"]`);
});
