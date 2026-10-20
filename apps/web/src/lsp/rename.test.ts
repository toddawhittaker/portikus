/**
 * Rename and go to definition across files (SPEC.md §13.6): inside the
 * project, at most 20 files, all or nothing, saved through each tab.
 */
import type * as Monaco from "monaco-editor";
import { expect, test, vi } from "vitest";
import type { LanguageClient } from "./client.js";
import { registerEditor } from "./editors.js";
import type { CodeHelpManager } from "./manager.js";
import { OUTSIDE_PROJECT_MESSAGE, openDefinition } from "./opener.js";
import { pathFromServerUri } from "./protocol.js";
import { addManager, removeManager } from "./registry.js";
import { applyRename, MAX_RENAME_FILES, planRename } from "./rename.js";

const ROOT = "/home/student/projects/demo";
const pathOf = (uri: string) => pathFromServerUri(ROOT, uri);
const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
const fileUri = (path: string) => `file://${ROOT}/${path}`;

test("a rename inside the project lists its files", () => {
	const plan = planRename(
		{
			changes: { [fileUri("a.py")]: [{ range, newText: "y" }], [fileUri("b.py")]: [] },
		},
		pathOf,
	);
	expect(plan).toEqual({
		files: [
			{ path: "a.py", edits: [{ range, newText: "y" }], version: null },
			{ path: "b.py", edits: [], version: null },
		],
	});
});

test("a rename that reaches outside the project is refused", () => {
	const plan = planRename(
		{ changes: { [fileUri("a.py")]: [], "file:///usr/lib/x.py": [] } },
		pathOf,
	);
	expect(plan).toHaveProperty("reason");
});

test("a rename of more than 20 files is refused", () => {
	const changes = Object.fromEntries(
		Array.from({ length: MAX_RENAME_FILES + 1 }, (_, i) => [fileUri(`f${i}.py`), []]),
	);
	expect(planRename({ changes }, pathOf)).toHaveProperty("reason");
	delete changes[fileUri("f0.py")];
	expect(planRename({ changes }, pathOf)).toHaveProperty("files");
});

test("a rename that would create, move or delete a file is refused", () => {
	const plan = planRename(
		{
			documentChanges: [
				{ kind: "rename", oldUri: fileUri("a.py"), newUri: fileUri("b.py") },
			],
		},
		pathOf,
	);
	expect(plan).toHaveProperty("reason");
});

function fakeModel(version: number) {
	return { getVersionId: () => version, pushEditOperations: vi.fn() };
}

function setup(models: Record<string, ReturnType<typeof fakeModel>>) {
	const openFile = vi.fn();
	const monaco = {
		Uri: { parse: (value: string) => ({ toString: () => value }) },
		editor: {
			getModel: (uri: { toString(): string }) => models[uri.toString()] ?? null,
		},
	} as unknown as typeof Monaco;
	const manager = {
		options: { projectId: "p1", openFile },
	} as unknown as CodeHelpManager;
	const client = { pathOf } as unknown as LanguageClient;
	return { monaco, manager, client, openFile };
}

test("a rename opens unopened files, edits every file, and saves each through its tab", async () => {
	const a = fakeModel(3);
	const b = fakeModel(1);
	const models: Record<string, ReturnType<typeof fakeModel>> = { "pk:/p1/a.py": a };
	const { monaco, manager, client, openFile } = setup(models);
	const saves = { a: vi.fn(), b: vi.fn() };
	const offA = registerEditor("pk:/p1/a.py", saves.a);
	openFile.mockImplementation((path: string) => {
		expect(path).toBe("b.py");
		models["pk:/p1/b.py"] = b;
		registerEditor("pk:/p1/b.py", saves.b);
	});
	const message = await applyRename(monaco, manager, client, {
		documentChanges: [
			{
				textDocument: { uri: fileUri("a.py"), version: 3 },
				edits: [{ range, newText: "y" }],
			},
			{
				textDocument: { uri: fileUri("b.py"), version: null },
				edits: [{ range, newText: "y" }],
			},
		],
	});
	expect(message).toBe("Renamed in 2 files.");
	expect(a.pushEditOperations).toHaveBeenCalledTimes(1);
	expect(b.pushEditOperations).toHaveBeenCalledTimes(1);
	expect(saves.a).toHaveBeenCalledTimes(1);
	expect(saves.b).toHaveBeenCalledTimes(1);
	offA();
});

test("a rename against an older version of an open file changes nothing", async () => {
	const a = fakeModel(5);
	const c = fakeModel(1);
	const { monaco, manager, client } = setup({ "pk:/p1/a.py": a, "pk:/p1/c.py": c });
	const offs = [
		registerEditor("pk:/p1/a.py", vi.fn()),
		registerEditor("pk:/p1/c.py", vi.fn()),
	];
	const message = await applyRename(monaco, manager, client, {
		documentChanges: [
			{
				textDocument: { uri: fileUri("c.py"), version: 1 },
				edits: [{ range, newText: "y" }],
			},
			{
				textDocument: { uri: fileUri("a.py"), version: 4 },
				edits: [{ range, newText: "y" }],
			},
		],
	});
	expect(message).toMatch(/nothing was renamed/);
	expect(a.pushEditOperations).not.toHaveBeenCalled();
	expect(c.pushEditOperations).not.toHaveBeenCalled();
	for (const off of offs) off();
});

test("go to definition opens a project file at the line", () => {
	const openFile = vi.fn();
	const manager = {
		options: { projectId: "p1", openFile },
	} as unknown as CodeHelpManager;
	addManager("p1", manager);
	const source = {} as Monaco.editor.ICodeEditor;
	const handled = openDefinition(
		source,
		{ scheme: "pk", path: "/p1/lib/util.py" } as Monaco.Uri,
		{ startLineNumber: 12, startColumn: 1, endLineNumber: 12, endColumn: 4 },
	);
	expect(handled).toBe(true);
	expect(openFile).toHaveBeenCalledWith("lib/util.py", 12);
	removeManager("p1", manager);
});

test("go to definition outside the project is not opened, and says so", () => {
	const showMessage = vi.fn();
	const source = {
		getPosition: () => ({ lineNumber: 1, column: 1 }),
		getContribution: () => ({ showMessage }),
	} as unknown as Monaco.editor.ICodeEditor;
	const handled = openDefinition(
		source,
		{ scheme: "file", path: "/usr/lib/python3/os.py" } as Monaco.Uri,
		undefined,
	);
	expect(handled).toBe(true);
	expect(showMessage).toHaveBeenCalledWith(OUTSIDE_PROJECT_MESSAGE, {
		lineNumber: 1,
		column: 1,
	});
});
