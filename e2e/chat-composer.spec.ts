import { expect, type Page, test } from "@playwright/test";
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
import { FAKE_AGENT_URL } from "./ports";
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

/** Open the workspace and start a chat from the New tab menu. */
async function openChat(page: Page, student: { workspaceId: string }) {
	const project = await createProject(student.workspaceId, { name: "Composer" });
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
	await page.getByTestId("launcher").click();
	await page.getByTestId("launcher-claude-gui").click();
	await expect
		.poll(async () => (await terminalIds(student.workspaceId, project.id)).length)
		.toBe(1);
	const [id] = await terminalIds(student.workspaceId, project.id);
	if (!id) throw new Error("the chat row was not created");
	const view = page.getByTestId(`chat-view-${id}`);
	await expect(view).toBeVisible({ timeout: 15_000 });
	await expect(view.getByTestId("chat-composer-input")).toBeVisible();
	return { id, view, project };
}

/** The frames the fake chat has received from the browser, parsed. */
async function received(id: string): Promise<Record<string, unknown>[]> {
	const response = await fetch(`${FAKE_AGENT_URL}/__test/chats/${id}/received`);
	const body = (await response.json()) as { received: string[] };
	return body.received.map((frame) => JSON.parse(frame) as Record<string, unknown>);
}

async function frames(id: string, type: string) {
	return (await received(id)).filter((frame) => frame.type === type);
}

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
	const { id, view } = await openChat(page, student);
	const box = view.getByTestId("chat-composer-input");
	await expect(
		view.getByRole("textbox", { name: "Message Claude Code" }),
	).toHaveAttribute("aria-placeholder", "Message Claude Code, or paste or drop images");
	await expect(box).toHaveAttribute("aria-multiline", "true");
	await box.fill("first line");
	await box.press("Shift+Enter");
	await box.pressSequentially("second line");
	expect(await frames(id, "send")).toHaveLength(0);
	await box.press("Enter");
	await expect(box).toHaveText("");
	await expect
		.poll(async () => frames(id, "send"))
		.toEqual([{ type: "send", text: "first line\nsecond line", attachments: [] }]);
	await expect(view.getByText("first line")).toBeVisible();
});

test("a pasted picture, a dropped picture and an attached file each become a chip and go in send", async ({
	page,
	context,
}) => {
	test.setTimeout(60_000);
	const student = await createStudent(context);
	const { id, view } = await openChat(page, student);
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
	await expect.poll(async () => (await frames(id, "send")).length).toBe(1);
	const [send] = await frames(id, "send");
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
	const { view } = await openChat(page, student);
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

test("each picker sends its set and shows what the host reports", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const { id, view } = await openChat(page, student);
	const model = view.getByRole("combobox", { name: "Model" });
	const effort = view.getByRole("combobox", { name: "Effort" });
	const mode = view.getByRole("combobox", { name: "Permissions" });
	const agent = view.getByRole("combobox", { name: "Agent" });

	await expect(agent).toHaveValue("claude");
	await expect(
		agent.getByRole("option", { name: "Codex (coming soon)" }),
	).toHaveJSProperty("disabled", true);

	await model.selectOption("opus");
	await expect(model).toHaveValue("opus");
	await effort.selectOption("xhigh");
	await expect(effort).toHaveValue("xhigh");
	await mode.selectOption("bypassPermissions");
	await expect(mode).toHaveValue("bypassPermissions");
	await expect(view.getByTestId("chat-bypass-warning")).toContainText(
		"without asking you first",
	);

	await expect
		.poll(async () => frames(id, "set"))
		.toEqual([
			{ type: "set", model: "opus" },
			{ type: "set", effort: "xhigh" },
			{ type: "set", mode: "bypassPermissions" },
		]);
	for (const [picker, value] of [
		[model, "haiku"],
		[effort, "low"],
		[mode, "plan"],
	] as const) {
		await picker.selectOption(value);
		await expect(picker).toHaveValue(value);
	}
	await expect(view.getByTestId("chat-bypass-warning")).toHaveCount(0);
});

test("while a turn runs, Stop sends interrupt", async ({ page, context }) => {
	const student = await createStudent(context);
	// Keep the fake's turn open by holding back the frame that ends it.
	await page.routeWebSocket(/\/chat$/, (ws) => {
		const server = ws.connectToServer();
		ws.onMessage((message) => server.send(message));
		server.onMessage((message) => {
			if (typeof message === "string" && message.includes('"type":"turn.finished"')) {
				return;
			}
			ws.send(message);
		});
	});
	const { id, view } = await openChat(page, student);
	// The fake's turn starts on the first message.
	await view.getByTestId("chat-composer-input").fill("Run the tests");
	await view.getByTestId("chat-composer-input").press("Enter");
	const stop = view.getByRole("button", { name: "Stop", exact: true });
	await expect(stop).toBeVisible();
	await expect(stop).toHaveAttribute("data-testid", "chat-composer-stop");
	// Send stays beside Stop, waiting, and says why.
	const send = view.getByRole("button", { name: "Send", exact: true });
	await expect(send).toHaveAttribute("aria-disabled", "true");
	await expect(send).toHaveAccessibleDescription(/^Claude is working\./);
	await stop.click();
	await expect
		.poll(async () => frames(id, "interrupt"))
		.toEqual([{ type: "interrupt" }]);
});

test("the microphone dictates into the box and never sends", async ({
	page,
	context,
}) => {
	await fakeSpeech(page);
	const student = await createStudent(context);
	const { id, view } = await openChat(page, student);
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
	expect(await frames(id, "send")).toEqual([]);
});

for (const colorScheme of ["light", "dark"] as const) {
	test(`the composer has no accessibility violations (${colorScheme})`, async ({
		page,
		context,
	}) => {
		await page.emulateMedia({ colorScheme });
		const student = await createStudent(context);
		const { view } = await openChat(page, student);
		await view
			.getByRole("combobox", { name: "Permissions" })
			.selectOption("bypassPermissions");
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
	const { view } = await openChat(page, student);
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
	const { view } = await openChat(page, student);
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
	const { id, view } = await openChat(page, student);
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
	await expect.poll(async () => (await frames(id, "send")).length).toBe(1);
	const [send] = await frames(id, "send");
	expect(((send?.attachments ?? []) as { path: string }[])[0]?.path).toMatch(
		/\/big\.webp$/,
	);
});

test("Markdown typed in the box shows formatted and is sent as the same Markdown", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const { id, view } = await openChat(page, student);
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
	expect(await frames(id, "send")).toHaveLength(0);
	await page.keyboard.press("ControlOrMeta+Enter");
	await expect
		.poll(async () => frames(id, "send"))
		.toEqual([
			{
				type: "send",
				text: "Fix **this** and `that` in *one* go\n\n- first\n- second\n\n```ts\nconst a = 1;\n  a * 2 * 3;\n```",
				attachments: [],
			},
		]);
	await expect(box).toHaveText("");
	await expect(view.getByTestId("chat-composer-hint")).toHaveText(
		"Enter sends. Shift+Enter adds a line.",
	);
});

test("pasted rich text arrives as plain text, keeping its lines", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const { id, view } = await openChat(page, student);
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
		.poll(async () => frames(id, "send"))
		.toEqual([{ type: "send", text: "Title\n\nbold *star*", attachments: [] }]);
});

test("Send is an icon button at the end of the row, with the microphone beside it", async ({
	page,
	context,
}) => {
	await fakeSpeech(page);
	const student = await createStudent(context);
	const { id, view } = await openChat(page, student);
	const send = view.getByRole("button", { name: "Send", exact: true });
	await expect(send).toHaveText("");
	await expect(send.locator("svg")).toBeVisible();
	const mic = view.getByTestId(`chat-voice-${id}`);
	const attach = view.getByTestId("chat-composer-attach");
	const permissions = view.getByRole("combobox", { name: "Permissions" });
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
