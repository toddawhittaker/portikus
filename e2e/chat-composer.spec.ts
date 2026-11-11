import {
	expect,
	type Locator,
	type Page,
	test,
	type WebSocketRoute,
} from "@playwright/test";
import { openChat, openChatOptions, receivedFrames } from "./chat-helpers";
import { join, newCourse } from "./course-profile-helpers";
import {
	createProject,
	createStudent,
	expectNoViolations,
	lockSharedState,
	terminalIds,
	VOICE_SWITCH_LOCK,
	workspacePath,
	workTabs,
} from "./helpers";
import { png } from "./png";
import { type FakeSpeechWindow, fakeSpeech } from "./voice-helpers";

/**
 * The chat composer and the GUI launcher (SPEC.md §8.3, §8.7, §10.8,
 * §25.8), against the fake agent's chat through the API relay. The fake
 * records every frame it receives, so each test reads what the page sent.
 */

// The site switch spec turns voice off; the microphone test needs it on.
let release: (() => Promise<void>) | undefined;

test.beforeAll(async () => {
	test.setTimeout(600_000);
	release = await lockSharedState(VOICE_SWITCH_LOCK, { shared: true });
});

test.afterAll(async () => {
	await release?.();
});

/** A 1 by 1 PNG. */
const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
	"base64",
);

/** Paste or drop a file by dispatching the event a browser would. */
async function giveFile(
	page: Page,
	kind: "paste" | "drop",
	file: { name: string; type: string; base64: string },
) {
	await page.evaluate(
		({ kind, file }) => {
			const bytes = Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0));
			const transfer = new DataTransfer();
			transfer.items.add(new File([bytes], file.name, { type: file.type }));
			if (kind === "paste") {
				const target = document.querySelector<HTMLElement>(
					'[data-testid="chat-composer-input"]',
				);
				target?.dispatchEvent(
					new ClipboardEvent("paste", {
						clipboardData: transfer,
						bubbles: true,
						cancelable: true,
					}),
				);
				return;
			}
			const target = document.querySelector<HTMLElement>(
				'[data-testid="chat-composer"]',
			);
			target?.dispatchEvent(
				new DragEvent("drop", {
					dataTransfer: transfer,
					bubbles: true,
					cancelable: true,
				}),
			);
		},
		{ kind, file: { ...file, base64: file.base64 } },
	);
}

const PNG_FILE = { type: "image/png", base64: PNG.toString("base64") };

test("the New tab menu offers both Claude Code entries, and the GUI one opens a chat", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Launch" });
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
	await page.getByTestId("launcher").click();
	await expect(page.getByTestId("launcher-claude")).toHaveText("Claude Code (TUI)");
	await expect(page.getByTestId("launcher-claude-gui")).toHaveText("Claude Code (GUI)");
	await expect(page.getByTestId("launcher-codex")).toBeVisible();

	const posted = page.waitForRequest(
		(request) => request.method() === "POST" && request.url().includes("/terminals"),
	);
	await page.getByTestId("launcher-claude-gui").click();
	expect((await posted).postDataJSON()).toEqual({
		projectId: project.id,
		agent: "claude",
		kind: "chat",
	});
	const [id] = await (async () => {
		await expect
			.poll(async () => (await terminalIds(student.workspaceId, project.id)).length)
			.toBe(1);
		return terminalIds(student.workspaceId, project.id);
	})();
	await expect(page.getByTestId(`chat-view-${id}`)).toBeVisible({ timeout: 15_000 });
	// The pane's frame and menu say chat.
	await expect(page.getByRole("region", { name: /^Chat: / })).toBeVisible();
	await page.getByTestId(`terminal-actions-${id}`).click();
	await expect(page.getByTestId("terminal-leave")).toHaveText("Leave chat");
});

test("the Traditional profile hides the GUI entry with the other agent launchers", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await join((await newCourse("traditional")).id, student.userId, "student");
	const project = await createProject(student.workspaceId, { name: "Traditional" });
	const settings = page.waitForResponse(
		(response) => new URL(response.url()).pathname === "/me/settings",
	);
	await page.goto(workspacePath(student.workspaceId, project.id));
	await settings;
	await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
	await page.getByTestId("launcher").click();
	await expect(page.getByTestId("launcher-terminal")).toBeVisible();
	await expect(page.getByTestId("launcher-claude-gui")).toHaveCount(0);
	await expect(page.getByTestId("launcher-claude")).toHaveCount(0);
});

test("Enter sends, Shift+Enter makes a new line, and a sent message appears", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const { id, view } = await openChat(page, student.workspaceId, "Composer");
	const box = view.getByTestId("chat-composer-input");
	await expect(
		view.getByRole("combobox", { name: "Message Claude Code" }),
	).toHaveAccessibleDescription(/^Type \/ for commands or @ for files\./);
	await box.fill("first line");
	await box.press("Shift+Enter");
	await box.pressSequentially("second line");
	expect(await receivedFrames(id, "send")).toHaveLength(0);
	await box.press("Enter");
	await expect(box).toHaveText("");
	await expect
		.poll(async () => receivedFrames(id, "send"))
		.toEqual([{ type: "send", text: "first line\nsecond line", attachments: [] }]);
	await expect(view.getByText("first line")).toBeVisible();
});

test("a pasted picture, a dropped picture and an attached file each become a chip and go in send", async ({
	page,
	context,
}) => {
	test.setTimeout(60_000);
	const student = await createStudent(context);
	const { id, view } = await openChat(page, student.workspaceId, "Composer");
	const chips = view.getByTestId("composer-chip");

	await view.getByTestId("chat-composer-input").focus();
	await giveFile(page, "paste", { name: "image.png", ...PNG_FILE });
	await expect(chips).toHaveCount(1);
	await expect(chips.first().locator("img")).toBeVisible();

	await giveFile(page, "drop", { name: "dropped.png", ...PNG_FILE });
	await expect(chips).toHaveCount(2);

	await view.getByTestId("chat-composer-file").setInputFiles({
		name: "notes.txt",
		mimeType: "text/plain",
		buffer: Buffer.from("remember"),
	});
	await expect(chips).toHaveCount(3);
	await expect(chips.nth(2).locator("img")).toHaveCount(0);

	// A chip can be taken off before sending.
	await view.getByRole("button", { name: "Remove notes.txt" }).click();
	await expect(chips).toHaveCount(2);
	await view.getByTestId("chat-composer-file").setInputFiles({
		name: "notes.txt",
		mimeType: "text/plain",
		buffer: Buffer.from("remember"),
	});
	await expect(chips).toHaveCount(3);

	await view.getByTestId("chat-composer-input").fill("look at these");
	await view.getByTestId("chat-composer-send").click();
	// Cleared once the host has echoed the message.
	await expect(chips).toHaveCount(0);
	await expect(view.getByTestId("chat-composer-input")).toHaveText("");
	await expect.poll(async () => (await receivedFrames(id, "send")).length).toBe(1);
	const [send] = await receivedFrames(id, "send");
	const paths = ((send?.attachments ?? []) as { path: string }[]).map((a) => a.path);
	expect(paths).toHaveLength(3);
	expect(paths[0]).toMatch(/^\.portikus\/pastes\/[\d-]+T[\d-]+(-\d)?\/image\.png$/);
	expect(paths[1]).toMatch(/^\.portikus\/pastes\/[\d-]+T[\d-]+(-\d)?\/dropped\.png$/);
	expect(paths[2]).toMatch(/^\.portikus\/pastes\/[\d-]+T[\d-]+(-\d)?\/notes\.txt$/);
	expect(send?.text).toBe("look at these");
});

test("an SVG and a picture over 5 MB are refused with a reason", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const { view } = await openChat(page, student.workspaceId, "Composer");
	const alert = view.getByTestId("chat-composer-error");
	await view.getByTestId("chat-composer-file").setInputFiles({
		name: "logo.svg",
		mimeType: "image/svg+xml",
		buffer: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"),
	});
	await expect(alert).toContainText("SVG");
	await view.getByTestId("chat-composer-file").setInputFiles({
		name: "big.png",
		mimeType: "image/png",
		buffer: Buffer.alloc(5 * 1024 * 1024 + 1),
	});
	await expect(alert).toContainText("big.png is over 5 MB");
	await expect(view.getByTestId("composer-chip")).toHaveCount(0);
});

/**
 * Keep the fake's turn open, as a real one is while Claude works: once the
 * page has sent a message, the frame that ends the turn is held back, and so
 * is the fresh turn.started the fake sends with each later message, which a
 * real host does not send mid-turn. Replayed history, and the end after
 * Stop, pass untouched. With `holdReplies`, the fake's replies to later
 * messages wait for `releaseReplies`, as Claude takes a message in only at
 * its next step.
 */
async function holdTurnOpen(page: Page, holdReplies: boolean) {
	const held: string[] = [];
	let socket: WebSocketRoute | undefined;
	await page.routeWebSocket(/\/chat$/, (ws) => {
		socket = ws;
		const server = ws.connectToServer();
		let holding = false;
		let started = false;
		ws.onMessage((message) => {
			if (typeof message === "string") {
				if (message.includes('"type":"send"')) holding = true;
				// A Stop ends the turn for real.
				if (message.includes('"type":"interrupt"')) holding = false;
			}
			server.send(message);
		});
		server.onMessage((message) => {
			if (holding && typeof message === "string") {
				if (message.includes('"type":"turn.finished"')) return;
				if (message.includes('"type":"turn.started"')) {
					if (started) return;
					started = true;
				}
				if (holdReplies && message.includes('"id":"m-reply-')) {
					held.push(message);
					return;
				}
			}
			ws.send(message);
		});
	});
	return {
		releaseReplies: () => {
			for (const message of held.splice(0)) socket?.send(message);
		},
	};
}

/** Start the fake's turn, which stays open, and wait for its Working line. */
async function startHeldTurn(
	page: Page,
	student: { workspaceId: string },
	holdReplies = false,
) {
	const { releaseReplies } = await holdTurnOpen(page, holdReplies);
	const opened = await openChat(page, student.workspaceId, "Composer");
	const box = opened.view.getByTestId("chat-composer-input");
	// The replayed history shows once the socket is open, so the send is not refused.
	await expect(opened.view.getByText("Earlier answer")).toBeVisible();
	await box.fill("Run the tests");
	await box.press("Enter");
	await expect(opened.view.getByTestId("chat-working")).toBeVisible();
	return { ...opened, box, releaseReplies };
}

/** `later` comes after `earlier` in the page. */
async function isAfter(earlier: Locator, later: Locator): Promise<boolean> {
	return earlier.evaluate(
		(node, other) =>
			Boolean(
				node.compareDocumentPosition(other as Node) & Node.DOCUMENT_POSITION_FOLLOWING,
			),
		await later.elementHandle(),
	);
}

test("while a turn runs, Send stays beside Stop, sends, and marks the message", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const { id, view, box } = await startHeldTurn(page, student);
	const stop = view.getByRole("button", { name: "Stop", exact: true });
	await expect(stop).toBeVisible();
	await expect(stop).toHaveAttribute("data-testid", "chat-composer-stop");
	const send = view.getByRole("button", { name: "Send", exact: true });
	await expect(send).not.toHaveAttribute("aria-disabled");
	await expect(view.getByTestId("chat-composer-hint")).toHaveText(
		"Enter sends without stopping Claude. Esc stops it.",
	);
	// The fake's turn is waiting on its question, so the Working line says so.
	await expect(view.getByTestId("chat-working")).toHaveText(
		/^Waiting for your answer · \d+m \d+s$/,
	);
	await box.fill("Skip the docs");
	await send.click();
	await expect(box).toHaveText("");
	await expect
		.poll(async () => (await receivedFrames(id, "send")).map((frame) => frame.text))
		.toEqual(["Run the tests", "Skip the docs"]);
	const sent = view
		.getByTestId("chat-user-message")
		.filter({ hasText: "Skip the docs" });
	await expect(sent.getByTestId("chat-sent-while-working")).toHaveText(
		"Sent while Claude was working",
	);
	await expect(view.getByTestId("chat-sent-while-working")).toHaveCount(1);
	// The work after it is a new turn below it, still working.
	await expect(view.getByTestId("chat-working")).toHaveCount(1);
	expect(await isAfter(sent, view.getByTestId("chat-working"))).toBe(true);
	await stop.click();
	await expect
		.poll(async () => receivedFrames(id, "interrupt"))
		.toEqual([{ type: "interrupt" }]);
});

test("a step still running when the student sends stays on the Working line until Claude takes the message in", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const { view, box, releaseReplies } = await startHeldTurn(page, student, true);
	const working = view.getByTestId("chat-working");
	const folds = view.getByTestId("chat-worked");
	const foldsBefore = await folds.count();
	await box.fill("Skip the docs");
	await box.press("Enter");
	const sent = view
		.getByTestId("chat-user-message")
		.filter({ hasText: "Skip the docs" });
	await expect(sent.getByTestId("chat-sent-while-working")).toBeVisible();
	// Claude has not taken it in yet: the step in hand stays named, nothing folds.
	await expect(working).toHaveText(/^Waiting for your answer · \d+m \d+s$/);
	await expect(folds).toHaveCount(foldsBefore);
	expect(await isAfter(working, sent)).toBe(true);
	// Its next step does, and the work after the message is a new turn below it.
	releaseReplies();
	await expect(view.getByText("This is a canned reply.")).toBeVisible();
	await expect(working).toHaveCount(1);
	await expect(working).toHaveText(/^Working \d+m \d+s$/);
	await expect(folds).toHaveCount(foldsBefore + 1);
	expect(await isAfter(sent, working)).toBe(true);
});

test("Escape in the message box stops a running turn, but first closes an open picker and the options panel", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const { id, view, box } = await startHeldTurn(page, student);
	await openChatOptions(view);
	await view.getByRole("button", { name: /^Model/ }).click();
	await expect(page.getByRole("menu")).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.getByRole("menu")).toHaveCount(0);
	expect(await receivedFrames(id, "interrupt")).toEqual([]);
	await box.focus();
	await box.press("Escape");
	await expect(view.getByTestId("composer-picks")).toBeHidden();
	expect(await receivedFrames(id, "interrupt")).toEqual([]);
	await box.press("Escape");
	await expect
		.poll(async () => receivedFrames(id, "interrupt"))
		.toEqual([{ type: "interrupt" }]);
});

test("Stop pressed from the keyboard ends the turn and leaves the keyboard in the message box", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const { view, box } = await startHeldTurn(page, student);
	const stop = view.getByRole("button", { name: "Stop", exact: true });
	await stop.focus();
	await page.keyboard.press("Enter");
	await expect(stop).toHaveCount(0);
	await expect(box).toBeFocused();
});

test("entering a code block is announced with how to send and leave it", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const { view } = await openChat(page, student.workspaceId, "Composer");
	const box = view.getByTestId("chat-composer-input");
	const status = view.getByTestId("chat-composer-status");
	const announced =
		/^In a code block\. In code, Enter adds a line\. (Ctrl|Cmd)\+Enter sends\. Press Enter three times at the end to leave it\.$/;
	await box.pressSequentially("```");
	await box.press("Enter");
	await expect(status).toHaveText(announced);
	// Leaving the block empties the region, so the next block is read out again.
	await box.press("Enter");
	await box.press("Enter");
	await box.press("Enter");
	await expect(status).toHaveText("");
	await box.pressSequentially("```");
	await box.press("Enter");
	await expect(status).toHaveText(announced);
});

test("Up in an empty box brings back the last message sent", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const { view } = await openChat(page, student.workspaceId, "Composer");
	const box = view.getByTestId("chat-composer-input");
	await box.press("ArrowUp");
	await expect(box).toHaveText("");
	await box.pressSequentially("check **all** files");
	await box.press("Enter");
	await expect(box).toHaveText("");
	await box.press("ArrowUp");
	await expect(box).toHaveText("check all files");
	await expect(box.locator("strong")).toHaveText("all");
	// With text in the box, Up is left to move the cursor.
	await box.press("ArrowUp");
	await expect(box).toHaveText("check all files");
});

for (const colorScheme of ["light", "dark"] as const) {
	test(`the Working line and a message sent mid-turn have no accessibility violations (${colorScheme})`, async ({
		page,
		context,
	}) => {
		await page.emulateMedia({ colorScheme });
		const student = await createStudent(context);
		const { id, view, box } = await startHeldTurn(page, student);
		await box.fill("Skip the docs");
		await box.press("Enter");
		await expect(view.getByTestId("chat-sent-while-working")).toBeVisible();
		await expectNoViolations(page, `[data-testid="chat-view-${id}"]`);
	});
}

test("the microphone dictates into the box and never sends", async ({
	page,
	context,
}) => {
	await fakeSpeech(page);
	const student = await createStudent(context);
	const { id, view } = await openChat(page, student.workspaceId, "Composer");
	const box = view.getByTestId("chat-composer-input");
	await box.fill("fix the bug");
	await box.press("Home");
	for (let i = 0; i < 3; i += 1) await box.press("ArrowRight");
	const mic = view.getByTestId(`chat-voice-${id}`);
	await mic.hover();
	await page.mouse.down();
	await expect(mic).toHaveAttribute("aria-pressed", "true");
	await expect(view.getByTestId(`chat-voice-status-${id}`)).toHaveText("Listening…");
	await page.evaluate(() =>
		(window as unknown as FakeSpeechWindow).__speech.say("now", true),
	);
	await page.mouse.up();
	await expect(box).toHaveText("fix now the bug");
	await expect(mic).toHaveAttribute("aria-pressed", "false");
	expect(await receivedFrames(id, "send")).toEqual([]);
});

for (const colorScheme of ["light", "dark"] as const) {
	test(`interim dictation sits greyed in the box, is not sent, and gives way to the final words (${colorScheme})`, async ({
		page,
		context,
	}) => {
		await page.emulateMedia({ colorScheme });
		await fakeSpeech(page);
		const student = await createStudent(context);
		const { id, view } = await openChat(page, student.workspaceId, "Composer");
		const box = view.getByTestId("chat-composer-input");
		await box.fill("fix the bug");
		await box.press("End");
		await expect(box).toHaveText("fix the bug");
		const mic = view.getByTestId(`chat-voice-${id}`);
		await mic.hover();
		await page.mouse.down();
		await expect(mic).toHaveAttribute("aria-pressed", "true");
		await expect(view.getByTestId(`chat-voice-status-${id}`)).toHaveText("Listening…");
		await page.evaluate(() =>
			(window as unknown as FakeSpeechWindow).__speech.say("pl", false),
		);
		const interim = box.getByTestId("chat-voice-interim");
		await expect(interim).toHaveText(" pl");
		await expect(interim).toHaveAttribute("aria-hidden", "true");
		const [shown, typed] = await Promise.all([
			interim.evaluate((node) => getComputedStyle(node).color),
			box.evaluate((node) => getComputedStyle(node).color),
		]);
		expect(shown).not.toBe(typed);
		await expectNoViolations(page, '[data-testid="chat-composer"]');
		await view
			.getByTestId("chat-composer")
			.screenshot({ path: `screenshots/chat-dictation-interim-${colorScheme}.png` });
		await page.evaluate(() =>
			(window as unknown as FakeSpeechWindow).__speech.say("please", true),
		);
		await expect(interim).toHaveCount(0);
		await expect(box).toHaveText("fix the bug please");
		await page.evaluate(() =>
			(window as unknown as FakeSpeechWindow).__speech.say("and th", false),
		);
		await expect(interim).toHaveText(" and th");
		// Enter mid-dictation sends only the typed and settled words.
		await box.press("Enter");
		await page.mouse.up();
		await expect.poll(async () => (await receivedFrames(id, "send")).length).toBe(1);
		const [frame] = await receivedFrames(id, "send");
		expect(JSON.stringify(frame)).toContain("fix the bug please");
		expect(JSON.stringify(frame)).not.toContain("and th");
	});
}

for (const colorScheme of ["light", "dark"] as const) {
	test(`the composer has no accessibility violations (${colorScheme})`, async ({
		page,
		context,
	}) => {
		await page.emulateMedia({ colorScheme });
		const student = await createStudent(context);
		const { view } = await openChat(page, student.workspaceId, "Composer");
		await giveFile(page, "paste", { name: "image.png", ...PNG_FILE });
		await expect(view.getByTestId("composer-chip")).toHaveCount(1);
		await expectNoViolations(page, '[data-testid="chat-composer"]');
	});
}

test("at 360 px wide the composer does not scroll sideways", async ({
	page,
	context,
}) => {
	await page.setViewportSize({ width: 360, height: 800 });
	const student = await createStudent(context);
	const { view } = await openChat(page, student.workspaceId, "Composer");
	await giveFile(page, "paste", {
		name: "a-very-long-picture-name-that-keeps-going-and-going-and-going.png",
		...PNG_FILE,
	});
	await expect(view.getByTestId("composer-chip")).toHaveCount(1);
	const overflow = await page.evaluate(() => {
		const form = document.querySelector<HTMLElement>('[data-testid="chat-composer"]');
		return {
			page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
			form: form ? form.scrollWidth - form.clientWidth : -1,
		};
	});
	expect(overflow).toEqual({ page: 0, form: 0 });
	await expect(view.getByTestId("chat-composer-send")).toBeVisible();
});

test("a chat opened from the New tab menu by keyboard puts the keyboard in its message box", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, { name: "Keys" });
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
	await page.getByTestId("launcher").focus();
	await page.keyboard.press("Enter");
	const gui = page.getByRole("menuitem", { name: "Claude Code (GUI)" });
	await expect(gui).toBeVisible();
	while (!(await gui.evaluate((node) => node === document.activeElement))) {
		await page.keyboard.press("ArrowDown");
	}
	await page.keyboard.press("Enter");
	const box = page.getByTestId("chat-composer-input");
	await expect(box).toBeFocused({ timeout: 15_000 });
	await page.keyboard.type("hello");
	await expect(box).toHaveText("hello");
});

test("removing a chip by keyboard moves to the next chip, then the box", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const { view } = await openChat(page, student.workspaceId, "Composer");
	await view.getByTestId("chat-composer-input").focus();
	await giveFile(page, "paste", { name: "one.png", ...PNG_FILE });
	await giveFile(page, "paste", { name: "two.png", ...PNG_FILE });
	await expect(view.getByTestId("composer-chip")).toHaveCount(2);
	await view.getByRole("button", { name: "Remove one.png" }).focus();
	await page.keyboard.press("Enter");
	await expect(view.getByRole("button", { name: "Remove two.png" })).toBeFocused();
	await expect(view.getByTestId("chat-composer-status")).toHaveText("Removed one.png.");
	await page.keyboard.press("Enter");
	await expect(view.getByTestId("composer-chip")).toHaveCount(0);
	await expect(view.getByTestId("chat-composer-input")).toBeFocused();
});

test("a picture over 2000 px is made smaller in the browser before it is saved", async ({
	page,
	context,
}) => {
	test.setTimeout(60_000);
	const student = await createStudent(context);
	const { id, view } = await openChat(page, student.workspaceId, "Composer");
	const uploaded = page.waitForRequest(
		(request) => request.method() !== "GET" && request.url().includes("big.webp"),
	);
	await view.getByTestId("chat-composer-file").setInputFiles({
		name: "big.png",
		mimeType: "image/png",
		buffer: Buffer.from(png(3200, 1800), "base64"),
	});
	const chip = view.getByTestId("composer-chip");
	await expect(chip).toContainText("big.webp");
	const saved = (await uploaded).url();
	// Read the saved file back and measure it.
	const size = await page.evaluate(async (url) => {
		const bitmap = await createImageBitmap(await (await fetch(url)).blob());
		return [bitmap.width, bitmap.height];
	}, saved);
	expect(size).toEqual([2000, 1125]);
	await view.getByTestId("chat-composer-input").fill("this one");
	await view.getByTestId("chat-composer-input").press("Enter");
	await expect.poll(async () => (await receivedFrames(id, "send")).length).toBe(1);
	const [send] = await receivedFrames(id, "send");
	expect(((send?.attachments ?? []) as { path: string }[])[0]?.path).toMatch(
		/\/big\.webp$/,
	);
});

test("Markdown typed in the box shows formatted and is sent as the same Markdown", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const { id, view } = await openChat(page, student.workspaceId, "Composer");
	const box = view.getByTestId("chat-composer-input");
	await box.click();
	await page.keyboard.type("Fix **this** and `that` in *one* go");
	await expect(box.locator("strong")).toHaveText("this");
	await expect(box.locator("code")).toHaveText("that");
	await expect(box.locator("em")).toHaveText("one");
	await expect(box).toHaveText("Fix this and that in one go");
	await page.keyboard.press("Shift+Enter");
	await page.keyboard.type("- first");
	await page.keyboard.press("Shift+Enter");
	await page.keyboard.type("second");
	await expect(box.locator("ul > li")).toHaveCount(2);
	await page.keyboard.press("Shift+Enter");
	await page.keyboard.press("Shift+Enter");
	await page.keyboard.type("```ts");
	await page.keyboard.press("Enter");
	await expect(view.getByTestId("chat-composer-hint")).toContainText(
		"In code, Enter adds a line.",
	);
	await page.keyboard.type("const a = 1;");
	await page.keyboard.press("Enter");
	await page.keyboard.type("  a * 2 * 3;");
	await expect(box.locator("pre")).toBeVisible();
	expect(await receivedFrames(id, "send")).toHaveLength(0);
	await page.keyboard.press("ControlOrMeta+Enter");
	await expect
		.poll(async () => receivedFrames(id, "send"))
		.toEqual([
			{
				type: "send",
				text: "Fix **this** and `that` in *one* go\n\n- first\n- second\n\n```ts\nconst a = 1;\n  a * 2 * 3;\n```",
				attachments: [],
			},
		]);
	await expect(box).toHaveText("");
	await expect(view.getByTestId("chat-composer-hint")).toHaveText(
		"Enter sends, Shift+Enter adds a line, Up brings back your last message.",
	);
});

test("pasted rich text arrives as plain text, keeping its lines", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const { id, view } = await openChat(page, student.workspaceId, "Composer");
	const box = view.getByTestId("chat-composer-input");
	await box.click();
	await page.evaluate(() => {
		const transfer = new DataTransfer();
		transfer.setData(
			"text/html",
			"<h1>Title</h1><p><b>bold</b> <script>x()</script></p>",
		);
		transfer.setData("text/plain", "Title\n\nbold *star*");
		document.querySelector('[data-testid="chat-composer-input"]')?.dispatchEvent(
			new ClipboardEvent("paste", {
				clipboardData: transfer,
				bubbles: true,
				cancelable: true,
			}),
		);
	});
	await expect(box.locator("strong, h1, em")).toHaveCount(0);
	await box.press("Enter");
	await expect
		.poll(async () => receivedFrames(id, "send"))
		.toEqual([{ type: "send", text: "Title\n\nbold *star*", attachments: [] }]);
});

test("a paste of more than 40 lines is attached as a text file, not put in the box", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const { id, view } = await openChat(page, student.workspaceId, "Composer");
	const box = view.getByTestId("chat-composer-input");
	await box.click();
	const pasteLog = (lines: number) =>
		page.evaluate((count) => {
			const transfer = new DataTransfer();
			const log = Array.from({ length: count }, (_, at) => `Error: step ${at} failed`);
			transfer.setData("text/plain", log.join("\n"));
			document.querySelector('[data-testid="chat-composer-input"]')?.dispatchEvent(
				new ClipboardEvent("paste", {
					clipboardData: transfer,
					bubbles: true,
					cancelable: true,
				}),
			);
		}, lines);
	const status = view.getByTestId("chat-composer-status");
	await pasteLog(60);
	const chip = view.getByTestId("composer-chip");
	await expect(chip).toHaveCount(1);
	await expect(chip).toContainText("pasted-text.txt");
	await expect(chip.getByTestId("composer-chip-size")).toHaveText("60 lines");
	await expect(box).toHaveText("");
	await expect(status).toHaveText("Pasted 60 lines, attached as pasted-text.txt.");
	await expectNoViolations(page, '[data-testid="chat-composer"]');
	// A second paste is a second file, named apart, and said so.
	await pasteLog(45);
	await expect(chip).toHaveCount(2);
	await expect(status).toHaveText("Pasted 45 lines, attached as pasted-text-2.txt.");
	await view.getByRole("button", { name: "Remove pasted-text-2.txt" }).click();
	await expect(chip).toHaveCount(1);
	await box.pressSequentially("Why does this fail?");
	await box.press("Enter");
	await expect
		.poll(async () => receivedFrames(id, "send"))
		.toEqual([
			{
				type: "send",
				text: "Why does this fail?",
				attachments: [
					{
						path: expect.stringMatching(
							/^\.portikus\/pastes\/[^/]+\/pasted-text\.txt$/,
						),
					},
				],
			},
		]);
});

test("a long paste sent and pasted again at once is a new file, and the sent file is kept", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const { id, view } = await openChat(page, student.workspaceId, "Composer");
	const box = view.getByTestId("chat-composer-input");
	await box.click();
	const deletes: string[] = [];
	page.on("request", (request) => {
		if (request.method() === "DELETE") deletes.push(request.url());
	});
	const chip = view.getByTestId("composer-chip");
	// Paste, send and paste again inside one evaluate, well within 0.8 seconds.
	await page.evaluate(async () => {
		const target = document.querySelector<HTMLElement>(
			'[data-testid="chat-composer-input"]',
		);
		const log = Array.from({ length: 60 }, (_, at) => `Error: step ${at} failed`);
		const pasteLog = () => {
			const transfer = new DataTransfer();
			transfer.setData("text/plain", log.join("\n"));
			target?.dispatchEvent(
				new ClipboardEvent("paste", {
					clipboardData: transfer,
					bubbles: true,
					cancelable: true,
				}),
			);
		};
		pasteLog();
		// Send once the chip is saved, as a student pressing Enter would.
		while (!document.querySelector('[data-testid="composer-chip"]')) {
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		target?.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
		);
		pasteLog();
	});
	await expect.poll(async () => (await receivedFrames(id, "send")).length).toBe(1);
	const [frame] = await receivedFrames(id, "send");
	expect(frame?.attachments).toHaveLength(1);
	await expect(view.getByTestId("chat-composer-status")).toHaveText(
		/^Pasted 60 lines, attached as pasted-text-2\.txt\.$/,
	);
	await expect(chip).toHaveCount(1);
	await expect(chip).toContainText("pasted-text-2.txt");
	await expect(box).toHaveText("");
	expect(deletes).toEqual([]);
});

for (const colorScheme of ["light", "dark"] as const) {
	test(`the same long text pasted twice at once goes in the box, and its file is deleted (${colorScheme})`, async ({
		page,
		context,
	}) => {
		await page.emulateMedia({ colorScheme });
		const student = await createStudent(context);
		const { id, view } = await openChat(page, student.workspaceId, "Composer");
		const box = view.getByTestId("chat-composer-input");
		await box.click();
		const deleted = page.waitForResponse(
			(response) =>
				response.request().method() === "DELETE" &&
				response.url().includes("pasted-text.txt"),
		);
		// Both pastes inside one evaluate, well within 0.8 seconds of each other.
		await page.evaluate(() => {
			const log = Array.from({ length: 60 }, (_, at) => `Error: step ${at} failed`);
			for (let i = 0; i < 2; i += 1) {
				const transfer = new DataTransfer();
				transfer.setData("text/plain", log.join("\n"));
				document.querySelector('[data-testid="chat-composer-input"]')?.dispatchEvent(
					new ClipboardEvent("paste", {
						clipboardData: transfer,
						bubbles: true,
						cancelable: true,
					}),
				);
			}
		});
		await expect(view.getByTestId("chat-composer-status")).toHaveText(
			"Pasted 60 lines inline.",
		);
		await expect(view.getByTestId("composer-chip")).toHaveCount(0);
		await expect(box.locator("p")).toHaveCount(60);
		expect((await deleted).ok()).toBe(true);
		await expectNoViolations(page, '[data-testid="chat-composer"]');
		await box.press("ControlOrMeta+End");
		await box.press("Enter");
		await expect.poll(async () => (await receivedFrames(id, "send")).length).toBe(1);
		const [frame] = await receivedFrames(id, "send");
		expect(frame?.attachments).toEqual([]);
		expect(String(frame?.text).split("\n")).toHaveLength(60);
	});
}

test("Send is an icon button at the end of the row, with the microphone beside it", async ({
	page,
	context,
}) => {
	await fakeSpeech(page);
	const student = await createStudent(context);
	const { id, view } = await openChat(page, student.workspaceId, "Composer");
	const send = view.getByRole("button", { name: "Send", exact: true });
	await expect(send).toHaveText("");
	await expect(send.locator("svg")).toBeVisible();
	const mic = view.getByTestId(`chat-voice-${id}`);
	const attach = view.getByTestId("chat-composer-attach");
	const permissions = view.getByTestId("composer-options");
	const [sendBox, micBox, attachBox, pickBox] = await Promise.all(
		[send, mic, attach, permissions].map(async (l) => l.boundingBox()),
	);
	if (!sendBox || !micBox || !attachBox || !pickBox) throw new Error("not laid out");
	expect(micBox.x).toBeLessThan(sendBox.x);
	expect(micBox.x).toBeGreaterThan(pickBox.x);
	expect(attachBox.x).toBeLessThan(pickBox.x);
	// The keyboard reaches Send after the microphone, and its ring shows.
	await mic.focus();
	await page.keyboard.press("Tab");
	await expect(send).toBeFocused();
	const ring = await send.evaluate((node) => getComputedStyle(node).outlineStyle);
	expect(ring).toBe("solid");
});
