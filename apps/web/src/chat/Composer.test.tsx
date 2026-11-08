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
import type { TiptapEditorHTMLElement } from "@tiptap/core";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { resetSpeechSupport } from "../voice/useSpeechInput.js";
import { Composer } from "./Composer.js";
import { type ChatStore, createChatStore } from "./chatStore.js";
import {
	boxText,
	editorOf,
	placeCursor,
	setText,
	typeInto,
} from "./composerTesting.js";

const saveDroppedFile = vi.hoisted(() => vi.fn());
const deleteFile = vi.hoisted(() => vi.fn());
vi.mock("../files/queries.js", () => ({
	saveDroppedFile,
	useFileMutations: () => ({ remove: { mutate: deleteFile } }),
}));

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
	deleteFile.mockReset();
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

function input(): HTMLElement {
	return screen.getByTestId("chat-composer-input");
}

function type(text: string) {
	setText(input(), text);
}

function value(): string {
	return boxText(input());
}

function file(name: string, type: string, size = 10): File {
	const made = new File(["x"], name, { type });
	Object.defineProperty(made, "size", { value: size });
	return made;
}

function paste(files: File[]) {
	fireEvent.paste(input(), {
		clipboardData: { files, items: [], types: ["Files"], getData: () => "" },
	});
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

test("Enter sends the text and clears the box; Shift+Enter adds a line", () => {
	draw();
	type("Add");
	placeCursor(input(), 3);
	fireEvent.keyDown(input(), { key: "Enter", shiftKey: true });
	typeInto(input(), "a test");
	expect(sent).toEqual([]);
	fireEvent.keyDown(input(), { key: "Enter" });
	expect(sent).toEqual([{ type: "send", text: "Add\na test", attachments: [] }]);
	echo("Add\na test");
	expect(value()).toBe("");
});

test("text typed after sending is kept when the echo arrives", () => {
	draw();
	type("first");
	fireEvent.keyDown(input(), { key: "Enter" });
	type("second");
	echo("first");
	expect(value()).toBe("second");
});

test("an empty message is not sent, and Enter during composition is left alone", () => {
	draw();
	fireEvent.keyDown(input(), { key: "Enter" });
	type("   ");
	fireEvent.keyDown(input(), { key: "Enter" });
	type("日本");
	fireEvent.compositionStart(input());
	fireEvent.keyDown(input(), { key: "Enter", isComposing: true, keyCode: 229 });
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
	expect(value()).toBe("hello");
	accept = true;
	fireEvent.keyDown(input(), { key: "Enter" });
	expect(alert()).toBe("");
	echo("hello");
	expect(value()).toBe("");
});

test("Send and Stop are icon buttons named for what they do", () => {
	draw();
	const send = screen.getByRole("button", { name: "Send" });
	expect(send).toBe(screen.getByTestId("chat-composer-send"));
	expect(send.getAttribute("type")).toBe("submit");
	expect(send.textContent).toBe("");
	expect(send.querySelector("svg")).toBeTruthy();
});

test("while a turn runs, Stop sits beside a Send that still sends, and Stop interrupts", () => {
	draw();
	expect(screen.queryByTestId("chat-composer-stop")).toBeNull();
	emit("turn.started", { at: 0 });
	const send = screen.getByTestId("chat-composer-send");
	expect(send.hasAttribute("aria-disabled")).toBe(false);
	expect(send.hasAttribute("aria-describedby")).toBe(false);
	type("also check the tests");
	fireEvent.click(send);
	expect(sent).toEqual([
		{ type: "send", text: "also check the tests", attachments: [] },
	]);
	fireEvent.click(screen.getByRole("button", { name: "Stop" }));
	expect(sent.at(-1)).toEqual({ type: "interrupt" });
	emit("turn.finished", { at: 1, status: "interrupted" });
	expect(screen.queryByTestId("chat-composer-stop")).toBeNull();
});

test("while a turn runs the foot says Enter sends without stopping, and Esc stops", () => {
	draw();
	const hint = () => screen.getByTestId("chat-composer-hint").textContent;
	expect(hint()).toBe(
		"Enter sends, Shift+Enter adds a line, Up brings back your last message.",
	);
	emit("turn.started", { at: 0 });
	expect(hint()).toBe("Enter sends without stopping Claude. Esc stops it.");
});

test("when Stop ends the turn while it holds the keyboard, the message box takes it", () => {
	draw();
	emit("turn.started", { at: 0 });
	const stop = screen.getByRole("button", { name: "Stop" });
	stop.focus();
	fireEvent.click(stop);
	emit("turn.finished", { at: 1, status: "interrupted" });
	expect(document.activeElement).toBe(input());
});

test("a turn that ends while the keyboard is elsewhere leaves the keyboard alone", () => {
	draw();
	emit("turn.started", { at: 0 });
	const send = screen.getByTestId("chat-composer-send");
	send.focus();
	emit("turn.finished", { at: 1, status: "done" });
	expect(document.activeElement).toBe(send);
});

test("while a sent message waits for the host, Send says why it waits", () => {
	draw();
	type("hi");
	fireEvent.keyDown(input(), { key: "Enter" });
	const send = screen.getByTestId("chat-composer-send");
	expect(send.getAttribute("aria-disabled")).toBe("true");
	expect(
		document.getElementById(send.getAttribute("aria-describedby") ?? "")?.textContent,
	).toBe("Wait for your last message to reach Claude.");
	echo("hi");
	expect(send.hasAttribute("aria-disabled")).toBe(false);
	expect(send.hasAttribute("aria-describedby")).toBe(false);
});

test("entering a code block is announced once, with how to send and how to leave", () => {
	draw();
	typeInto(input(), "```");
	fireEvent.keyDown(input(), { key: "Enter" });
	const announced = status();
	expect(announced).toMatch(
		/^In a code block\. In code, Enter adds a line\. (Ctrl|Cmd)\+Enter sends\. Press Enter three times at the end to leave it\.$/,
	);
	// Leaving empties the region, so the next code block is read out again.
	act(() => {
		(input() as TiptapEditorHTMLElement).editor?.commands.clearContent(true);
	});
	expect(status()).toBe("");
	typeInto(input(), "```");
	fireEvent.keyDown(input(), { key: "Enter" });
	expect(status()).toBe(announced);
});

test("Escape in the box stops a running turn, and does nothing when none runs", () => {
	draw();
	fireEvent.keyDown(input(), { key: "Escape" });
	expect(sent).toEqual([]);
	emit("turn.started", { at: 0 });
	fireEvent.keyDown(input(), { key: "Escape", shiftKey: true });
	expect(sent).toEqual([]);
	fireEvent.keyDown(input(), { key: "Escape" });
	expect(sent).toEqual([{ type: "interrupt" }]);
});

test("Escape leaves an open picker menu to close itself and does not stop the turn", () => {
	draw();
	settings();
	emit("turn.started", { at: 0 });
	const trigger = screen.getAllByRole("button", { expanded: false })[0] as HTMLElement;
	trigger.setAttribute("aria-expanded", "true");
	fireEvent.keyDown(input(), { key: "Escape" });
	expect(sent).toEqual([]);
});

test("Up in an empty box brings back the last message sent, formatting and all", () => {
	draw();
	fireEvent.keyDown(input(), { key: "ArrowUp" });
	expect(value()).toBe("");
	typeInto(input(), "make it **bold**");
	fireEvent.keyDown(input(), { key: "Enter" });
	echo("make it **bold**");
	expect(value()).toBe("");
	fireEvent.keyDown(input(), { key: "ArrowUp" });
	expect(value()).toBe("make it **bold**");
	expect(input().querySelector("strong")?.textContent).toBe("bold");
});

test("Up in a box with text moves the cursor as usual", () => {
	draw();
	type("first");
	fireEvent.keyDown(input(), { key: "Enter" });
	echo("first");
	type("draft");
	fireEvent.keyDown(input(), { key: "ArrowUp" });
	expect(value()).toBe("draft");
});

test("a paste of more than 40 lines is attached as a text file with its line count", async () => {
	draw();
	const log = Array.from({ length: 120 }, (_, at) => `error at line ${at}`).join("\n");
	fireEvent.paste(input(), {
		clipboardData: {
			files: [],
			items: [],
			types: ["text/plain"],
			getData: (kind: string) => (kind === "text/plain" ? log : ""),
		},
	});
	const chip = await screen.findByTestId("composer-chip");
	expect(value()).toBe("");
	expect(chip.textContent).toContain("pasted-text.txt");
	// Said where it went, so nobody pastes it again thinking it was lost.
	await waitFor(() =>
		expect(status()).toBe("Pasted 120 lines, attached as pasted-text.txt."),
	);
	expect(screen.getByTestId("composer-chip-size").textContent).toBe("120 lines");
	const saved = saveDroppedFile.mock.calls[0]?.[3] as File;
	expect(saved.name).toBe("pasted-text.txt");
	expect(saved.type).toBe("text/plain");
	expect(await saved.text()).toBe(log);
	expect(saveDroppedFile.mock.calls[0]?.[2]).toEqual(
		expect.arrayContaining([
			expect.stringMatching(/^\.portikus\/pastes\/.+\/pasted-text\.txt$/),
		]),
	);
	fireEvent.keyDown(input(), { key: "Enter" });
	expect(sent).toEqual([
		{
			type: "send",
			text: "",
			attachments: [{ path: await saveDroppedFile.mock.results[0]?.value }],
		},
	]);
});

test("a long paste sent and pasted again at once is a new file, and the sent one is not deleted", async () => {
	draw();
	const log = Array.from({ length: 60 }, (_, at) => `l${at}`).join("\n");
	const pasteLog = () =>
		fireEvent.paste(input(), {
			clipboardData: {
				files: [],
				items: [],
				types: ["text/plain"],
				getData: (kind: string) => (kind === "text/plain" ? log : ""),
			},
		});
	pasteLog();
	await screen.findByTestId("composer-chip");
	fireEvent.keyDown(input(), { key: "Enter" });
	expect(sent).toHaveLength(1);
	pasteLog();
	await waitFor(() => expect(saveDroppedFile).toHaveBeenCalledTimes(2));
	await waitFor(() => expect(screen.getAllByTestId("composer-chip")).toHaveLength(2));
	expect(deleteFile).not.toHaveBeenCalled();
	expect(value()).toBe("");
});

test("the same long text pasted twice at once goes in the box once, and the first paste's chip and file go", async () => {
	draw();
	const log = Array.from({ length: 60 }, (_, at) => `l${at}`).join("\n");
	const pasteLog = () =>
		fireEvent.paste(input(), {
			clipboardData: {
				files: [],
				items: [],
				types: ["text/plain"],
				getData: (kind: string) => (kind === "text/plain" ? log : ""),
			},
		});
	pasteLog();
	pasteLog();
	await waitFor(() => expect(status()).toBe("Pasted 60 lines inline."));
	expect(screen.queryByTestId("composer-chip")).toBeNull();
	expect(value()).toBe(log);
	expect(saveDroppedFile).toHaveBeenCalledTimes(1);
	expect(deleteFile).toHaveBeenCalledWith(await saveDroppedFile.mock.results[0]?.value);
	fireEvent.keyDown(input(), { key: "Enter" });
	expect(sent).toEqual([{ type: "send", text: log, attachments: [] }]);
});

test("each long paste gets its own file, chip and Remove name", async () => {
	draw();
	const pasteLines = (count: number) =>
		fireEvent.paste(input(), {
			clipboardData: {
				files: [],
				items: [],
				types: ["text/plain"],
				getData: (kind: string) =>
					kind === "text/plain"
						? Array.from({ length: count }, (_, at) => `l${at}`).join("\n")
						: "",
			},
		});
	pasteLines(50);
	await screen.findByTestId("composer-chip");
	pasteLines(60);
	await waitFor(() => expect(screen.getAllByTestId("composer-chip")).toHaveLength(2));
	await waitFor(() =>
		expect(status()).toBe("Pasted 60 lines, attached as pasted-text-2.txt."),
	);
	expect(saveDroppedFile.mock.calls.map((call) => (call[3] as File).name)).toEqual([
		"pasted-text.txt",
		"pasted-text-2.txt",
	]);
	expect(
		screen.getAllByRole("button", { name: /^Remove / }).map((b) => b.ariaLabel),
	).toEqual(["Remove pasted-text.txt", "Remove pasted-text-2.txt"]);
});

test("the microphone sits after the settings, next to Send", async () => {
	draw();
	const mic = await screen.findByTestId(`chat-voice-${TERMINAL}`);
	const send = screen.getByTestId("chat-composer-send");
	expect(mic.parentElement).toBe(send.parentElement);
	const model = screen.getByText("Model");
	expect(
		model.compareDocumentPosition(mic) & Node.DOCUMENT_POSITION_FOLLOWING,
	).toBeTruthy();
});

test("Enter sends a message while a turn runs", () => {
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

test("a message over the contract's limit is not sent, and says how to fix it", () => {
	draw();
	type("x".repeat(100_001));
	fireEvent.keyDown(input(), { key: "Enter" });
	expect(sent).toEqual([]);
	expect(alert()).toBe(
		"Your message was not sent because it is 100,001 characters long, over the limit of 100,000. Shorten it and send again.",
	);
	type("x".repeat(100_000));
	fireEvent.keyDown(input(), { key: "Enter" });
	expect(sent).toHaveLength(1);
});

test("the box is a labelled multi-line text box described by the key hint", () => {
	draw();
	const box = screen.getByRole("textbox", { name: "Message Claude Code" });
	expect(box).toBe(input());
	expect(box.getAttribute("aria-multiline")).toBe("true");
	expect(box.getAttribute("aria-placeholder")).toBe(
		"Message Claude Code, or paste or drop images",
	);
	const hint = (box.getAttribute("aria-describedby") ?? "")
		.split(" ")
		.map((id) => document.getElementById(id)?.textContent)
		.filter(Boolean);
	expect(hint).toEqual([
		"Enter sends, Shift+Enter adds a line, Up brings back your last message.",
	]);
});

test("Markdown typed in the box is sent as the same Markdown text", () => {
	draw();
	typeInto(input(), "Use **bold**, `code` and\n- a list\nof two");
	expect(input().querySelector("strong")).toBeTruthy();
	fireEvent.keyDown(input(), { key: "Enter" });
	expect(sent).toEqual([
		{
			type: "send",
			text: "Use **bold**, `code` and\n\n- a list\n- of two",
			attachments: [],
		},
	]);
	echo("Use **bold**, `code` and\n\n- a list\n- of two");
	expect(value()).toBe("");
});

test("in a code block the hint says Enter adds a line, and Ctrl+Enter sends", () => {
	draw();
	typeInto(input(), "``` ");
	expect(screen.getByTestId("chat-composer-hint").textContent).toMatch(
		/^In code, Enter adds a line\. (Ctrl|Cmd)\+Enter sends\.$/,
	);
	typeInto(input(), "ls");
	fireEvent.keyDown(input(), { key: "Enter" });
	expect(sent).toEqual([]);
	fireEvent.keyDown(input(), { key: "Enter", ctrlKey: true });
	expect(sent).toEqual([{ type: "send", text: "```\nls\n\n```", attachments: [] }]);
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
	placeCursor(input(), 3);
	await hold();
	say("now", true);
	expect(value()).toBe("fix now the bug");
	// The cursor ends after the words, inside the first line.
	expect(editorOf(input()).state.selection.from).toBe(1 + "fix now".length);
	say("please", true);
	expect(value()).toBe("fix now please the bug");
	expect(sent).toEqual([]);
});

test("dictation shows interim words in the box without typing them, and starts after nothing with no space", async () => {
	draw();
	await hold();
	say("hel", false);
	const shown = screen.getByTestId("chat-voice-interim");
	expect(shown.textContent).toBe("hel");
	expect(input().contains(shown)).toBe(true);
	expect(value()).toBe("");
	say("hello", true);
	expect(value()).toBe("hello");
	expect(screen.queryByTestId("chat-voice-interim")).toBeNull();
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
	expect(value()).toBe("spoken");
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
	expect(
		screen.getByText(
			"Enter sends, Shift+Enter adds a line, Up brings back your last message.",
		),
	).toBeTruthy();
	settings({ mode: "bypassPermissions" });
	expect(screen.getByTestId("chat-bypass-warning").textContent).toMatch(
		/without asking/,
	);
	// The warning takes the hint's line, so the box above does not move.
	expect(
		screen.queryByText(
			"Enter sends, Shift+Enter adds a line, Up brings back your last message.",
		),
	).toBeNull();
	settings({ mode: "default" });
	expect(screen.queryByTestId("chat-bypass-warning")).toBeNull();
});
