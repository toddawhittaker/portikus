/**
 * Hold-to-talk voice input in a terminal (SPEC.md §25.10). The browser's
 * speech recognition is replaced by a fake the test drives, so no audio is
 * involved and nothing depends on a vendor's service.
 */
import { expect, type Page, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	endTerminal,
	expectConnected,
	openFileTab,
	query,
	settledAxe,
	terminalIds,
	WCAG_TAGS,
	workspacePath,
	workTabs,
} from "./helpers";

interface FakeSpeechWindow {
	__speech: {
		started: number;
		stopped: number;
		say: (text: string, isFinal: boolean) => void;
		fail: (error: string) => void;
	};
}

/** Install a SpeechRecognition the test can drive through `window.__speech`. */
async function fakeSpeech(page: Page): Promise<void> {
	await page.addInitScript(() => {
		type Handler = ((event: unknown) => void) | null;
		const control = {
			started: 0,
			stopped: 0,
			current: null as null | { onresult: Handler; onerror: Handler; onend: Handler },
			say(text: string, isFinal: boolean) {
				const result = Object.assign([{ transcript: text }], { isFinal });
				control.current?.onresult?.({ resultIndex: 0, results: [result] });
			},
			fail(error: string) {
				control.current?.onerror?.({ error });
				control.current?.onend?.(undefined);
			},
		};
		class FakeRecognition {
			continuous = false;
			interimResults = false;
			lang = "";
			onresult: Handler = null;
			onerror: Handler = null;
			onend: Handler = null;
			start() {
				control.started += 1;
				control.current = this;
			}
			stop() {
				control.stopped += 1;
				queueMicrotask(() => this.onend?.(undefined));
			}
			abort() {}
		}
		Object.assign(window, {
			__speech: control,
			SpeechRecognition: FakeRecognition,
			webkitSpeechRecognition: FakeRecognition,
		});
	});
}

/** Remove the API entirely, as Firefox has it. */
async function noSpeech(page: Page): Promise<void> {
	await page.addInitScript(() => {
		Reflect.deleteProperty(window, "SpeechRecognition");
		Reflect.deleteProperty(window, "webkitSpeechRecognition");
	});
}

/** Every `input` frame the page sends to the terminal socket, in order. */
function recordInput(page: Page): string[] {
	const sent: string[] = [];
	page.on("websocket", (socket) => {
		if (!/\/terminals\/[^/]+\/ws/.test(socket.url())) return;
		socket.on("framesent", (frame) => {
			if (typeof frame.payload !== "string") return;
			try {
				const message = JSON.parse(frame.payload) as { type?: string; data?: string };
				if (message.type === "input" && typeof message.data === "string") {
					sent.push(message.data);
				}
			} catch {
				// Not a JSON frame.
			}
		});
	});
	return sent;
}

async function openTerminal(
	page: Page,
	context: Parameters<typeof createStudent>[0],
	appearance?: "light" | "dark",
) {
	const student = await createStudent(context);
	if (appearance) {
		await query(
			"update users set editor_settings = editor_settings || $1::jsonb where id = $2",
			[JSON.stringify({ appearance }), student.userId],
		);
	}
	const project = await createProject(student.workspaceId, { name: "Voice" });
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
	if (appearance) {
		await expect(page.locator("html")).toHaveAttribute("data-theme", appearance);
	}
	await page.getByTestId("launcher").click();
	await page.getByTestId("launcher-terminal").click();
	await expect
		.poll(async () => (await terminalIds(student.workspaceId, project.id)).length)
		.toBe(1);
	const [id] = await terminalIds(student.workspaceId, project.id);
	if (!id) throw new Error("the terminal row was not created");
	await expectConnected(page, id);
	return id;
}

function speech(page: Page) {
	return page.evaluate(() => {
		const { started, stopped } = (window as unknown as FakeSpeechWindow).__speech;
		return { started, stopped };
	});
}

async function say(page: Page, text: string, isFinal: boolean) {
	await page.evaluate(
		([words, final]) =>
			(window as unknown as FakeSpeechWindow).__speech.say(
				words as string,
				final as boolean,
			),
		[text, isFinal] as const,
	);
}

test("holding the microphone listens, shows interim words, and types without Enter", async ({
	page,
	context,
}) => {
	await fakeSpeech(page);
	const sent = recordInput(page);
	const id = await openTerminal(page, context);
	const button = page.getByTestId(`terminal-voice-${id}`);
	await expect(button).toHaveAttribute("aria-pressed", "false");

	await button.hover();
	await page.mouse.down();
	await expect(button).toHaveAttribute("aria-pressed", "true");
	await expect(page.getByTestId(`terminal-voice-status-${id}`)).toHaveText(
		"Listening…",
	);
	await say(page, "echo voi", false);
	await expect(page.getByTestId(`terminal-voice-interim-${id}`)).toHaveText("echo voi");
	await say(page, "echo voice-ok\n", true);
	await page.mouse.up();

	await expect(button).toHaveAttribute("aria-pressed", "false");
	await expect(page.getByTestId(`terminal-voice-interim-${id}`)).toHaveCount(0);
	expect(await speech(page)).toEqual({ started: 1, stopped: 1 });
	await expect.poll(() => sent.join("")).toContain("echo voice-ok");
	const typed = sent.find((data) => data.includes("echo voice-ok")) ?? "";
	expect(typed).not.toMatch(/[\r\n]/);
});

test("Alt+Shift+M in the terminal listens only while held", async ({
	page,
	context,
}) => {
	await fakeSpeech(page);
	const sent = recordInput(page);
	const id = await openTerminal(page, context);
	await page.locator(`[data-testid=terminal-pane-${id}] .xterm-screen`).click();

	await page.keyboard.down("Alt");
	await page.keyboard.down("Shift");
	await page.keyboard.down("KeyM");
	const button = page.getByTestId(`terminal-voice-${id}`);
	await expect(button).toHaveAttribute("aria-pressed", "true");
	await say(page, "ls", true);
	await page.keyboard.up("KeyM");
	await expect(button).toHaveAttribute("aria-pressed", "false");
	await page.keyboard.up("Shift");
	await page.keyboard.up("Alt");

	expect(await speech(page)).toEqual({ started: 1, stopped: 1 });
	await expect.poll(() => sent).toContain("ls");
	// The shortcut itself never reaches the shell.
	expect(sent.join("")).not.toMatch(/[MmµÂ]/);
});

test("Space held on the focused microphone listens until released", async ({
	page,
	context,
}) => {
	await fakeSpeech(page);
	const id = await openTerminal(page, context);
	const button = page.getByTestId(`terminal-voice-${id}`);
	await button.focus();
	await page.keyboard.down("Space");
	await expect(button).toHaveAttribute("aria-pressed", "true");
	await page.keyboard.up("Space");
	await expect(button).toHaveAttribute("aria-pressed", "false");
});

test("a browser without speech recognition shows no microphone", async ({
	page,
	context,
}) => {
	await noSpeech(page);
	const id = await openTerminal(page, context);
	await expect(page.getByTestId(`terminal-actions-${id}`)).toBeVisible();
	await expect(page.getByTestId(`terminal-voice-${id}`)).toHaveCount(0);
});

test("a network error, as Brave gives, hides the microphone, says why, and moves focus to the terminal", async ({
	page,
	context,
}) => {
	await fakeSpeech(page);
	const id = await openTerminal(page, context);
	const button = page.getByTestId(`terminal-voice-${id}`);
	await button.focus();
	await page.keyboard.down("Space");
	await expect(button).toHaveAttribute("aria-pressed", "true");
	await page.evaluate(() =>
		(window as unknown as FakeSpeechWindow).__speech.fail("network"),
	);
	await page.keyboard.up("Space");
	await expect(button).toHaveCount(0);
	const message = "Voice input is not available in this browser.";
	await expect(page.getByTestId(`terminal-voice-status-${id}`)).toHaveText(message);
	await expect(page.getByTestId(`terminal-voice-error-${id}`)).toHaveText(message);
	await expect(
		page.locator(`[data-testid=terminal-pane-${id}] textarea.xterm-helper-textarea`),
	).toBeFocused();
});

test("a voice error is shown on the pane as well as announced", async ({
	page,
	context,
}) => {
	await fakeSpeech(page);
	const id = await openTerminal(page, context);
	await page.getByTestId(`terminal-voice-${id}`).hover();
	await page.mouse.down();
	await page.evaluate(() =>
		(window as unknown as FakeSpeechWindow).__speech.fail("audio-capture"),
	);
	await page.mouse.up();
	await expect(page.getByTestId(`terminal-voice-error-${id}`)).toHaveText(
		"No microphone was found.",
	);
	await expect(page.getByTestId(`terminal-voice-status-${id}`)).toHaveText(
		"No microphone was found.",
	);
	await expect(page.getByTestId(`terminal-voice-status-${id}`)).toHaveAttribute(
		"aria-live",
		"polite",
	);
});

test("a click from assistive technology explains how to hold", async ({
	page,
	context,
}) => {
	await fakeSpeech(page);
	const id = await openTerminal(page, context);
	// element.click() has detail 0, as a screen reader's browse-mode click does.
	await page
		.getByTestId(`terminal-voice-${id}`)
		.evaluate((el) => (el as HTMLElement).click());
	await expect(page.getByTestId(`terminal-voice-status-${id}`)).toHaveText(
		"Hold Space on this button, or Alt+Shift+M in the terminal, to talk.",
	);
	expect((await speech(page)).started).toBe(0);
});

test("a quick second press listens again before the first has ended", async ({
	page,
	context,
}) => {
	await fakeSpeech(page);
	const id = await openTerminal(page, context);
	const button = page.getByTestId(`terminal-voice-${id}`);
	// One task, so the first recognizer's end has not arrived yet.
	await button.evaluate((el) => {
		const press = (type: string) =>
			el.dispatchEvent(
				new PointerEvent(type, {
					bubbles: true,
					button: 0,
					pointerId: 1,
					isPrimary: true,
				}),
			);
		press("pointerdown");
		press("pointerup");
		press("pointerdown");
	});
	await expect(button).toHaveAttribute("aria-pressed", "true");
	expect(await speech(page)).toEqual({ started: 2, stopped: 1 });
});

test("dictation stops when the terminal ends", async ({ page, context }) => {
	await fakeSpeech(page);
	const id = await openTerminal(page, context);
	await page.getByTestId(`terminal-voice-${id}`).hover();
	await page.mouse.down();
	await expect(page.getByTestId(`terminal-voice-${id}`)).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await endTerminal(id);
	// The terminal list is polled every 15 seconds.
	await expect(page.getByTestId(`terminal-ended-${id}`)).toBeVisible({
		timeout: 30_000,
	});
	await expect.poll(async () => (await speech(page)).stopped).toBeGreaterThan(0);
	await page.mouse.up();
});

test("without speech recognition, Alt+Shift+M still reaches the shell", async ({
	page,
	context,
}) => {
	await noSpeech(page);
	const sent = recordInput(page);
	const id = await openTerminal(page, context);
	await page.locator(`[data-testid=terminal-pane-${id}] .xterm-screen`).click();
	await page.keyboard.press("Alt+Shift+KeyM");
	await expect.poll(() => sent.join("")).toContain("\u001bM");
});

for (const appearance of ["dark", "light"] as const) {
	test(`the terminal with its microphone passes axe, idle, listening and in error (${appearance})`, async ({
		page,
		context,
	}) => {
		await fakeSpeech(page);
		const id = await openTerminal(page, context, appearance);
		const idle = await (await settledAxe(page)).withTags(WCAG_TAGS).analyze();
		expect(idle.violations).toEqual([]);

		await page.getByTestId(`terminal-voice-${id}`).hover();
		await page.mouse.down();
		await say(page, "some words", false);
		await expect(page.getByTestId(`terminal-voice-interim-${id}`)).toBeVisible();
		const listening = await (await settledAxe(page)).withTags(WCAG_TAGS).analyze();
		await page.evaluate(() =>
			(window as unknown as FakeSpeechWindow).__speech.fail("audio-capture"),
		);
		await page.mouse.up();
		expect(listening.violations).toEqual([]);

		await expect(page.getByTestId(`terminal-voice-error-${id}`)).toBeVisible();
		const failed = await (await settledAxe(page)).withTags(WCAG_TAGS).analyze();
		expect(failed.violations).toEqual([]);
	});
}

/** Dictation into an open file (SPEC.md §25.10). */
test.describe("voice input in a file", () => {
	// Monaco is a large chunk the dev server transforms on first use.
	test.describe.configure({ timeout: 90_000 });

	const PATH = "src/app.ts";
	const CONTENT = "const answer = 42;\n";

	function lines(page: Page) {
		return page.getByTestId(`editor-${PATH}`).locator(".view-lines");
	}

	/** A student with auto-save off, so "Unsaved" stays up to be seen. */
	async function openFile(
		page: Page,
		context: Parameters<typeof createStudent>[0],
		appearance?: "light" | "dark",
	) {
		const student = await createStudent(context);
		await query(
			"update users set editor_settings = editor_settings || $1::jsonb where id = $2",
			[
				JSON.stringify({ autoSave: false, ...(appearance ? { appearance } : {}) }),
				student.userId,
			],
		);
		await openFileTab(page, student, "Dictation", PATH, CONTENT);
		await expect(lines(page)).toContainText("const answer = 42;", { timeout: 60_000 });
		if (appearance) {
			await expect(page.locator("html")).toHaveAttribute("data-theme", appearance);
		}
	}

	test("holding the microphone replaces the selection, and one Ctrl+Z takes it all back", async ({
		page,
		context,
	}) => {
		await fakeSpeech(page);
		await openFile(page, context);
		const button = page.getByRole("button", { name: "Hold to dictate into app.ts" });
		await expect(button).toHaveAttribute("data-testid", `file-voice-${PATH}`);

		await lines(page).click();
		await page.keyboard.press("Control+Home");
		await page.keyboard.press("Shift+End");
		await button.hover();
		await page.mouse.down();
		await expect(button).toHaveAttribute("aria-pressed", "true");
		await say(page, "let spoken = 1;", true);
		await page.mouse.up();
		await expect(button).toHaveAttribute("aria-pressed", "false");

		await expect(lines(page)).toContainText("let spoken = 1;");
		await expect(lines(page)).not.toContainText("const answer");
		await expect(page.getByTestId(`file-status-${PATH}`)).toHaveText("Unsaved");

		await page.keyboard.press("Control+z");
		await expect(lines(page)).toContainText("const answer = 42;");
		await expect(lines(page)).not.toContainText("spoken");
	});

	test("Alt+Shift+M held in the editor dictates at the cursor", async ({
		page,
		context,
	}) => {
		await fakeSpeech(page);
		await openFile(page, context);
		await lines(page).click();
		await page.keyboard.press("Control+Home");
		await page.keyboard.press("End");

		await page.keyboard.down("Alt");
		await page.keyboard.down("Shift");
		await page.keyboard.down("KeyM");
		const button = page.getByTestId(`file-voice-${PATH}`);
		await expect(button).toHaveAttribute("aria-pressed", "true");
		await say(page, " // said", true);
		await page.keyboard.up("KeyM");
		await expect(button).toHaveAttribute("aria-pressed", "false");
		await page.keyboard.up("Shift");
		await page.keyboard.up("Alt");

		expect(await speech(page)).toEqual({ started: 1, stopped: 1 });
		await expect(lines(page)).toContainText("const answer = 42; // said");
		// The shortcut itself types nothing.
		await expect(lines(page)).not.toContainText(/[MÂ]/);
		await expect(page.getByTestId(`file-status-${PATH}`)).toHaveText("Unsaved");
	});

	test("an image and a CSV table have no microphone", async ({ page, context }) => {
		await fakeSpeech(page);
		const student = await createStudent(context);
		await openFileTab(page, student, "Picture", "pic.png", "\u0000\u0001PNG\u0000");
		await expect(page.getByTestId("file-pane-pic.png")).toBeVisible();
		await expect(page.getByTestId("file-voice-pic.png")).toHaveCount(0);

		await openFileTab(page, student, "Table", "data.csv", "a,b\n1,2\n");
		await expect(page.getByTestId("file-view-view-data.csv")).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		await expect(page.getByTestId("file-voice-data.csv")).toHaveCount(0);
		await page.getByTestId("file-view-edit-data.csv").click();
		await expect(page.getByTestId("file-voice-data.csv")).toBeVisible();
	});

	test("a browser without speech recognition shows no microphone on a file", async ({
		page,
		context,
	}) => {
		await noSpeech(page);
		await openFile(page, context);
		await expect(page.getByTestId(`file-voice-${PATH}`)).toHaveCount(0);
	});

	for (const appearance of ["dark", "light"] as const) {
		test(`a file with its microphone passes axe, idle and listening (${appearance})`, async ({
			page,
			context,
		}) => {
			await fakeSpeech(page);
			await openFile(page, context, appearance);
			const idle = await (await settledAxe(page)).withTags(WCAG_TAGS).analyze();
			expect(idle.violations).toEqual([]);

			await page.getByTestId(`file-voice-${PATH}`).hover();
			await page.mouse.down();
			await expect(page.getByTestId(`file-voice-status-${PATH}`)).toHaveText(
				"Listening…",
			);
			const listening = await (await settledAxe(page)).withTags(WCAG_TAGS).analyze();
			await page.mouse.up();
			expect(listening.violations).toEqual([]);
		});
	}
});
