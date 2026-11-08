import {
	EDITOR_SETTINGS_DEFAULTS,
	MAX_CHAT_ATTACHMENTS,
	MAX_CHAT_IMAGE_BYTES,
} from "@portikus/contracts";
import { ToastProvider } from "@portikus/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { resetSpeechSupport } from "../voice/useSpeechInput.js";
import { Composer } from "./Composer.js";
import { type ChatStore, createChatStore } from "./chatStore.js";

const saveDroppedFile = vi.hoisted(() => vi.fn());
vi.mock("../files/queries.js", () => ({ saveDroppedFile }));

const TERMINAL = "11111111-1111-4111-8111-111111111111";

let sent: unknown[];
let accept: boolean;
let store: ChatStore;
let seq: number;

type Handler = ((event: unknown) => void) | null;
let recognizer: { onresult: Handler; onerror: Handler; onend: Handler } | null = null;
class FakeRecognition {
	continuous = false;
	interimResults = false;
	lang = "";
	onresult: Handler = null;
	onerror: Handler = null;
	onend: Handler = null;
	start() {
		recognizer = this;
	}
	stop() {}
	abort() {}
}

function emit(type: string, body: Record<string, unknown> = {}) {
	act(() => {
		store
			.getState()
			.receive(JSON.stringify({ type, sessionId: TERMINAL, seq: seq++, ...body }));
	});
}

function settings(body: Record<string, unknown> = {}) {
	emit("settings", {
		agent: "claude",
		model: "claude-sonnet-4-5",
		effort: "medium",
		mode: "default",
		...body,
	});
}

beforeEach(() => {
	sent = [];
	accept = true;
	seq = 0;
	recognizer = null;
	resetSpeechSupport();
	store = createChatStore((message) => {
		sent.push(message);
		return accept;
	});
	emit("snapshot", { cards: [], turnRunning: false, truncated: false });
	saveDroppedFile.mockImplementation(
		async (_w: string, _p: string, paths: string[]) => paths[0],
	);
	vi.stubGlobal("SpeechRecognition", FakeRecognition);
	vi.stubGlobal(
		"URL",
		Object.assign(URL, { createObjectURL: () => "blob:x", revokeObjectURL: () => {} }),
	);
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Response.json({ ...EDITOR_SETTINGS_DEFAULTS, timezones: [] })),
	);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	saveDroppedFile.mockReset();
});

function draw() {
	render(
		<QueryClientProvider
			client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
		>
			<ToastProvider>
				<Composer store={store} workspaceId="w" projectId="p" terminalId={TERMINAL} />
			</ToastProvider>
		</QueryClientProvider>,
	);
}

function input(): HTMLTextAreaElement {
	return screen.getByTestId("chat-composer-input") as HTMLTextAreaElement;
}

function type(text: string) {
	fireEvent.change(input(), { target: { value: text } });
}

function file(name: string, type: string, size = 10): File {
	const made = new File(["x"], name, { type });
	Object.defineProperty(made, "size", { value: size });
	return made;
}

function paste(files: File[]) {
	fireEvent.paste(input(), { clipboardData: { files, items: [], types: ["Files"] } });
}

/** The host's echo of the student's message, which ends the send. */
function echo(text: string) {
	emit("message", { id: `u-${seq}`, role: "user", markdown: text });
}

function status(): string {
	return screen.getByTestId("chat-composer-status").textContent ?? "";
}

function alert(): string {
	return screen.getByTestId("chat-composer-error").textContent ?? "";
}

test("Enter sends the text and clears the box; Shift+Enter does not send", () => {
	draw();
	type("Add a test");
	fireEvent.keyDown(input(), { key: "Enter", shiftKey: true });
	expect(sent).toEqual([]);
	fireEvent.keyDown(input(), { key: "Enter" });
	expect(sent).toEqual([{ type: "send", text: "Add a test", attachments: [] }]);
	echo("Add a test");
	expect(input().value).toBe("");
});

test("text typed after sending is kept when the echo arrives", () => {
	draw();
	type("first");
	fireEvent.keyDown(input(), { key: "Enter" });
	type("second");
	echo("first");
	expect(input().value).toBe("second");
});

test("an empty message is not sent, and Enter during composition is left alone", () => {
	draw();
	fireEvent.keyDown(input(), { key: "Enter" });
	type("   ");
	fireEvent.keyDown(input(), { key: "Enter" });
	type("日本");
	fireEvent.keyDown(input(), { key: "Enter", isComposing: true });
	expect(sent).toEqual([]);
});

test("the Send button sends", () => {
	draw();
	type("hi");
	fireEvent.click(screen.getByTestId("chat-composer-send"));
	expect(sent).toEqual([{ type: "send", text: "hi", attachments: [] }]);
});

test("text that could not be sent stays in the box with the not-sent message", () => {
	accept = false;
	draw();
	type("hello");
	fireEvent.keyDown(input(), { key: "Enter" });
	expect(alert()).toMatch(/was not sent/);
	expect(input().value).toBe("hello");
	accept = true;
	fireEvent.keyDown(input(), { key: "Enter" });
	expect(alert()).toBe("");
	echo("hello");
	expect(input().value).toBe("");
});

test("while a turn runs, Send becomes Stop and Stop interrupts", () => {
	draw();
	expect(screen.queryByTestId("chat-composer-stop")).toBeNull();
	emit("turn.started", { at: 0 });
	expect(screen.queryByTestId("chat-composer-send")).toBeNull();
	fireEvent.click(screen.getByTestId("chat-composer-stop"));
	expect(sent).toEqual([{ type: "interrupt" }]);
	emit("turn.finished", { at: 1, status: "interrupted" });
	expect(screen.getByTestId("chat-composer-send")).toBeTruthy();
});

test("Enter still queues a message while a turn runs", () => {
	draw();
	emit("turn.started", { at: 0 });
	type("next");
	fireEvent.keyDown(input(), { key: "Enter" });
	expect(sent).toEqual([{ type: "send", text: "next", attachments: [] }]);
});

test("a pasted picture is saved, shown as a removable chip, and sent as a path", async () => {
	draw();
	paste([file("image.png", "image/png")]);
	const chip = await screen.findByTestId("composer-chip");
	expect(chip.querySelector("img")).toBeTruthy();
	expect(saveDroppedFile).toHaveBeenCalledWith(
		"w",
		"p",
		expect.arrayContaining([
			expect.stringMatching(/^\.portikus\/pastes\/.+\/image\.png$/),
		]),
		expect.any(File),
	);
	expect(status()).toBe("Attached 1 file.");
	const path = saveDroppedFile.mock.results[0]?.value;
	fireEvent.keyDown(input(), { key: "Enter" });
	expect(sent).toEqual([
		{ type: "send", text: "", attachments: [{ path: await path }] },
	]);
	// The chip stays until the host has the message.
	expect(screen.getByTestId("composer-chip")).toBeTruthy();
	echo("");
	expect(screen.queryByTestId("composer-chip")).toBeNull();
});

test("a nameless pasted picture gets a name", async () => {
	draw();
	paste([file("", "image/png")]);
	await screen.findByTestId("composer-chip");
	const saved = saveDroppedFile.mock.calls[0]?.[3] as File;
	expect(saved.name).toBe("pasted.png");
});

test("pasting plain text is left to the browser", () => {
	draw();
	paste([]);
	expect(saveDroppedFile).not.toHaveBeenCalled();
});

test("a dropped file is saved, and a drag without files does nothing", async () => {
	draw();
	const form = screen.getByTestId("chat-composer");
	fireEvent.dragOver(form, { dataTransfer: { types: ["text/plain"] } });
	expect(form.className).not.toContain("is-dragging");
	fireEvent.dragOver(form, { dataTransfer: { types: ["Files"] } });
	expect(form.className).toContain("is-dragging");
	fireEvent.dragLeave(form, { relatedTarget: document.body });
	expect(form.className).not.toContain("is-dragging");
	fireEvent.drop(form, {
		dataTransfer: { types: ["Files"], files: [file("notes.pdf", "application/pdf")] },
	});
	const chip = await screen.findByTestId("composer-chip");
	// Other files are sent as paths, with no thumbnail.
	expect(chip.querySelector("img")).toBeNull();
	expect(chip.textContent).toContain("notes.pdf");
});

test("a drop that is not files is ignored", () => {
	draw();
	fireEvent.drop(screen.getByTestId("chat-composer"), {
		dataTransfer: { types: ["text/plain"], files: [] },
	});
	expect(saveDroppedFile).not.toHaveBeenCalled();
});

test("the attach button opens the picker and chosen files become chips", async () => {
	draw();
	const picker = screen.getByTestId("chat-composer-file") as HTMLInputElement;
	const click = vi.spyOn(picker, "click");
	fireEvent.click(screen.getByTestId("chat-composer-attach"));
	expect(click).toHaveBeenCalled();
	fireEvent.change(picker, { target: { files: [file("a.png", "image/png")] } });
	expect(await screen.findByTestId("composer-chip")).toBeTruthy();
});

test("removing a chip leaves it out of the message", async () => {
	draw();
	paste([file("a.png", "image/png")]);
	await screen.findByTestId("composer-chip");
	fireEvent.click(screen.getByRole("button", { name: "Remove a.png" }));
	expect(screen.queryByTestId("composer-chip")).toBeNull();
	type("hi");
	fireEvent.keyDown(input(), { key: "Enter" });
	expect(sent).toEqual([{ type: "send", text: "hi", attachments: [] }]);
});

test("a picture that cannot be made small enough is refused with a reason", async () => {
	draw();
	paste([file("big.gif", "image/gif", MAX_CHAT_IMAGE_BYTES + 1)]);
	await waitFor(() => expect(alert()).toMatch(/big\.gif is over 5 MB/));
	expect(saveDroppedFile).not.toHaveBeenCalled();
});

test("an SVG is refused, by type or by name", () => {
	draw();
	paste([file("logo.svg", "image/svg+xml")]);
	expect(alert()).toMatch(/SVG/);
	paste([file("logo.SVG", "")]);
	expect(alert()).toMatch(/SVG/);
	expect(saveDroppedFile).not.toHaveBeenCalled();
});

test("a file with an unusable name is refused", () => {
	draw();
	paste([file("a/b.png", "image/png")]);
	expect(alert()).not.toBe("");
	expect(saveDroppedFile).not.toHaveBeenCalled();
});

test("a file over the upload cap is refused", async () => {
	draw();
	paste([file("huge.zip", "application/zip", 1024 * 1024 * 1024)]);
	await waitFor(() => expect(alert()).toMatch(/too large/));
});

test("removing a chip moves the keyboard to the next one, then the one before, then the box", async () => {
	draw();
	paste([
		file("a.png", "image/png"),
		file("b.png", "image/png"),
		file("c.png", "image/png"),
	]);
	await waitFor(() => expect(screen.getAllByTestId("composer-chip")).toHaveLength(3));
	fireEvent.click(screen.getByRole("button", { name: "Remove a.png" }));
	expect(document.activeElement).toBe(
		screen.getByRole("button", { name: "Remove b.png" }),
	);
	expect(status()).toBe("Removed a.png.");
	fireEvent.click(screen.getByRole("button", { name: "Remove c.png" }));
	expect(document.activeElement).toBe(
		screen.getByRole("button", { name: "Remove b.png" }),
	);
	fireEvent.click(screen.getByRole("button", { name: "Remove b.png" }));
	expect(document.activeElement).toBe(input());
});

test("an eleventh attachment is refused", async () => {
	draw();
	paste(
		Array.from({ length: MAX_CHAT_ATTACHMENTS }, (_, i) =>
			file(`f${i}.png`, "image/png"),
		),
	);
	await waitFor(() => expect(screen.getAllByTestId("composer-chip")).toHaveLength(10));
	paste([file("one-more.png", "image/png")]);
	expect(alert()).toMatch(/10 files/);
	expect(screen.getAllByTestId("composer-chip")).toHaveLength(10);
	expect(saveDroppedFile).toHaveBeenCalledTimes(10);
	// Removing one makes room again.
	fireEvent.click(screen.getByRole("button", { name: "Remove f0.png" }));
	paste([file("one-more.png", "image/png")]);
	await waitFor(() => expect(screen.getAllByTestId("composer-chip")).toHaveLength(10));
});

test("a failed save is a toast, frees the slot, and keeps earlier chips", async () => {
	saveDroppedFile
		.mockImplementationOnce(async (_w: string, _p: string, paths: string[]) => paths[0])
		.mockRejectedValueOnce(new Error("disk full"));
	draw();
	paste([
		file("a.png", "image/png"),
		file("b.png", "image/png"),
		file("c.png", "image/png"),
	]);
	await screen.findByTestId("composer-chip");
	await waitFor(() => expect(screen.queryByTestId("composer-saving")).toBeNull());
	expect(screen.getAllByTestId("composer-chip")).toHaveLength(1);
	expect(saveDroppedFile).toHaveBeenCalledTimes(2);
	expect(await screen.findByText(/Something went wrong|failed|wrong/i)).toBeTruthy();
});

test("Send waits while files are still being saved", async () => {
	let finish: (path: string) => void = () => {};
	saveDroppedFile.mockImplementationOnce(
		() => new Promise<string>((resolve) => (finish = resolve)),
	);
	draw();
	type("look");
	paste([file("a.png", "image/png")]);
	expect(await screen.findByTestId("composer-saving")).toBeTruthy();
	// Still focusable, and says why it waits.
	const send = screen.getByTestId("chat-composer-send");
	expect(send.getAttribute("aria-disabled")).toBe("true");
	expect(
		document.getElementById(send.getAttribute("aria-describedby") ?? "")?.textContent,
	).toBe("Wait for the files to finish saving.");
	expect(status()).toBe("Attaching 1 file…");
	fireEvent.keyDown(input(), { key: "Enter" });
	expect(sent).toEqual([]);
	await act(async () => finish(".portikus/pastes/s/a.png"));
	fireEvent.keyDown(input(), { key: "Enter" });
	expect(sent).toEqual([
		{ type: "send", text: "look", attachments: [{ path: ".portikus/pastes/s/a.png" }] },
	]);
});

test("the box stops at the longest prompt the contract allows", () => {
	draw();
	expect(input().maxLength).toBe(100_000);
});

async function hold() {
	const mic = await screen.findByTestId(`chat-voice-${TERMINAL}`);
	fireEvent.pointerDown(mic, { button: 0, pointerId: 1 });
	return mic;
}

function say(text: string, isFinal: boolean) {
	act(() => {
		const result = Object.assign([{ transcript: text }], { isFinal });
		recognizer?.onresult?.({ resultIndex: 0, results: [result] });
	});
}

test("dictation is inserted at the cursor and is never sent", async () => {
	draw();
	type("fix the bug");
	input().setSelectionRange(3, 3);
	await hold();
	say("now", true);
	expect(input().value).toBe("fix now the bug");
	expect(input().selectionStart).toBe("fix now".length);
	say("please", true);
	expect(input().value).toBe("fix now please the bug");
	expect(sent).toEqual([]);
});

test("dictation shows interim words without typing them, and starts after nothing with no space", async () => {
	draw();
	await hold();
	say("hel", false);
	expect(screen.getByTestId("chat-voice-interim").textContent).toBe("hel");
	expect(input().value).toBe("");
	say("hello", true);
	expect(input().value).toBe("hello");
	expect(sent).toEqual([]);
});

test("Alt+Shift+M held in the box listens, and releasing stops", async () => {
	draw();
	await screen.findByTestId(`chat-voice-${TERMINAL}`);
	fireEvent.keyDown(input(), { key: "M", code: "KeyM", altKey: true, shiftKey: true });
	expect(recognizer).not.toBeNull();
	fireEvent.keyDown(input(), {
		key: "M",
		code: "KeyM",
		altKey: true,
		shiftKey: true,
		repeat: true,
	});
	say("spoken", true);
	expect(input().value).toBe("spoken");
	fireEvent.keyUp(input(), { key: "M", code: "KeyM" });
	await waitFor(() =>
		expect(
			screen.getByTestId(`chat-voice-${TERMINAL}`).getAttribute("aria-pressed"),
		).toBe("false"),
	);
});

test("without speech recognition there is no microphone", async () => {
	vi.stubGlobal("SpeechRecognition", undefined);
	resetSpeechSupport();
	draw();
	await waitFor(() =>
		expect(screen.queryByTestId(`chat-voice-${TERMINAL}`)).toBeNull(),
	);
});

test("the bypass warning shows only while Bypass is the host's mode", () => {
	draw();
	expect(screen.getByText("Enter sends. Shift+Enter adds a line.")).toBeTruthy();
	settings({ mode: "bypassPermissions" });
	expect(screen.getByTestId("chat-bypass-warning").textContent).toMatch(
		/without asking/,
	);
	// The warning takes the hint's line, so the box above does not move.
	expect(screen.queryByText("Enter sends. Shift+Enter adds a line.")).toBeNull();
	settings({ mode: "default" });
	expect(screen.queryByTestId("chat-bypass-warning")).toBeNull();
});
