/**
 * The file tab's state machine: autosave, external refresh, conflicts and
 * the viewer flow (SPEC.md §13.2, §13.3, §13.5). Monaco itself is replaced
 * by a fake, so these tests are about the states, not about rendering text.
 */
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { renderWithQuery } from "../test-utils.js";
import { FileLeaf } from "./FileLeaf.js";

/** The smallest Monaco that CodeEditor.tsx can drive. */
class FakeModel {
	listeners: (() => void)[] = [];
	constructor(public value: string) {}
	getValue() {
		return this.value;
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

const state: { model: FakeModel | null } = { model: null };

vi.mock("monaco-editor/basic-languages/monaco.contribution.js", () => ({}));
vi.mock("monaco-editor/language/json/monaco.contribution.js", () => ({
	jsonDefaults: { setDiagnosticsOptions: () => {} },
}));
vi.mock("monaco-editor/editor/editor.api.js", () => {
	const models = new Map<string, FakeModel>();
	return {
		Uri: { parse: (value: string) => ({ toString: () => value, value }) },
		languages: {
			getLanguages: () => [{ id: "typescript", extensions: [".ts"] }],
			json: { jsonDefaults: { setDiagnosticsOptions: () => {} } },
		},
		editor: {
			defineTheme: () => {},
			setTheme: () => {},
			getModel: (uri: { value: string }) => {
				const held = models.get(uri.value);
				return held && !held.disposed ? held : null;
			},
			createModel: (value: string, _language: string, uri: { value: string }) => {
				const model = new FakeModel(value);
				models.set(uri.value, model);
				state.model = model;
				return model;
			},
			create: (_host: HTMLElement, options: { model: FakeModel }) => {
				state.model = options.model;
				return {
					onDidChangeModelContent: (listener: () => void) => {
						options.model.listeners.push(listener);
					},
					setPosition: () => {},
					revealLineInCenter: () => {},
					updateOptions: () => {},
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
		vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			const method = init?.method ?? "GET";
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
			if (gate) await gate.promise;
			const creating = headers.get("if-none-match") === "*";
			if (!creating && headers.get("if-match") !== seed.etag) {
				return new Response(
					JSON.stringify({ error: { code: "FILE_CHANGED", message: "changed" } }),
					{ status: 412, headers: { etag: seed.etag } },
				);
			}
			seed = { ...seed, status: 200, text: body, etag: `etag-${requests.length}` };
			const payload = seed.noWriteEtag
				? { size: body.length }
				: { etag: seed.etag, size: body.length };
			return new Response(JSON.stringify(payload), {
				status: 200,
				headers: { "content-type": "application/json", etag: seed.etag },
			});
		}),
	);
}

beforeEach(() => {
	requests.length = 0;
	state.model = null;
	gate = null;
	seed = { text: "hello", etag: "etag-0" };
	stubServer();
});

afterEach(() => {
	vi.unstubAllGlobals();
});

function renderLeaf(onClose = () => {}, path = PATH) {
	renderWithQuery(
		<FileLeaf
			path={path}
			workspaceId={WORKSPACE}
			projectId={PROJECT}
			onClose={onClose}
		/>,
	);
}

function status() {
	return screen.getByTestId(`file-status-${PATH}`);
}

test("the file loads into the editor and shows Saved", async () => {
	renderLeaf();
	await screen.findByTestId(`editor-${PATH}`);
	expect(state.model?.getValue()).toBe("hello");
	expect(status().textContent).toBe("Saved");
});

test("typing autosaves with the etag it was read at", async () => {
	renderLeaf();
	await screen.findByTestId(`editor-${PATH}`);
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
	const host = await screen.findByTestId(`editor-${PATH}`);
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
	await screen.findByTestId(`editor-${PATH}`);
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
	await screen.findByTestId(`editor-${PATH}`);
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

test("unmounting mid-debounce flushes the pending write", async () => {
	renderLeaf();
	await screen.findByTestId(`editor-${PATH}`);
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
	await screen.findByTestId(`editor-${PATH}`);
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
	await screen.findByTestId(`editor-${PATH}`);
	type("mine");
	seed = { text: "theirs", etag: "etag-other" };
	await screen.findByTestId("file-conflict", undefined, { timeout: 3000 });
	const sent = requests.length;

	type("mine, edited again");
	await new Promise((resolve) => setTimeout(resolve, 1200));
	expect(requests).toHaveLength(sent);
	expect(status().textContent).toBe("Conflict");
});

test("Take theirs replaces the local text with the file on disk", async () => {
	renderLeaf();
	await screen.findByTestId(`editor-${PATH}`);
	type("mine");
	seed = { text: "theirs", etag: "etag-other" };
	await screen.findByTestId("file-conflict", undefined, { timeout: 3000 });

	screen.getByTestId("take-theirs").click();
	await waitFor(() => expect(state.model?.getValue()).toBe("theirs"));
	expect(screen.queryByTestId("file-conflict")).toBeNull();
	expect(status().textContent).toBe("Saved");
});

test("an external change with no local edits refreshes the editor silently", async () => {
	renderLeaf();
	await screen.findByTestId(`editor-${PATH}`);
	seed = { text: "from the agent", etag: "etag-agent" };
	// The query refetches when the tab regains focus, which is what a student
	// coming back from a terminal does.
	document.dispatchEvent(new Event("visibilitychange"));
	await waitFor(() => expect(state.model?.getValue()).toBe("from the agent"), {
		timeout: 8000,
	});
	expect(status().textContent).toBe("Saved");
	expect(requests).toHaveLength(0);
}, 12_000);

test("a file deleted while it is open keeps the editor and recreates it", async () => {
	renderLeaf();
	await screen.findByTestId(`editor-${PATH}`);
	seed = { ...seed, status: 404 };
	document.dispatchEvent(new Event("visibilitychange"));

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
	renderLeaf();
	await screen.findByTestId(`editor-${PATH}`);
	seed = { ...seed, status: 500 };
	document.dispatchEvent(new Event("visibilitychange"));

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
	await screen.findByTestId(`editor-${PATH}`);
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
	await screen.findByTestId(`editor-${MD_PATH}`);
	await screen.findByTestId("markdown-preview");
}

test("a Markdown file opens in Preview with all three views offered", async () => {
	await renderMarkdownLeaf();
	expect(screen.getByTestId("markdown-mode-edit").textContent).toBe("Edit");
	expect(screen.getByTestId("markdown-mode-preview").textContent).toBe("Preview");
	expect(screen.getByTestId("markdown-mode-split").textContent).toBe("Split");
	expect(screen.getByTestId("markdown-mode-preview").getAttribute("aria-pressed")).toBe(
		"true",
	);
	expect(screen.getByTestId("md-preview-pane").hasAttribute("hidden")).toBe(false);
	expect(screen.getByTestId("md-edit-pane").hasAttribute("hidden")).toBe(true);
});

test("Edit hides the preview instead of unmounting the editor", async () => {
	await renderMarkdownLeaf();
	act(() => screen.getByTestId("markdown-mode-edit").click());

	expect(screen.getByTestId("md-preview-pane").hasAttribute("hidden")).toBe(true);
	expect(screen.getByTestId("md-edit-pane").hasAttribute("hidden")).toBe(false);
	expect(screen.getByTestId(`editor-${MD_PATH}`)).not.toBeNull();
});

test("switching views keeps the editor's model, so undo and cursor survive", async () => {
	await renderMarkdownLeaf();
	const model = state.model;
	expect(model).not.toBeNull();

	act(() => screen.getByTestId("markdown-mode-edit").click());
	act(() => screen.getByTestId("markdown-mode-split").click());
	act(() => screen.getByTestId("markdown-mode-preview").click());

	// A disposed model would have lost the undo history with it.
	expect(model?.disposed).toBe(false);
	expect(state.model).toBe(model);
});

test("a file that is not Markdown offers no view buttons", async () => {
	renderLeaf();
	await screen.findByTestId(`editor-${PATH}`);
	expect(screen.queryByTestId("markdown-mode-edit")).toBeNull();
	expect(screen.queryByTestId("markdown-split")).toBeNull();
});
