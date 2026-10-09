/**
 * The diff view of a file tab: what each status shows, the two cases that cannot be
 * diffed, and what a live refresh does to the reader's place (SPEC.md §12.6).
 * Monaco is replaced by a fake, so these tests are about the states.
 */
import { EDITOR_SETTINGS_DEFAULTS } from "@portikus/contracts";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { editorSettingsKey } from "../editor/settingsQueries.js";
import { renderWithQuery } from "../test-utils.js";
import { DiffLeaf } from "./DiffLeaf.js";

/** The smallest Monaco the diff viewer can drive. */
class FakeModel {
	constructor(public value: string) {}
	getValue() {
		return this.value;
	}
	setValue(next: string) {
		this.value = next;
	}
	dispose() {
		this.disposed = true;
	}
	disposed = false;
}

const editorState = {
	models: null as { original: FakeModel; modified: FakeModel } | null,
	/** Every call to save and restore, in the order they happened. */
	calls: [] as string[],
	/** The options the diff editor was built with, then each later update. */
	options: [] as Record<string, unknown>[],
	/** Each side's latest name, and how many diff option updates came before it. */
	names: {} as Record<"original" | "modified", { label: unknown; after: number }>,
};

function nameSide(side: "original" | "modified") {
	return (next: Record<string, unknown>) => {
		editorState.names[side] = {
			label: next.ariaLabel,
			after: editorState.options.length,
		};
	};
}

vi.mock("../editor/features.js", () => ({ loadEditorFeatures: async () => {} }));
vi.mock("monaco-editor/basic-languages/monaco.contribution.js", () => ({}));
vi.mock("monaco-editor/language/json/monaco.contribution.js", () => ({
	jsonDefaults: { setDiagnosticsOptions: () => {} },
}));
vi.mock("monaco-editor/editor/editor.api.js", () => ({
	Uri: { parse: (value: string) => ({ toString: () => value, value }) },
	languages: { getLanguages: () => [{ id: "typescript", extensions: [".ts"] }] },
	editor: {
		defineTheme: () => {},
		setTheme: () => {},
		createModel: (value: string) => new FakeModel(value),
		createDiffEditor: (_host: unknown, options: Record<string, unknown>) => {
			editorState.options.push(options);
			return {
				updateOptions: (next: Record<string, unknown>) => {
					editorState.options.push(next);
				},
				setModel: (models: { original: FakeModel; modified: FakeModel }) => {
					editorState.models = models;
				},
				// The Markdown split scrolls the working-copy side by line;
				// nothing scrolls in jsdom, so this only has to answer.
				getOriginalEditor: () => ({ updateOptions: nameSide("original") }),
				getModifiedEditor: () => ({
					updateOptions: nameSide("modified"),
					onDidScrollChange: () => {},
					getVisibleRanges: () => [],
					getTopForLineNumber: () => 0,
					setScrollTop: () => {},
				}),
				saveViewState: () => {
					editorState.calls.push("save");
					return { scroll: 1 };
				},
				restoreViewState: () => {
					editorState.calls.push("restore");
				},
				dispose: () => {},
			};
		},
	},
}));

const WORKSPACE = "ws-1";
const PROJECT = "p-1";
const PATH = "src/app.ts";
const ORIGINAL_NAME = `Diff, earlier version, ${PATH}. Ctrl+M makes Tab leave the editor.`;
const MODIFIED_NAME = `Diff, your changes, ${PATH}. Ctrl+M makes Tab leave the editor.`;

let answer: { status: number; body: unknown };

function stubServer() {
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async () =>
				new Response(JSON.stringify(answer.body), {
					status: answer.status,
					headers: { "content-type": "application/json" },
				}),
		),
	);
}

function diff(overrides: Record<string, unknown> = {}) {
	return {
		status: "M",
		before: "one\n",
		after: "two\n",
		binary: false,
		tooLarge: false,
		...overrides,
	};
}

beforeEach(() => {
	editorState.models = null;
	editorState.calls.length = 0;
	editorState.options.length = 0;
	editorState.names = {} as typeof editorState.names;
	answer = { status: 200, body: diff() };
	stubServer();
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

function renderLeaf() {
	return renderWithQuery(
		<DiffLeaf
			path={PATH}
			workspaceId={WORKSPACE}
			projectId={PROJECT}
			toolbar={<button type="button">Edit</button>}
		/>,
	);
}

test("a modified file shows both sides with no note", async () => {
	renderLeaf();
	await screen.findByTestId(`diff-editor-${PATH}`);
	expect(editorState.models?.original.getValue()).toBe("one\n");
	expect(editorState.models?.modified.getValue()).toBe("two\n");
	// The status is a word, and each column is named.
	expect(screen.getByTestId(`diff-status-${PATH}`).textContent).toBe("Modified");
	expect(screen.getByTestId("diff-sides").textContent).toBe("Last commitYour changes");
	expect(screen.queryByTestId("diff-note")).toBeNull();
});

test("an added file has an empty HEAD side and says so", async () => {
	answer = { status: 200, body: diff({ status: "A", before: null, after: "new\n" }) };
	renderLeaf();
	await screen.findByTestId(`diff-editor-${PATH}`);
	expect(editorState.models?.original.getValue()).toBe("");
	expect(editorState.models?.modified.getValue()).toBe("new\n");
	expect(screen.getByTestId("diff-note").textContent).toBe("New file (not in HEAD)");
});

test("an added file under session review says it is new since the session started", async () => {
	answer = { status: 200, body: diff({ status: "A", before: null, after: "new\n" }) };
	renderWithQuery(
		<DiffLeaf
			path={PATH}
			workspaceId={WORKSPACE}
			projectId={PROJECT}
			baseline="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
		/>,
	);
	await screen.findByTestId(`diff-editor-${PATH}`);
	expect(screen.getByTestId("diff-note").textContent).toBe(
		"New since this session started",
	);
	// Under session review the left column is the session's start.
	expect(screen.getByTestId("diff-sides").textContent).toBe(
		"Session startYour changes",
	);
});

test("a deleted file shows the HEAD side and offers no Open file", async () => {
	answer = { status: 200, body: diff({ status: "D", before: "gone\n", after: null }) };
	renderLeaf();
	await screen.findByTestId(`diff-editor-${PATH}`);
	expect(editorState.models?.original.getValue()).toBe("gone\n");
	expect(editorState.models?.modified.getValue()).toBe("");
	expect(screen.getByTestId("diff-note").textContent).toBe(
		"Deleted from the working tree",
	);
	expect(screen.queryByTestId(`diff-open-${PATH}`)).toBeNull();
});

test("a rename shows the old path and the new one", async () => {
	answer = { status: 200, body: diff({ status: "R", oldPath: "src/old.ts" }) };
	renderLeaf();
	await screen.findByTestId(`diff-editor-${PATH}`);
	expect(screen.getByText(`Diff · src/old.ts → ${PATH}`)).not.toBeNull();
	expect(screen.getByTestId(`diff-status-${PATH}`).textContent).toBe("Renamed");
});

test("an unmerged file explains the conflict markers", async () => {
	answer = { status: 200, body: diff({ status: "U" }) };
	renderLeaf();
	await screen.findByTestId("diff-note");
	expect(screen.getByTestId("diff-note").textContent).toBe(
		"Unresolved merge conflict; the working-tree side shows the conflict markers",
	);
});

test("a binary change offers a download instead of a diff", async () => {
	answer = {
		status: 200,
		body: diff({ before: null, after: null, binary: true }),
	};
	renderLeaf();
	expect(await screen.findByText("Binary file changed")).not.toBeNull();
	expect(
		screen.getByRole("button", { name: "Download app.ts" }).getAttribute("data-testid"),
	).toBe(`diff-download-${PATH}`);
	expect(screen.queryByTestId(`diff-editor-${PATH}`)).toBeNull();
});

test("a diff past the limit explains it and offers a download", async () => {
	answer = {
		status: 200,
		body: diff({ before: null, after: null, tooLarge: true }),
	};
	renderLeaf();
	expect(await screen.findByText("This diff is too large to show here")).not.toBeNull();
	expect(screen.getByTestId(`diff-download-${PATH}`)).not.toBeNull();
});

test("the tab's own controls are drawn in the header", async () => {
	renderLeaf();
	await screen.findByTestId(`diff-editor-${PATH}`);
	expect(screen.getByRole("button", { name: "Edit" })).not.toBeNull();
});

test("a path the server refuses shows its message", async () => {
	answer = {
		status: 400,
		body: { code: "VALIDATION_FAILED", message: "that path is not inside the project" },
	};
	renderLeaf();
	expect(await screen.findByText("This diff could not be shown")).not.toBeNull();
	expect(screen.getByText("that path is not inside the project")).not.toBeNull();
});

test("a refresh keeps the reader's place around the new text", async () => {
	renderLeaf();
	await screen.findByTestId(`diff-editor-${PATH}`);
	expect(editorState.calls).toEqual([]);

	answer = { status: 200, body: diff({ after: "two and three\n" }) };
	// Coming back to the window is what refetches the diff.
	window.dispatchEvent(new Event("visibilitychange"));

	await waitFor(() =>
		expect(editorState.models?.modified.getValue()).toBe("two and three\n"),
	);
	// The view state is taken before the swap and put back after it.
	expect(editorState.calls.slice(0, 2)).toEqual(["save", "restore"]);
});

test("a failed refresh keeps the diff and says so in a banner", async () => {
	renderLeaf();
	await screen.findByTestId(`diff-editor-${PATH}`);

	answer = {
		status: 500,
		body: { code: "INTERNAL", message: "the workspace agent is not answering" },
	};
	window.dispatchEvent(new Event("visibilitychange"));

	await screen.findByTestId("diff-error");
	expect(screen.getByTestId("diff-error").textContent).toContain(
		"the workspace agent is not answering",
	);
	// The last good diff is still on screen.
	expect(screen.getByTestId(`diff-editor-${PATH}`)).not.toBeNull();
	expect(screen.queryByText("This diff could not be shown")).toBeNull();
	expect(editorState.models?.modified.getValue()).toBe("two\n");
});

test("a deleted binary file offers no download", async () => {
	answer = {
		status: 200,
		body: diff({ status: "D", before: null, after: null, binary: true }),
	};
	renderLeaf();
	expect(await screen.findByText("Binary file deleted")).not.toBeNull();
	expect(screen.queryByTestId(`diff-download-${PATH}`)).toBeNull();
});

test("closing the tab disposes both sides of the diff", async () => {
	renderLeaf();
	await screen.findByTestId(`diff-editor-${PATH}`);
	const models = editorState.models;

	cleanup();

	expect(models?.original.disposed).toBe(true);
	expect(models?.modified.disposed).toBe(true);
});

/** The diff editor's screen-reader support follows the setting, live. */
test("the diff editor's screen-reader support follows the setting", async () => {
	const client = renderLeaf();
	await screen.findByTestId(`diff-editor-${PATH}`);
	await waitFor(() => expect(editorState.options).toHaveLength(1));
	// Off is "auto", never "off", which would name the text box "not accessible".
	const initial = EDITOR_SETTINGS_DEFAULTS.screenReaderMode ? "on" : "auto";
	expect(editorState.options[0]?.accessibilitySupport).toBe(initial);

	act(() => {
		client.setQueryData(editorSettingsKey, {
			...EDITOR_SETTINGS_DEFAULTS,
			screenReaderMode: !EDITOR_SETTINGS_DEFAULTS.screenReaderMode,
			timezones: [],
		});
	});
	await waitFor(() =>
		expect(editorState.options.at(-1)).toEqual({
			accessibilitySupport: initial === "on" ? "auto" : "on",
		}),
	);
	// Monaco blanks both sides' names on a diff update, so they are set again after it.
	expect(editorState.names).toEqual({
		original: { label: ORIGINAL_NAME, after: 2 },
		modified: { label: MODIFIED_NAME, after: 2 },
	});
});

/** Each side of the diff names the file and the way out of the text box. */
test("each side of the diff names the file", async () => {
	renderLeaf();
	await screen.findByTestId(`diff-editor-${PATH}`);
	await waitFor(() => expect(editorState.options).toHaveLength(1));
	// Set on the inner editors after the diff editor exists, since Monaco's own
	// first option pass blanks names given to the diff editor.
	expect(editorState.names).toEqual({
		original: { label: ORIGINAL_NAME, after: 1 },
		modified: { label: MODIFIED_NAME, after: 1 },
	});
});

/** Answer by URL: the ref route gets `atRef`, HEAD gets the usual diff. */
function stubRefServer(atRef: { status: number; body: unknown }) {
	const urls: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			urls.push(url);
			const reply = url.includes("ref=") ? atRef : { status: 200, body: diff() };
			return new Response(JSON.stringify(reply.body), {
				status: reply.status,
				headers: { "content-type": "application/json" },
			});
		}),
	);
	return urls;
}

function compareWith(ref: string) {
	fireEvent.change(screen.getByLabelText("Compare with"), { target: { value: "ref" } });
	fireEvent.change(screen.getByLabelText("Branch, tag, or commit"), {
		target: { value: ref },
	});
	fireEvent.click(screen.getByRole("button", { name: "Compare" }));
}

test("the compare control offers the last commit and a Git ref, last commit first", async () => {
	renderLeaf();
	const select = screen.getByLabelText("Compare with") as HTMLSelectElement;
	expect([...select.options].map((option) => option.text)).toEqual([
		"Last commit",
		"A Git ref…",
	]);
	expect(select.value).toBe("head");
});

test("a typed ref is compared once submitted, and named on the left side", async () => {
	const urls = stubRefServer({ status: 200, body: diff({ before: "older\n" }) });
	renderLeaf();
	await screen.findByTestId(`diff-editor-${PATH}`);

	compareWith("v1.0");

	await waitFor(() => expect(editorState.models?.original.getValue()).toBe("older\n"));
	const wanted = `/workspaces/${WORKSPACE}/projects/${PROJECT}/git/diff?path=src%2Fapp.ts&ref=v1.0`;
	expect(urls.some((url) => url.endsWith(wanted))).toBe(true);
	expect(screen.getByTestId("diff-sides").textContent).toBe("v1.0Your changes");
	expect(screen.getByText(`Diff with v1.0 · ${PATH}`)).toBeTruthy();

	// Going back to the last commit asks without a ref.
	fireEvent.change(screen.getByLabelText("Compare with"), {
		target: { value: "head" },
	});
	await waitFor(() => expect(editorState.models?.original.getValue()).toBe("one\n"));
	expect(screen.getByTestId("diff-sides").textContent).toBe("Last commitYour changes");
});

test("a ref that could read as an option is refused before any request", async () => {
	const urls = stubRefServer({ status: 200, body: diff() });
	renderLeaf();
	await screen.findByTestId(`diff-editor-${PATH}`);
	const before = urls.length;

	compareWith("--output=/tmp/x");

	const alert = await screen.findByRole("alert");
	expect(alert.textContent).toBe("Type a branch, tag, or commit id.");
	expect(
		screen.getByLabelText("Branch, tag, or commit").getAttribute("aria-invalid"),
	).toBe("true");
	expect(urls.filter((url) => url.includes("ref=")).length).toBe(0);
	expect(urls.length).toBe(before);
});

test("a ref that names no commit is announced", async () => {
	stubRefServer({
		status: 400,
		body: {
			code: "VALIDATION_FAILED",
			message: "That Git ref does not name a commit.",
		},
	});
	renderLeaf();
	await screen.findByTestId(`diff-editor-${PATH}`);

	compareWith("nope");

	const alert = await screen.findByRole("alert");
	expect(alert.textContent).toBe("That Git ref does not name a commit.");
});

test("session review has no compare control", async () => {
	renderWithQuery(
		<DiffLeaf
			path={PATH}
			workspaceId={WORKSPACE}
			projectId={PROJECT}
			baseline="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
		/>,
	);
	await screen.findByTestId(`diff-editor-${PATH}`);
	expect(screen.queryByTestId("diff-compare")).toBeNull();
});
