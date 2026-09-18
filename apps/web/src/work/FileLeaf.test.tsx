/**
 * The file tab's state machine: autosave, external refresh, conflicts and
 * the viewer flow (SPEC.md §13.2, §13.3, §13.5). Monaco itself is replaced
 * by a fake, so these tests are about the states, not about rendering text.
 */

import { EDITOR_SETTINGS_DEFAULTS, type EditorSettings } from "@portikus/contracts";
import type { QueryClient } from "@tanstack/react-query";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { FileContent } from "../files/queries.js";
import {
	createLayoutStore,
	type LayoutStore,
	LayoutStoreContext,
} from "../layout/store.js";
import { renderWithQuery } from "../test-utils.js";
import { FileLeaf } from "./FileLeaf.js";

/** The smallest Monaco that CodeEditor.tsx can drive. */
class FakeModel {
	listeners: (() => void)[] = [];
	constructor(public value: string) {}
	getValue() {
		return this.value;
	}
	/** The conflict diff listens for the student's keystrokes this way. */
	onDidChangeContent(listener: () => void) {
		this.listeners.push(listener);
	}
	getFullModelRange() {
		return { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 };
	}
	/** The editor refreshes with applyEdits, which does not touch undo. */
	applyEdits(edits: { text: string }[]) {
		this.value = edits[0]?.text ?? "";
		for (const listener of this.listeners) listener();
	}
	/** Monaco really does drop the model and its listeners; so does this. */
	dispose() {
		this.listeners = [];
		this.disposed = true;
	}
	disposed = false;
}

const state: {
	model: FakeModel | null;
	/** The options the editor was created with, and every later change. */
	created: Record<string, unknown> | null;
	updates: Record<string, unknown>[];
	/** The names the editor gave its models, newest last. */
	uris: string[];
} = { model: null, created: null, updates: [], uris: [] };
/** The two sides of the conflict diff, once it has been created. */
const diffState: { models: { original: FakeModel; modified: FakeModel } | null } = {
	models: null,
};
/** Where the editor was told to put the cursor, and what it scrolled to. */
const cursorLines: number[] = [];
const revealedLines: number[] = [];
/** The view states the editor was asked to put back (issue #161). */
const restoredViewStates: unknown[] = [];
/** Reports a cursor move the way Monaco would. */
let moveCursor: (() => void) | null = null;

vi.mock("../editor/features.js", () => ({ loadEditorFeatures: async () => {} }));
vi.mock("monaco-editor/basic-languages/monaco.contribution.js", () => ({}));
vi.mock("monaco-editor/language/json/monaco.contribution.js", () => ({
	jsonDefaults: { setDiagnosticsOptions: () => {} },
}));
vi.mock("monaco-editor/editor/editor.api.js", () => {
	const models = new Map<string, FakeModel>();
	return {
		Uri: { parse: (value: string) => ({ toString: () => value, value }) },
		// The zoom shortcuts are registered with these; the numbers only have
		// to combine without colliding.
		KeyMod: { CtrlCmd: 1, Shift: 2 },
		KeyCode: { Equal: 4, Minus: 8, Digit0: 16 },
		languages: {
			getLanguages: () => [{ id: "typescript", extensions: [".ts"] }],
			json: { jsonDefaults: { setDiagnosticsOptions: () => {} } },
		},
		editor: {
			defineTheme: () => {},
			setTheme: () => {},
			setModelLanguage: () => {},
			getModel: (uri: { value: string }) => {
				const held = models.get(uri.value);
				return held && !held.disposed ? held : null;
			},
			createModel: (value: string, _language: string, uri?: { value: string }) => {
				const model = new FakeModel(value);
				// Only the file editor names its models; the diff editor's two
				// models are nobody else's to find.
				if (uri) {
					models.set(uri.value, model);
					state.uris.push(uri.value);
					state.model = model;
				}
				return model;
			},
			createDiffEditor: () => ({
				setModel: (sides: { original: FakeModel; modified: FakeModel }) => {
					diffState.models = sides;
				},
				saveViewState: () => null,
				restoreViewState: () => {},
				dispose: () => {},
			}),
			create: (
				_host: HTMLElement,
				options: { model: FakeModel } & Record<string, unknown>,
			) => {
				state.model = options.model;
				state.created = options;
				let position = 1;
				return {
					onDidChangeModelContent: (listener: () => void) => {
						options.model.listeners.push(listener);
					},
					onDidChangeCursorPosition: (listener: () => void) => {
						moveCursor = () => {
							position += 1;
							listener();
						};
					},
					// Nothing scrolls in jsdom, so the scroll hooks the split
					// view uses (issue #154) only have to exist and answer.
					onDidScrollChange: () => {},
					onDidLayoutChange: () => {},
					getScrollTop: () => 0,
					getScrollHeight: () => 0,
					setScrollTop: () => {},
					// jsdom has no layout, so the fake editor claims a size.
					getLayoutInfo: () => ({ width: 800, height: 600 }),
					saveViewState: () => ({ line: position }),
					restoreViewState: (viewState: unknown) => {
						restoredViewStates.push(viewState);
					},
					setPosition: (position: { lineNumber: number }) => {
						cursorLines.push(position.lineNumber);
					},
					revealLineInCenter: (line: number) => {
						revealedLines.push(line);
					},
					focus: () => {},
					addCommand: () => {},
					updateOptions: (options: Record<string, unknown>) => {
						state.updates.push(options);
					},
					dispose: () => {},
				};
			},
		},
	};
});

/** Type in the editor the way Monaco would report it. */
function type(text: string) {
	const model = state.model;
	if (!model) throw new Error("the editor was never created");
	act(() => {
		model.value = text;
		for (const listener of model.listeners) listener();
	});
}

/** Type on the right-hand side of the conflict diff. */
function typeInConflict(text: string) {
	const model = diffState.models?.modified;
	if (!model) throw new Error("the conflict diff was never created");
	act(() => {
		model.value = text;
		for (const listener of model.listeners) listener();
	});
}

const WORKSPACE = "ws-1";
const PROJECT = "p-1";
const PATH = "src/app.ts";

interface Seed {
	text: string;
	etag: string;
	contentType?: string;
	status?: number;
	/** The server answers a read without an etag header. */
	noEtag?: boolean;
	/** The server answers a write without an etag in the body. */
	noWriteEtag?: boolean;
}

interface Write {
	method: string;
	ifMatch: string | null;
	ifNoneMatch: string | null;
	body: string;
	keepalive: boolean;
}

const requests: Write[] = [];
/** What GET /me/settings answers in this test (issue #159). */
let settings: EditorSettings;
let seed: Seed;
/** When set, every PUT waits for this to be resolved before it answers. */
let gate: { promise: Promise<void>; open: () => void } | null = null;

function holdWrites() {
	let open = () => {};
	const promise = new Promise<void>((resolve) => {
		open = () => resolve();
	});
	gate = { promise, open };
	return () => act(async () => gate?.open());
}

function stubServer() {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const method = init?.method ?? "GET";
			// The tab reads the student's editor settings (issue #159). These
			// tests use a one second delay, so a debounce is quick to wait for.
			if (String(input) === "/me/settings") {
				return new Response(JSON.stringify(settings), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}
			if (method === "GET") {
				if (seed.status && seed.status !== 200) {
					return new Response(
						JSON.stringify({ error: { code: "OOPS", message: "no" } }),
						{ status: seed.status, headers: { "content-type": "application/json" } },
					);
				}
				const headers: Record<string, string> = {
					"content-type": seed.contentType ?? "text/plain; charset=utf-8",
					"content-length": String(seed.text.length),
				};
				if (!seed.noEtag) headers.etag = seed.etag;
				return new Response(seed.text, { status: 200, headers });
			}
			const headers = new Headers(init?.headers);
			const body = String(init?.body ?? "");
			requests.push({
				method,
				ifMatch: headers.get("if-match"),
				ifNoneMatch: headers.get("if-none-match"),
				body,
				keepalive: init?.keepalive === true,
			});
			const creating = headers.get("if-none-match") === "*";
			if (!creating && headers.get("if-match") !== seed.etag) {
				if (gate) await gate.promise;
				return new Response(
					JSON.stringify({ error: { code: "FILE_CHANGED", message: "changed" } }),
					{ status: 412, headers: { etag: seed.etag } },
				);
			}
			// The disk changes as soon as the write arrives; only the answer is
			// held back, the way a slow response really behaves.
			seed = { ...seed, status: 200, text: body, etag: `etag-${requests.length}` };
			const payload = seed.noWriteEtag
				? { size: body.length }
				: { etag: seed.etag, size: body.length };
			const savedEtag = seed.etag;
			if (gate) await gate.promise;
			return new Response(JSON.stringify(payload), {
				status: 200,
				headers: { "content-type": "application/json", etag: savedEtag },
			});
		}),
	);
}

beforeEach(() => {
	requests.length = 0;
	cursorLines.length = 0;
	revealedLines.length = 0;
	state.model = null;
	state.created = null;
	state.updates.length = 0;
	state.uris.length = 0;
	diffState.models = null;
	gate = null;
	restoredViewStates.length = 0;
	moveCursor = null;
	settings = { ...EDITOR_SETTINGS_DEFAULTS, autoSaveDelaySeconds: 1 };
	seed = { text: "hello", etag: "etag-0" };
	stubServer();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

function renderLeaf(onClose = () => {}, path = PATH) {
	return renderWithQuery(
		<FileLeaf
			path={path}
			workspaceId={WORKSPACE}
			projectId={PROJECT}
			onClose={onClose}
		/>,
	);
}

/** The same tab, but inside a layout store that can remember its cursor. */
function renderLeafWithStore(store: LayoutStore, path = PATH) {
	return renderWithQuery(
		<LayoutStoreContext.Provider value={store}>
			<FileLeaf
				path={path}
				workspaceId={WORKSPACE}
				projectId={PROJECT}
				onClose={() => {}}
			/>
		</LayoutStoreContext.Provider>,
	);
}

/**
 * Monaco loads after the first render, so the host element appears before
 * the model exists. Waiting for the element alone raced on a busy machine.
 */
async function findEditor(path = PATH): Promise<HTMLElement> {
	const host = await screen.findByTestId(`editor-${path}`);
	await waitFor(() => expect(state.model).not.toBeNull());
	return host;
}

/** Let a refetch the socket asked for land and be rendered. */
async function settle(client: QueryClient) {
	await waitFor(
		() =>
			expect(
				(client.getQueryData(["file", WORKSPACE, PROJECT, PATH]) as FileContent).etag,
			).not.toBe("etag-0"),
		{ timeout: 8000 },
	);
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
	});
}

function status() {
	return screen.getByTestId(`file-status-${PATH}`);
}

test("the file loads into the editor and shows Saved", async () => {
	renderLeaf();
	await findEditor();
	expect(state.model?.getValue()).toBe("hello");
	expect(status().textContent).toBe("Saved");
});

test("typing autosaves with the etag it was read at", async () => {
	renderLeaf();
	await findEditor();
	type("hello world");
	expect(status().textContent).toBe("Unsaved");
	await waitFor(() => expect(requests).toHaveLength(1), { timeout: 3000 });
	expect(requests[0]).toMatchObject({
		method: "PUT",
		ifMatch: "etag-0",
		body: "hello world",
	});
	await waitFor(() => expect(status().textContent).toBe("Saved"));
});

test("Ctrl+S saves at once instead of waiting for the debounce", async () => {
	renderLeaf();
	const host = await findEditor();
	type("saved by hand");
	const event = new KeyboardEvent("keydown", {
		key: "s",
		ctrlKey: true,
		bubbles: true,
		cancelable: true,
	});
	host.dispatchEvent(event);
	// The browser's own save dialog must not open (SPEC.md §13.5).
	expect(event.defaultPrevented).toBe(true);
	await waitFor(() => expect(requests).toHaveLength(1));
	expect(requests[0]).toMatchObject({ ifMatch: "etag-0", body: "saved by hand" });
});

test("typing while a save is in flight leaves the file unsaved", async () => {
	const release = holdWrites();
	renderLeaf();
	await findEditor();
	type("first");
	await waitFor(() => expect(requests).toHaveLength(1), { timeout: 3000 });
	// The student keeps typing while that write is still in the air.
	type("first and second");
	await release();

	// The save only covers what it sent, so the newer keystrokes are unsaved
	// and get their own write.
	expect(status().textContent).not.toBe("Saved");
	await waitFor(() => expect(requests).toHaveLength(2), { timeout: 3000 });
	expect(requests[1]?.body).toBe("first and second");
	await waitFor(() => expect(status().textContent).toBe("Saved"), { timeout: 3000 });
	expect(screen.queryByTestId("file-conflict")).toBeNull();
});

test("only one save is in flight at a time, so no false conflict", async () => {
	const release = holdWrites();
	renderLeaf();
	await findEditor();
	type("one");
	await waitFor(() => expect(requests).toHaveLength(1), { timeout: 3000 });
	type("one two");
	// A second write would carry the etag the first is about to replace.
	await new Promise((resolve) => setTimeout(resolve, 1200));
	expect(requests).toHaveLength(1);

	await release();
	await waitFor(() => expect(requests).toHaveLength(2), { timeout: 3000 });
	// The queued save used the etag the first write returned.
	expect(requests[1]?.ifMatch).toBe("etag-1");
	await waitFor(() => expect(status().textContent).toBe("Saved"), { timeout: 3000 });
});

test("a refetch of the editor's own write is not a conflict (issue #157)", async () => {
	const release = holdWrites();
	const client = renderLeaf();
	await findEditor();
	type("hello world");
	await waitFor(() => expect(requests).toHaveLength(1), { timeout: 3000 });

	// The project events socket sees the editor's own write and refetches the
	// file before the write's own response has come back.
	void client.invalidateQueries();
	await settle(client);
	expect(screen.queryByTestId("file-conflict")).toBeNull();

	await release();
	await waitFor(() => expect(status().textContent).toBe("Saved"), { timeout: 3000 });
	expect(screen.queryByTestId("file-conflict")).toBeNull();
});

test("a refetch after a finished save is not a conflict either", async () => {
	const client = renderLeaf();
	await findEditor();
	type("hello world");
	await waitFor(() => expect(status().textContent).toBe("Saved"), { timeout: 3000 });
	type("hello world again");
	void client.invalidateQueries();
	await settle(client);

	expect(screen.queryByTestId("file-conflict")).toBeNull();
	await waitFor(() => expect(status().textContent).toBe("Saved"), { timeout: 3000 });
	expect(requests.at(-1)?.body).toBe("hello world again");
});

test("someone else's text on disk while there are local edits is a conflict", async () => {
	const client = renderLeaf();
	await findEditor();
	type("mine");
	seed = { text: "theirs", etag: "etag-other" };
	void client.invalidateQueries();

	await screen.findByTestId("file-conflict", undefined, { timeout: 8000 });
	expect(state.model?.getValue()).toBe("mine");
});

test("unmounting mid-debounce flushes the pending write", async () => {
	renderLeaf();
	await findEditor();
	type("half typed");
	expect(requests).toHaveLength(0);
	act(() => cleanup());

	expect(requests).toHaveLength(1);
	expect(requests[0]).toMatchObject({
		method: "PUT",
		ifMatch: "etag-0",
		body: "half typed",
		keepalive: true,
	});
});

test("a stale write is a conflict, and Keep mine writes over the new version", async () => {
	renderLeaf();
	await findEditor();
	type("mine");
	// Someone else writes the file before the debounce fires.
	seed = { text: "theirs", etag: "etag-other" };
	await screen.findByTestId("file-conflict", undefined, { timeout: 3000 });
	expect(status().textContent).toBe("Conflict");
	expect(state.model?.getValue()).toBe("mine");

	screen.getByTestId("keep-mine").click();
	await waitFor(() => expect(status().textContent).toBe("Saved"), { timeout: 3000 });
	const last = requests.at(-1);
	expect(last).toMatchObject({ ifMatch: "etag-other", body: "mine" });
});

test("an unresolved conflict does not autosave", async () => {
	renderLeaf();
	await findEditor();
	type("mine");
	seed = { text: "theirs", etag: "etag-other" };
	await screen.findByTestId("file-conflict", undefined, { timeout: 3000 });
	const sent = requests.length;

	type("mine, edited again");
	await new Promise((resolve) => setTimeout(resolve, 1200));
	expect(requests).toHaveLength(sent);
	expect(status().textContent).toBe("Conflict");
});

test("Take disk replaces the local text with the file on disk", async () => {
	renderLeaf();
	await findEditor();
	type("mine");
	seed = { text: "theirs", etag: "etag-other" };
	await screen.findByTestId("file-conflict", undefined, { timeout: 3000 });

	screen.getByTestId("take-disk").click();
	await waitFor(() => expect(state.model?.getValue()).toBe("theirs"));
	expect(screen.queryByTestId("file-conflict")).toBeNull();
	expect(status().textContent).toBe("Saved");
});

test("an external change with no local edits refreshes the editor silently", async () => {
	const client = renderLeaf();
	await findEditor();
	seed = { text: "from the agent", etag: "etag-agent" };
	// The project events socket refetches the file when it changes on disk
	// (SPEC.md §11.4, §13.3).
	void client.invalidateQueries();
	await waitFor(() => expect(state.model?.getValue()).toBe("from the agent"), {
		timeout: 8000,
	});
	expect(status().textContent).toBe("Saved");
	expect(requests).toHaveLength(0);
}, 12_000);

test("a file deleted while it is open keeps the editor and recreates it", async () => {
	const client = renderLeaf();
	await findEditor();
	seed = { ...seed, status: 404 };
	void client.invalidateQueries();

	const banner = await screen.findByTestId("file-banner", undefined, { timeout: 8000 });
	expect(banner.textContent).toBe(
		"This file was deleted on disk. Save to recreate it.",
	);
	// The text is still there to save.
	expect(state.model?.getValue()).toBe("hello");

	type("hello again");
	await waitFor(() => expect(requests).toHaveLength(1), { timeout: 3000 });
	expect(requests[0]).toMatchObject({ ifNoneMatch: "*", ifMatch: null });
	await waitFor(() => expect(status().textContent).toBe("Saved"), { timeout: 3000 });
}, 12_000);

test("a read that fails after loading keeps the editor and warns", async () => {
	const client = renderLeaf();
	await findEditor();
	seed = { ...seed, status: 500 };
	void client.invalidateQueries();

	const banner = await screen.findByTestId("file-banner", undefined, { timeout: 8000 });
	expect(banner.textContent).toContain("Could not check the file on disk");
	expect(screen.getByTestId(`editor-${PATH}`)).not.toBeNull();
}, 12_000);

test("a read without an etag is an error, not an empty If-Match", async () => {
	seed = { text: "hello", etag: "", noEtag: true };
	renderLeaf();
	expect(await screen.findByText("This file could not be opened")).not.toBeNull();
	expect(
		screen.getByText(/did not say which version of this file it sent/),
	).not.toBeNull();
	expect(screen.queryByTestId(`editor-${PATH}`)).toBeNull();
	expect(requests).toHaveLength(0);
});

test("a write answered without an etag fails loudly", async () => {
	renderLeaf();
	await findEditor();
	seed = { ...seed, noWriteEtag: true };
	type("hello world");

	await waitFor(() => expect(status().textContent).toBe("Save failed"), {
		timeout: 3000,
	});
	expect(screen.getByText(/did not say which version it saved/)).not.toBeNull();
});

test("a file past the editor limit offers a download instead", async () => {
	seed = { text: "", etag: "", status: 413 };
	renderLeaf();
	const link = await screen.findByTestId("file-download");
	expect(link.getAttribute("href")).toBe(
		`/workspaces/${WORKSPACE}/projects/${PROJECT}/file?path=src%2Fapp.ts&download=1`,
	);
	expect(screen.queryByTestId(`editor-${PATH}`)).toBeNull();
	// Nothing was ever edited, so the pill would only be noise.
	expect(screen.queryByTestId(`file-status-${PATH}`)).toBeNull();
});

test("a binary file opens in the viewer", async () => {
	seed = {
		text: " PNG",
		etag: "etag-bin",
		contentType: "application/octet-stream",
	};
	renderLeaf();
	await screen.findByTestId("file-download");
	expect(screen.getByText("Not a text file")).not.toBeNull();
	expect(screen.queryByTestId(`file-status-${PATH}`)).toBeNull();
});

test("a deleted file says so and can be closed", async () => {
	seed = { text: "", etag: "", status: 404 };
	const onClose = vi.fn();
	renderLeaf(onClose);
	expect(await screen.findByText("This file was moved or deleted")).not.toBeNull();
	expect(screen.queryByTestId(`file-status-${PATH}`)).toBeNull();
	screen.getByTestId("file-close").click();
	expect(onClose).toHaveBeenCalled();
});

const MD_PATH = "README.md";

/** Open a Markdown tab and wait for both panels to be on the page. */
async function renderMarkdownLeaf() {
	seed = { text: "# Notes\n", etag: "etag-0" };
	renderLeaf(() => {}, MD_PATH);
	await findEditor(MD_PATH);
	await screen.findByTestId("markdown-rich");
}

test("a Markdown file opens in the rich view with all three views offered", async () => {
	await renderMarkdownLeaf();
	expect(screen.getByTestId("markdown-mode-code").textContent).toBe("Code");
	expect(screen.getByTestId("markdown-mode-rich").textContent).toBe("Rich");
	expect(screen.getByTestId("markdown-mode-split").textContent).toBe("Split");
	expect(screen.getByTestId("markdown-mode-rich").getAttribute("aria-pressed")).toBe(
		"true",
	);
	expect(screen.getByTestId("md-rich-pane").hasAttribute("hidden")).toBe(false);
	expect(screen.getByTestId("md-code-pane").hasAttribute("hidden")).toBe(true);
});

test("Code hides the rich view instead of unmounting the editor", async () => {
	await renderMarkdownLeaf();
	act(() => screen.getByTestId("markdown-mode-code").click());

	expect(screen.getByTestId("md-rich-pane").hasAttribute("hidden")).toBe(true);
	expect(screen.queryByTestId("markdown-rich")).toBeNull();
	expect(screen.getByTestId("md-code-pane").hasAttribute("hidden")).toBe(false);
	expect(screen.getByTestId(`editor-${MD_PATH}`)).not.toBeNull();
});

test("switching views keeps the editor's model, so undo and cursor survive", async () => {
	await renderMarkdownLeaf();
	const model = state.model;
	expect(model).not.toBeNull();

	act(() => screen.getByTestId("markdown-mode-code").click());
	act(() => screen.getByTestId("markdown-mode-split").click());
	act(() => screen.getByTestId("markdown-mode-rich").click());

	// A disposed model would have lost the undo history with it.
	expect(model?.disposed).toBe(false);
	expect(state.model).toBe(model);
});

test("a file that is not Markdown offers no view buttons", async () => {
	renderLeaf();
	await findEditor();
	expect(screen.queryByTestId("markdown-mode-code")).toBeNull();
	expect(screen.queryByTestId("markdown-split")).toBeNull();
});

/** Asking for a line while the tab is already open, as a search result does. */
function Harness() {
	const [line, setLine] = useState<number | undefined>(undefined);
	return (
		<>
			<button type="button" data-testid="ask" onClick={() => setLine(9)}>
				ask
			</button>
			<FileLeaf
				path={PATH}
				workspaceId={WORKSPACE}
				projectId={PROJECT}
				onClose={() => {}}
				pendingLine={line}
				consumePendingLine={() => {
					setLine(undefined);
					return line;
				}}
			/>
		</>
	);
}

test("a file already open jumps to a line it is asked for again", async () => {
	renderWithQuery(<Harness />);
	await screen.findByTestId(`editor-${PATH}`);
	await waitFor(() => expect(state.model?.getValue()).toBe("hello"));
	cursorLines.length = 0;
	revealedLines.length = 0;

	fireEvent.click(screen.getByTestId("ask"));

	await waitFor(() => expect(cursorLines).toContain(9));
	expect(revealedLines).toContain(9);
});

test("a real change on disk opens a diff of the two versions (issue #158)", async () => {
	renderLeaf();
	await findEditor();
	type("mine");
	seed = { text: "theirs", etag: "etag-other" };
	await screen.findByTestId("file-conflict", undefined, { timeout: 3000 });

	await screen.findByTestId(`conflict-editor-${PATH}`);
	// The version on disk is on the left and the student's is on the right.
	expect(diffState.models?.original.getValue()).toBe("theirs");
	expect(diffState.models?.modified.getValue()).toBe("mine");
	// There is no keep-or-take prompt without a diff to read behind it.
	expect(screen.getByTestId("keep-mine")).not.toBeNull();
});

test("editing the conflict diff keeps the text and saves it with Keep mine", async () => {
	renderLeaf();
	await findEditor();
	type("mine");
	seed = { text: "theirs", etag: "etag-other" };
	await screen.findByTestId("file-conflict", undefined, { timeout: 3000 });
	await screen.findByTestId(`conflict-editor-${PATH}`);

	const sent = requests.length;
	typeInConflict("mine, merged by hand");
	// Nothing is written while the conflict is unresolved (SPEC.md §13.3).
	await new Promise((resolve) => setTimeout(resolve, 1200));
	expect(requests).toHaveLength(sent);

	screen.getByTestId("keep-mine").click();
	await waitFor(() => expect(status().textContent).toBe("Saved"), { timeout: 3000 });
	expect(requests.at(-1)).toMatchObject({
		ifMatch: "etag-other",
		body: "mine, merged by hand",
	});
});

test("Keep editing puts the conflict diff away and brings it back", async () => {
	renderLeaf();
	await findEditor();
	type("mine");
	seed = { text: "theirs", etag: "etag-other" };
	await screen.findByTestId("file-conflict", undefined, { timeout: 3000 });
	await screen.findByTestId(`conflict-editor-${PATH}`);

	fireEvent.click(screen.getByTestId("keep-editing"));
	expect(screen.queryByTestId(`conflict-editor-${PATH}`)).toBeNull();
	// The editor and the student's text are still there, and so is the offer.
	expect(state.model?.getValue()).toBe("mine");
	expect(screen.getByTestId("file-conflict")).not.toBeNull();

	fireEvent.click(screen.getByTestId("keep-editing"));
	expect(await screen.findByTestId(`conflict-editor-${PATH}`)).not.toBeNull();
});

test("Keep editing carries the conflict edits into the editor (issue #158)", async () => {
	renderLeaf();
	await findEditor();
	type("mine");
	seed = { text: "theirs", etag: "etag-other" };
	await screen.findByTestId("file-conflict", undefined, { timeout: 3000 });
	await screen.findByTestId(`conflict-editor-${PATH}`);

	typeInConflict("mine, merged by hand");
	fireEvent.click(screen.getByTestId("keep-editing"));

	// The editor below the diff has to hold what was typed in the diff, or
	// the next keystroke would write the older text back over it.
	await waitFor(() => expect(state.model?.getValue()).toBe("mine, merged by hand"));
});

test("the model is named after the project as well as the file (issue #160)", async () => {
	renderLeaf();
	await findEditor();
	// Two projects can hold a README.md; one model must not serve both.
	expect(state.uris.at(-1)).toBe(`pk:/${PROJECT}/${PATH}`);
});

test("opening a file again brings a tab in diff view back to the editor", async () => {
	function Reopen() {
		const [opened, setOpened] = useState(0);
		return (
			<>
				<button type="button" data-testid="reopen" onClick={() => setOpened(1)}>
					Open the file again
				</button>
				<FileLeaf
					path={PATH}
					workspaceId={WORKSPACE}
					projectId={PROJECT}
					onClose={() => {}}
					pendingDiff={1}
					consumePendingDiff={() => opened === 0}
					pendingEdit={opened}
					consumePendingEdit={() => opened === 1}
				/>
			</>
		);
	}
	renderWithQuery(<Reopen />);
	expect(await screen.findByTestId(`diff-pane-${PATH}`)).not.toBeNull();

	fireEvent.click(screen.getByTestId("reopen"));

	await waitFor(() => expect(screen.queryByTestId(`diff-pane-${PATH}`)).toBeNull());
	expect(screen.getByTestId(`file-pane-${PATH}`).style.display).toBe("");
});

test("Take disk closes the conflict diff", async () => {
	renderLeaf();
	await findEditor();
	type("mine");
	seed = { text: "theirs", etag: "etag-other" };
	await screen.findByTestId("file-conflict", undefined, { timeout: 3000 });
	await screen.findByTestId(`conflict-editor-${PATH}`);

	fireEvent.click(screen.getByTestId("take-disk"));
	await waitFor(() => expect(state.model?.getValue()).toBe("theirs"));
	expect(screen.queryByTestId(`conflict-editor-${PATH}`)).toBeNull();
	expect(screen.queryByTestId("file-conflict")).toBeNull();
});

test("a tab asked for its diff shows it, and the toggle goes back (issue #160)", async () => {
	renderWithQuery(
		<FileLeaf
			path={PATH}
			workspaceId={WORKSPACE}
			projectId={PROJECT}
			onClose={() => {}}
			pendingDiff={1}
			consumePendingDiff={() => true}
		/>,
	);

	// The diff view of this tab, not a second tab.
	expect(await screen.findByTestId(`diff-pane-${PATH}`)).not.toBeNull();
	expect(screen.getByTestId(`file-pane-${PATH}`).style.display).toBe("none");

	fireEvent.click(screen.getAllByTestId(`file-view-edit-${PATH}`)[0] as HTMLElement);
	expect(screen.queryByTestId(`diff-pane-${PATH}`)).toBeNull();
	expect(screen.getByTestId(`file-pane-${PATH}`).style.display).toBe("");
});

test("a tab opened for editing shows the editor until Diff is clicked", async () => {
	renderLeaf();
	await findEditor();
	expect(screen.queryByTestId(`diff-pane-${PATH}`)).toBeNull();

	fireEvent.click(screen.getByTestId(`file-view-diff-${PATH}`));
	expect(await screen.findByTestId(`diff-pane-${PATH}`)).not.toBeNull();
});

test("auto-save off writes nothing until Ctrl+S (issue #159)", async () => {
	settings = { ...EDITOR_SETTINGS_DEFAULTS, autoSave: false, autoSaveDelaySeconds: 1 };
	renderLeaf();
	const host = await findEditor();
	type("typed by hand");

	// Well past the delay: with auto-save off there is no timer at all.
	await new Promise((resolve) => setTimeout(resolve, 1500));
	expect(requests).toHaveLength(0);
	expect(status().textContent).toBe("Unsaved");

	const event = new KeyboardEvent("keydown", {
		key: "s",
		ctrlKey: true,
		bubbles: true,
		cancelable: true,
	});
	host.dispatchEvent(event);
	// The browser's own save dialog must not open (SPEC.md §13.5).
	expect(event.defaultPrevented).toBe(true);
	await waitFor(() => expect(requests).toHaveLength(1), { timeout: 3000 });
	expect(requests[0]).toMatchObject({ ifMatch: "etag-0", body: "typed by hand" });
	await waitFor(() => expect(status().textContent).toBe("Saved"), { timeout: 3000 });
});

test("Cmd+S saves too, for a Mac keyboard (issue #159)", async () => {
	settings = { ...EDITOR_SETTINGS_DEFAULTS, autoSave: false, autoSaveDelaySeconds: 1 };
	renderLeaf();
	const host = await findEditor();
	type("typed on a mac");
	host.dispatchEvent(
		new KeyboardEvent("keydown", {
			key: "s",
			metaKey: true,
			bubbles: true,
			cancelable: true,
		}),
	);
	await waitFor(() => expect(requests).toHaveLength(1), { timeout: 3000 });
	expect(requests[0]?.body).toBe("typed on a mac");
});

test("the auto-save delay comes from the settings (issue #159)", async () => {
	settings = { ...EDITOR_SETTINGS_DEFAULTS, autoSaveDelaySeconds: 3 };
	renderLeaf();
	await findEditor();
	type("slow save");

	// A one second delay would already have written it.
	await new Promise((resolve) => setTimeout(resolve, 1500));
	expect(requests).toHaveLength(0);
	await waitFor(() => expect(requests).toHaveLength(1), { timeout: 5000 });
	expect(requests[0]?.body).toBe("slow save");
}, 12_000);

test("word wrap off is what Monaco is created with (issue #159)", async () => {
	renderLeaf();
	await findEditor();
	expect(state.created?.wordWrap).toBe("off");
});

test("word wrap on reaches Monaco (issue #159)", async () => {
	settings = { ...EDITOR_SETTINGS_DEFAULTS, wordWrap: true, autoSaveDelaySeconds: 1 };
	renderLeaf();
	await findEditor();
	await waitFor(() =>
		expect(
			state.created?.wordWrap === "on" ||
				state.updates.some((options) => options.wordWrap === "on"),
		).toBe(true),
	);
});

test("a remembered cursor is put back when the tab opens again (issue #161)", async () => {
	const store = createLayoutStore();
	store.getState().openFile(PATH);
	store.getState().setViewState(PATH, { line: 42 });
	renderLeafWithStore(store);
	await findEditor();
	// Only once the model holds the real text, so Monaco has lines to scroll to.
	await waitFor(() => expect(restoredViewStates).toEqual([{ line: 42 }]));
	expect(state.model?.getValue()).toBe("hello");
});

test("moving the cursor is remembered for the next mount (issue #161)", async () => {
	const store = createLayoutStore();
	store.getState().openFile(PATH);
	renderLeafWithStore(store);
	await findEditor();
	act(() => moveCursor?.());
	await waitFor(() => expect(store.getState().viewStates[PATH]).toEqual({ line: 2 }));
	// The store has it at once, so leaving the route cannot race the save.
	act(() => moveCursor?.());
	expect(store.getState().viewStates[PATH]).toEqual({ line: 3 });
	act(() => cleanup());
	expect(store.getState().viewStates[PATH]).toEqual({ line: 3 });
});
