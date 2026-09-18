/**
 * The diff tab: what each Git status shows, the two cases that cannot be
 * diffed, and what a live refresh does to the reader's place (SPEC.md §12.6).
 * Monaco is replaced by a fake, so these tests are about the states.
 */
import { cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
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
};

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
		createDiffEditor: () => ({
			setModel: (models: { original: FakeModel; modified: FakeModel }) => {
				editorState.models = models;
			},
			saveViewState: () => {
				editorState.calls.push("save");
				return { scroll: 1 };
			},
			restoreViewState: () => {
				editorState.calls.push("restore");
			},
			dispose: () => {},
		}),
	},
}));

const WORKSPACE = "ws-1";
const PROJECT = "p-1";
const PATH = "src/app.ts";

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
	answer = { status: 200, body: diff() };
	stubServer();
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

function renderLeaf(onOpenFile = vi.fn()) {
	renderWithQuery(
		<DiffLeaf
			path={PATH}
			workspaceId={WORKSPACE}
			projectId={PROJECT}
			onOpenFile={onOpenFile}
		/>,
	);
	return onOpenFile;
}

test("a modified file shows both sides with no note", async () => {
	renderLeaf();
	await screen.findByTestId(`diff-editor-${PATH}`);
	expect(editorState.models?.original.getValue()).toBe("one\n");
	expect(editorState.models?.modified.getValue()).toBe("two\n");
	expect(screen.getByTestId(`diff-status-${PATH}`).textContent).toBe("M");
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

test("a deleted file shows the HEAD side and offers no Open file", async () => {
	answer = { status: 200, body: diff({ status: "D", before: "gone\n", after: null }) };
	renderLeaf();
	await screen.findByTestId(`diff-editor-${PATH}`);
	expect(editorState.models?.original.getValue()).toBe("gone\n");
	expect(editorState.models?.modified.getValue()).toBe("");
	expect(screen.getByTestId("diff-note").textContent).toBe(
		"Deleted from the working tree",
	);
	expect(screen.queryByTestId("diff-open")).toBeNull();
});

test("a rename shows the old path and the new one", async () => {
	answer = { status: 200, body: diff({ status: "R", oldPath: "src/old.ts" }) };
	renderLeaf();
	await screen.findByTestId(`diff-editor-${PATH}`);
	expect(screen.getByText(`Diff · src/old.ts → ${PATH}`)).not.toBeNull();
	expect(screen.getByTestId(`diff-status-${PATH}`).textContent).toBe("R");
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
	expect(screen.getByTestId("diff-download").getAttribute("href")).toBe(
		`/workspaces/${WORKSPACE}/projects/${PROJECT}/file?path=src%2Fapp.ts&download=1`,
	);
	expect(screen.queryByTestId(`diff-editor-${PATH}`)).toBeNull();
});

test("a diff past the limit explains it and offers the file instead", async () => {
	answer = {
		status: 200,
		body: diff({ before: null, after: null, tooLarge: true }),
	};
	const onOpenFile = renderLeaf();
	expect(await screen.findByText("This diff is too large to show here")).not.toBeNull();
	expect(screen.getByTestId("diff-download")).not.toBeNull();
	screen.getByTestId("diff-open").click();
	expect(onOpenFile).toHaveBeenCalledWith(PATH);
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
