/**
 * Dictation into an open file (SPEC.md §25.10): when the microphone shows,
 * and that a final phrase is typed through the editor's insertText.
 * The editor and the browser's speech recognition are both fakes.
 */
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { type Ref, useImperativeHandle } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { CodeEditorHandle } from "../editor/CodeEditor.js";
import { renderWithQuery } from "../test-utils.js";
import { resetSpeechSupport } from "../voice/useSpeechInput.js";
import { FileLeaf } from "./FileLeaf.js";

const inserted: string[] = [];
let voiceHold: ((held: boolean) => void) | undefined;

vi.mock("../editor/CodeEditor.js", () => ({
	CodeEditor: (props: {
		path: string;
		ref?: Ref<CodeEditorHandle>;
		onVoiceHold?: (held: boolean) => void;
	}) => {
		voiceHold = props.onVoiceHold;
		useImperativeHandle(props.ref, () => ({
			setTopLine: () => {},
			insertText: (text: string) => {
				inserted.push(text);
			},
		}));
		return <div data-testid={`editor-${props.path}`} />;
	},
}));
vi.mock("../editor/MarkdownPreview.js", () => ({ MarkdownPreview: () => null }));

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

let body = "hello";

beforeEach(() => {
	inserted.length = 0;
	voiceHold = undefined;
	recognizer = null;
	body = "hello";
	resetSpeechSupport();
	vi.stubGlobal("SpeechRecognition", FakeRecognition);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			if (String(input) === "/me/settings") {
				return Response.json({ timezones: [] });
			}
			if (String(input).includes("/tree")) {
				return Response.json({ entries: [] });
			}
			return new Response(body, {
				status: 200,
				headers: { "content-type": "text/plain; charset=utf-8", etag: "etag-0" },
			});
		}),
	);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

function renderLeaf(path: string) {
	return renderWithQuery(
		<FileLeaf path={path} workspaceId="ws-1" projectId="p-1" onClose={() => {}} />,
	);
}

test("an editable text file has a microphone, and a final phrase is inserted", async () => {
	renderLeaf("src/app.ts");
	const button = await screen.findByTestId("file-voice-src/app.ts");
	expect(button.getAttribute("aria-label")).toBe("Hold to dictate into app.ts");
	await screen.findByTestId("editor-src/app.ts");
	fireEvent.pointerDown(button, { button: 0, pointerId: 1 });
	expect(recognizer).not.toBeNull();
	act(() => {
		const result = Object.assign([{ transcript: "two words" }], { isFinal: true });
		recognizer?.onresult?.({ resultIndex: 0, results: [result] });
	});
	expect(inserted).toEqual(["two words"]);
});

test("the editor's held shortcut drives the same dictation", async () => {
	renderLeaf("src/app.ts");
	const button = await screen.findByTestId("file-voice-src/app.ts");
	await waitFor(() => expect(voiceHold).toBeDefined());
	act(() => voiceHold?.(true));
	expect(button.getAttribute("aria-pressed")).toBe("true");
	act(() => voiceHold?.(false));
	expect(button.getAttribute("aria-pressed")).toBe("false");
});

test("no microphone in the Diff view", async () => {
	renderLeaf("src/app.ts");
	await screen.findByTestId("file-voice-src/app.ts");
	fireEvent.click(screen.getByTestId("file-view-diff-src/app.ts"));
	await waitFor(() => expect(screen.queryByTestId("file-voice-src/app.ts")).toBeNull());
});

test("no microphone on an image", async () => {
	body = "not really a png";
	renderLeaf("pic.png");
	await screen.findByTestId("file-pane-pic.png");
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
	});
	expect(screen.queryByTestId("file-voice-pic.png")).toBeNull();
});

test("no microphone on a CSV table until its text is shown", async () => {
	body = "a,b\n1,2\n";
	renderLeaf("data.csv");
	await screen.findByTestId("file-view-view-data.csv");
	expect(screen.queryByTestId("file-voice-data.csv")).toBeNull();
	fireEvent.click(screen.getByTestId("file-view-edit-data.csv"));
	await screen.findByTestId("file-voice-data.csv");
});

test("no microphone where the browser has no speech recognition", async () => {
	vi.stubGlobal("SpeechRecognition", undefined);
	renderLeaf("src/app.ts");
	await screen.findByTestId("editor-src/app.ts");
	expect(screen.queryByTestId("file-voice-src/app.ts")).toBeNull();
	expect(voiceHold).toBeUndefined();
});

test("a voice error is shown on the file as well as announced", async () => {
	renderLeaf("src/app.ts");
	const button = await screen.findByTestId("file-voice-src/app.ts");
	fireEvent.pointerDown(button, { button: 0, pointerId: 1 });
	act(() => {
		recognizer?.onerror?.({ error: "not-allowed" });
		recognizer?.onend?.(undefined);
	});
	const message =
		"Microphone access is blocked. Allow it in the browser's site settings.";
	expect(screen.getByTestId("file-voice-error-src/app.ts").textContent).toBe(message);
	expect(screen.getByTestId("file-voice-status-src/app.ts").textContent).toBe(message);
});
