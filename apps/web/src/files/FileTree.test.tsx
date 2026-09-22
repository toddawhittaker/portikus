import { ToastProvider } from "@portikus/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createQueryClient } from "../api/queryClient.js";
import { createLayoutStore, LayoutStoreContext } from "../layout/store.js";
import { json, project, stubFetch, WORKSPACE } from "../test-utils.js";
import { FileTreePane } from "./FileTree.js";
import { useFileViewStore } from "./store.js";

const PROJECT = project();

function entry(name: string, type: "file" | "dir" = "file") {
	return { name, type, size: 0, mtimeMs: 0 };
}

const ROOT = {
	entries: [
		entry("src", "dir"),
		entry("README.md"),
		entry(".env"),
		entry("node_modules", "dir"),
	],
	truncated: false,
};

const SRC = { entries: [entry("app.ts")], truncated: false };

/** An empty repository, so the tests do not run with a failed Git query. */
const NO_CHANGES = {
	repo: true,
	branch: "main",
	detached: false,
	upstream: "origin/main",
	ahead: 0,
	behind: 0,
	conflicts: 0,
	entries: [] as unknown[],
	ignored: [] as string[],
	truncated: false,
};

/** What the stubbed API answers for Git status; a test may replace it. */
let gitStatus: typeof NO_CHANGES = NO_CHANGES;

function renderPane(store = createLayoutStore()) {
	const client = createQueryClient(() => {});
	render(
		<QueryClientProvider client={client}>
			<ToastProvider>
				<LayoutStoreContext.Provider value={store}>
					<FileTreePane
						workspaceId={WORKSPACE.id}
						project={PROJECT}
						onSearch={() => {}}
					/>
				</LayoutStoreContext.Provider>
			</ToastProvider>
		</QueryClientProvider>,
	);
	return store;
}

beforeEach(() => {
	// The view store outlives a test, so each one starts from a closed tree.
	useFileViewStore.setState({ byProject: {} });
	gitStatus = NO_CHANGES;
	stubFetch((url, init) => {
		if (init?.method === "DELETE") return json(204, null);
		if (url.includes("/terminals")) return json(200, { terminals: [] });
		if (url.includes("/git/status")) return json(200, gitStatus);
		if (url.includes("/tree?path=src")) return json(200, SRC);
		if (url.includes("/tree?path=")) return json(200, ROOT);
		throw new Error(`unexpected request: ${url}`);
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("the file tree", () => {
	/** SPEC.md §11.3, issue #221: hidden and generated names are shown by default. */
	it("shows generated and dotted names until Show hidden is turned off", async () => {
		renderPane();

		expect(await screen.findByText("README.md")).toBeDefined();
		expect(screen.getByText("src")).toBeDefined();
		expect(screen.getByText(".env")).toBeDefined();
		expect(screen.getByText("node_modules")).toBeDefined();

		fireEvent.keyDown(screen.getByTestId("files-more"), { key: "Enter" });
		fireEvent.click(await screen.findByText("Show hidden and generated files"));

		await waitFor(() => expect(screen.queryByText(".env")).toBeNull());
		expect(screen.queryByText("node_modules")).toBeNull();
	});

	/** SPEC.md §11.2: a directory is fetched when it is expanded. */
	it("fetches a directory's contents when it is expanded", async () => {
		renderPane();
		expect(await screen.findByText("src")).toBeDefined();
		expect(screen.queryByText("app.ts")).toBeNull();

		fireEvent.click(screen.getByText("src"));

		expect(await screen.findByText("app.ts")).toBeDefined();
	});

	/** SPEC.md §12.1: a changed file carries its state on its row. */
	it("marks a modified file with its letter", async () => {
		gitStatus = {
			...NO_CHANGES,
			entries: [{ path: "README.md", x: ".", y: "M", unmerged: false }],
		};
		renderPane();

		const row = await screen.findByTestId("file-row-README.md");
		await waitFor(() => expect(row.getAttribute("data-git")).toBe("modified"));
		expect(row.textContent).toContain("M");
	});

	/** SPEC.md §8.3: a file opens as a tab in the work area. */
	it("opens a clicked file as a tab", async () => {
		const store = renderPane();
		fireEvent.click(await screen.findByText("README.md"));

		await waitFor(() =>
			expect(store.getState().layout.tabs.map((tab) => tab.id)).toEqual([
				"file:README.md",
			]),
		);
	});

	it("opens another file on a strip that is already full (issue #240)", async () => {
		const store = createLayoutStore();
		store.getState().load({
			tabs: Array.from({ length: 16 }, (_item, index) => ({
				id: `file:full-${index}.txt`,
				root: { type: "file" as const, path: `full-${index}.txt` },
			})),
		});
		renderPane(store);

		fireEvent.click(await screen.findByText("README.md"));

		await waitFor(() => expect(store.getState().layout.tabs).toHaveLength(17));
		expect(document.querySelectorAll(".pk-toast")).toHaveLength(0);
	});

	/** SPEC.md §11.2: the tree is usable from the keyboard alone. */
	it("moves, expands and opens from the keyboard", async () => {
		const store = renderPane();
		const first = await screen.findByTestId("file-row-src");

		first.focus();
		fireEvent.keyDown(first, { key: "ArrowRight" });
		expect(await screen.findByTestId("file-row-src/app.ts")).toBeDefined();

		fireEvent.keyDown(first, { key: "ArrowDown" });
		expect(document.activeElement).toBe(screen.getByTestId("file-row-src/app.ts"));

		fireEvent.keyDown(screen.getByTestId("file-row-src/app.ts"), { key: "Enter" });
		await waitFor(() =>
			expect(store.getState().layout.tabs.map((tab) => tab.id)).toEqual([
				"file:src/app.ts",
			]),
		);

		fireEvent.keyDown(first, { key: "ArrowLeft" });
		await waitFor(() => expect(screen.queryByTestId("file-row-src/app.ts")).toBeNull());
	});

	it("says when a listing was cut short", async () => {
		stubFetch(() => json(200, { entries: [entry("a.txt")], truncated: true }));
		renderPane();

		expect((await screen.findByTestId("file-tree-truncated")).textContent).toBe(
			"Showing the first 2000 entries",
		);
	});

	/** SPEC.md §11.2: a deleted file leaves no tab behind. */
	it("closes the tab of a file it deletes", async () => {
		const store = renderPane();
		fireEvent.click(await screen.findByText("src"));
		fireEvent.click(await screen.findByText("app.ts"));
		await waitFor(() =>
			expect(store.getState().layout.tabs.map((tab) => tab.id)).toEqual([
				"file:src/app.ts",
			]),
		);

		fireEvent.keyDown(screen.getByTestId("file-menu-src"), { key: "Enter" });
		fireEvent.click(await screen.findByTestId("row-delete"));
		fireEvent.click(await screen.findByTestId("dialog-confirm"));

		await waitFor(() => expect(store.getState().layout.tabs).toEqual([]));
		// The deleted directory is closed again, so nothing stale is drawn.
		expect(useFileViewStore.getState().byProject[PROJECT.id]?.expanded).toEqual([]);
	});

	/** SPEC.md §11.3: a project whose files are all hidden says so. */
	it("says when everything in the project is hidden", async () => {
		stubFetch((url) =>
			url.includes("/git/status")
				? json(200, NO_CHANGES)
				: json(200, { entries: [entry(".env")], truncated: false }),
		);
		renderPane();
		// Hidden files are on by default, so the test turns them off first.
		fireEvent.keyDown(await screen.findByTestId("files-more"), { key: "Enter" });
		fireEvent.click(await screen.findByText("Show hidden and generated files"));

		expect(
			await screen.findByText(
				"Everything here is hidden. Turn on Show hidden files to see it.",
			),
		).toBeDefined();
	});

	it("offers a retry when the root listing fails", async () => {
		let calls = 0;
		stubFetch(() => {
			calls += 1;
			return calls === 1
				? json(503, { error: { code: "AGENT_UNAVAILABLE", message: "no" } })
				: json(200, ROOT);
		});
		renderPane();

		fireEvent.click(await screen.findByTestId("file-tree-retry"));

		expect(await screen.findByText("README.md")).toBeDefined();
	});

	/** SPEC.md §11.2: the create actions are reachable with no files there. */
	it("creates a file in the project root from the header's more menu", async () => {
		const calls: { url: string; init?: RequestInit }[] = [];
		stubFetch((url, init) => {
			calls.push({ url, init });
			if (url.includes("/git/status")) return json(200, gitStatus);
			if (url.includes("/tree?path="))
				return json(200, { entries: [], truncated: false });
			return json(200, { path: "notes.txt", size: 0, mtimeMs: 0, etag: "1" });
		});
		renderPane();
		expect(await screen.findByText("No files yet")).toBeDefined();

		fireEvent.keyDown(screen.getByTestId("files-more"), { key: "Enter" });
		fireEvent.click(await screen.findByTestId("files-more-new-file"));

		expect(await screen.findByText("In the project root.")).toBeDefined();
		fireEvent.change(screen.getByTestId("field-file-name"), {
			target: { value: "notes.txt" },
		});
		fireEvent.click(screen.getByTestId("dialog-confirm"));

		await waitFor(() =>
			expect(
				calls.some(
					(call) =>
						call.init?.method === "PUT" && call.url.includes("file?path=notes.txt"),
				),
			).toBe(true),
		);
	});

	/** SPEC.md §11.2: a new folder too, from the same menu. */
	it("offers New folder in the header's more menu", async () => {
		renderPane();
		fireEvent.keyDown(await screen.findByTestId("files-more"), { key: "Enter" });
		fireEvent.click(await screen.findByTestId("files-more-new-folder"));

		expect(await screen.findByText("New folder")).toBeDefined();
		expect(screen.getByText("In the project root.")).toBeDefined();
	});

	/** An empty project offers the first file on the pane itself. */
	it("offers New file on the empty state", async () => {
		stubFetch((url) => {
			if (url.includes("/git/status")) return json(200, gitStatus);
			return json(200, { entries: [], truncated: false });
		});
		renderPane();

		fireEvent.click(await screen.findByTestId("files-empty-new-file"));

		expect(await screen.findByText("In the project root.")).toBeDefined();
	});

	/** Issue #185: the icon says what kind of file the row holds. */
	it("draws a different icon for a markdown file and a TypeScript file", async () => {
		renderPane();
		fireEvent.click(await screen.findByText("src"));
		await screen.findByText("app.ts");

		const md = screen
			.getByTestId("file-row-README.md")
			.querySelector("[data-icon^=file]");
		const ts = screen
			.getByTestId("file-row-src/app.ts")
			.querySelector("[data-icon^=file]");
		expect(md?.getAttribute("data-icon")).toBe("file-markdown");
		expect(ts?.getAttribute("data-icon")).toBe("file-code");
	});

	/** SPEC.md §11.2, issue #182: Ctrl-click selects more than one row. */
	it("deletes every selected row after one confirmation", async () => {
		const deleted: string[] = [];
		stubFetch((url, init) => {
			if (init?.method === "DELETE") {
				deleted.push(url);
				return json(204, null);
			}
			if (url.includes("/git/status")) return json(200, gitStatus);
			if (url.includes("/tree?path=src")) return json(200, SRC);
			if (url.includes("/tree?path=")) return json(200, ROOT);
			throw new Error(`unexpected request: ${url}`);
		});
		renderPane();

		fireEvent.click(await screen.findByText("README.md"));
		fireEvent.click(screen.getByText("src"), { ctrlKey: true });
		await waitFor(() =>
			expect(screen.getByTestId("file-row-src").getAttribute("data-selected")).toBe(
				"true",
			),
		);

		fireEvent.keyDown(screen.getByTestId("file-menu-README.md"), { key: "Enter" });
		fireEvent.click(await screen.findByText("Delete 2 items…"));

		const dialog = await screen.findByTestId("dialog-delete-file");
		expect(dialog.textContent).toContain("Delete 2 items");
		// The names are listed in the order the rows are drawn.
		expect(dialog.textContent).toContain("src, README.md");
		fireEvent.click(screen.getByTestId("dialog-confirm"));

		await waitFor(() => expect(deleted).toHaveLength(2));
		expect(deleted.some((url) => url.includes("path=README.md"))).toBe(true);
		expect(deleted.some((url) => url.includes("path=src"))).toBe(true);
	});

	/** SPEC.md §11.2: the folder takes its children, so they are not asked for. */
	it("deletes a folder once when a file inside it is selected too", async () => {
		const deleted: string[] = [];
		stubFetch((url, init) => {
			if (init?.method === "DELETE") {
				deleted.push(url);
				return json(204, null);
			}
			if (url.includes("/git/status")) return json(200, gitStatus);
			if (url.includes("/tree?path=src")) return json(200, SRC);
			if (url.includes("/tree?path=")) return json(200, ROOT);
			throw new Error(`unexpected request: ${url}`);
		});
		renderPane();

		// Open src so its child has a row, then select both the folder and it.
		fireEvent.click(await screen.findByText("src"));
		fireEvent.click(await screen.findByText("app.ts"), { ctrlKey: true });
		await waitFor(() =>
			expect(
				screen.getByTestId("file-row-src/app.ts").getAttribute("data-selected"),
			).toBe("true"),
		);

		fireEvent.keyDown(screen.getByTestId("file-menu-src"), { key: "Enter" });
		fireEvent.click(await screen.findByTestId("row-delete"));

		const dialog = await screen.findByTestId("dialog-delete-file");
		expect(dialog.textContent).toContain("Delete src");
		fireEvent.click(screen.getByTestId("dialog-confirm"));

		await waitFor(() => expect(deleted).toHaveLength(1));
		expect(deleted[0]).toContain("path=src");
	});

	/** A Ctrl-click changes the selection without opening the file. */
	it("does not open a file that is Ctrl-clicked", async () => {
		const store = renderPane();
		fireEvent.click(await screen.findByText("README.md"), { ctrlKey: true });

		await waitFor(() =>
			expect(
				screen.getByTestId("file-row-README.md").getAttribute("data-selected"),
			).toBe("true"),
		);
		expect(store.getState().layout.tabs).toEqual([]);
	});

	/** Issue #183: dragging an upload over the pane shows where it will land. */
	it("highlights the whole pane while a file is dragged over the root", async () => {
		renderPane();
		const body = await screen.findByTestId("file-tree-body");
		expect(body.getAttribute("data-upload-root")).toBeNull();

		fireEvent.dragEnter(body, { dataTransfer: { types: ["Files"] } });

		await waitFor(() => expect(body.getAttribute("data-upload-root")).toBe("true"));
		expect(screen.getByTestId("file-tree-root-hint").textContent).toContain(
			"Drop to upload to",
		);

		fireEvent.dragLeave(body);
		await waitFor(() => expect(body.getAttribute("data-upload-root")).toBeNull());
	});

	/** Issue #237: the empty area below the tree is a project-root target. */
	it("offers the empty area below the tree as a drop target for the root", async () => {
		renderPane();
		const space = await screen.findByTestId("file-tree-space-drop");

		expect(space.getAttribute("data-drop-dir")).toBe("");
		// The path line under the header stays a target too.
		expect(
			screen.getByTestId("file-tree-root-drop").getAttribute("data-drop-dir"),
		).toBe("");
	});

	/** Issue #220: the root drop target must not flicker over a top-level row. */
	it("keeps the root drop target while the drag crosses a top-level file", async () => {
		renderPane();
		const body = await screen.findByTestId("file-tree-body");
		const row = await screen.findByTestId("file-row-README.md");

		fireEvent.dragEnter(body, { dataTransfer: { types: ["Files"] } });
		await waitFor(() => expect(body.getAttribute("data-upload-root")).toBe("true"));

		// Entering the row and leaving it again, both inside the pane.
		fireEvent.dragEnter(row, { dataTransfer: { types: ["Files"] } });
		fireEvent.dragOver(row, { dataTransfer: { types: ["Files"] } });
		fireEvent.dragLeave(body);

		expect(body.getAttribute("data-upload-root")).toBe("true");
		expect(screen.getByTestId("file-tree-root-hint")).toBeDefined();

		// Leaving the pane altogether still clears it.
		fireEvent.dragLeave(body);
		await waitFor(() => expect(body.getAttribute("data-upload-root")).toBeNull());
	});

	/** Issue #221: an untracked file is marked so the CSS can dim it. */
	it("marks an untracked file's row as untracked", async () => {
		gitStatus = {
			...NO_CHANGES,
			entries: [{ path: "README.md", x: "?", y: "?", unmerged: false }],
		};
		renderPane();

		const row = await screen.findByTestId("file-row-README.md");
		await waitFor(() => expect(row.getAttribute("data-git")).toBe("untracked"));
	});

	/** Issue #186: the name field is ready to type into. */
	it("focuses the name field when the New file dialog opens", async () => {
		renderPane();
		fireEvent.keyDown(await screen.findByTestId("files-more"), { key: "Enter" });
		fireEvent.click(await screen.findByTestId("files-more-new-file"));

		const field = await screen.findByTestId("field-file-name");
		await waitFor(() => expect(document.activeElement).toBe(field));
	});

	/** The rename dialog opens with the old name selected, ready to replace. */
	it("focuses and selects the name in the rename dialog", async () => {
		renderPane();
		fireEvent.keyDown(await screen.findByTestId("file-menu-README.md"), {
			key: "Enter",
		});
		fireEvent.click(await screen.findByTestId("row-rename"));

		const field = (await screen.findByTestId("field-file-name")) as HTMLInputElement;
		await waitFor(() => expect(document.activeElement).toBe(field));
		expect(field.selectionStart).toBe(0);
		expect(field.selectionEnd).toBe("README.md".length);
	});

	it("offers a download link for each file", async () => {
		renderPane();
		fireEvent.keyDown(await screen.findByTestId("file-menu-README.md"), {
			key: "Enter",
		});

		const link = await screen.findByTestId("row-download-README.md");
		expect(link.getAttribute("href")).toBe(
			`/workspaces/${WORKSPACE.id}/projects/${PROJECT.id}/file?path=README.md&download=1`,
		);
	});

	/** Issue #361: Show hidden is a menu item, so the keyboard can reach it. */
	it("toggles Show hidden from the keyboard as a menu checkbox", async () => {
		renderPane();
		expect(await screen.findByText(".env")).toBeDefined();
		fireEvent.keyDown(screen.getByTestId("files-more"), { key: "Enter" });

		const item = await screen.findByRole("menuitemcheckbox", {
			name: "Show hidden and generated files",
		});
		expect(item.getAttribute("aria-checked")).toBe("true");
		fireEvent.keyDown(item, { key: "Enter" });

		await waitFor(() => expect(screen.queryByText(".env")).toBeNull());
	});

	/** Issue #362: the Git state is part of what a screen reader hears. */
	it("puts the Git state, ignored and contains-changes into the row's text", async () => {
		gitStatus = {
			...NO_CHANGES,
			entries: [
				{ path: "README.md", x: ".", y: "M", unmerged: false },
				{ path: "src/app.ts", x: "?", y: "?", unmerged: false },
			],
			ignored: ["node_modules/"],
		};
		renderPane();

		const readme = await screen.findByTestId("file-row-README.md");
		await waitFor(() => expect(readme.textContent).toContain("Modified"));
		expect(screen.getByTestId("file-row-src").textContent).toContain(
			"contains changes",
		);
		const ignored = screen.getByTestId("file-row-node_modules");
		expect(ignored.textContent).toContain("ignored");
		expect(ignored.getAttribute("data-ignored")).toBe("true");
	});

	/** Issue #366: one Tab leaves the tree, so row buttons are not tab stops. */
	it("keeps the row action buttons out of the Tab order", async () => {
		renderPane();
		await screen.findByTestId("file-row-README.md");

		expect(screen.getByTestId("file-menu-README.md").getAttribute("tabindex")).toBe(
			"-1",
		);
		expect(screen.getByTestId("file-menu-src").getAttribute("tabindex")).toBe("-1");
	});

	/** Issue #366: Shift+F10 and the Menu key open the focused row's menu. */
	it.each([
		{ key: "F10", shiftKey: true },
		{ key: "ContextMenu", shiftKey: false },
	])("opens the row menu from the focused row on $key", async (press) => {
		renderPane();
		const row = await screen.findByTestId("file-row-README.md");
		row.focus();

		fireEvent.keyDown(row, press);

		expect(
			await screen.findByRole("menu", { name: "Actions for README.md" }),
		).toBeDefined();
		expect(screen.getByTestId("row-rename")).toBeDefined();
	});

	/**
	 * Issue #358: a dialog opened from the row menu returns focus to the menu's
	 * button, which is not a Tab stop, so the button hands it to its row.
	 */
	it("hands focus given to a row's menu button on to the row", async () => {
		renderPane();
		const row = await screen.findByTestId("file-row-README.md");

		screen.getByTestId("file-menu-README.md").focus();

		expect(document.activeElement).toBe(row);
	});

	it("tells a screen reader how to open the row menu", async () => {
		renderPane();
		const tree = await screen.findByTestId("file-tree");
		const id = tree.getAttribute("aria-describedby") ?? "";

		expect(document.getElementById(id)?.textContent).toContain("Shift+F10");
	});

	/** Issue #370: a file moves into a folder without a drag. */
	it("moves a file into a folder picked in the Move to dialog", async () => {
		const moves: unknown[] = [];
		stubFetch((url, init) => {
			if (url.endsWith("/move")) {
				moves.push(JSON.parse(String(init?.body)));
				return json(204, null);
			}
			if (url.includes("/terminals")) return json(200, { terminals: [] });
			if (url.includes("/git/status")) return json(200, gitStatus);
			if (url.includes("/tree?path=src")) return json(200, SRC);
			if (url.includes("/tree?path=")) return json(200, ROOT);
			throw new Error(`unexpected request: ${url}`);
		});
		renderPane();
		fireEvent.keyDown(await screen.findByTestId("file-menu-README.md"), {
			key: "Enter",
		});
		fireEvent.click(await screen.findByTestId("row-move"));

		const dialog = await screen.findByTestId("dialog-move-file");
		// Where it already is is not a place to move it to.
		const confirm = within(dialog).getByTestId("dialog-confirm") as HTMLButtonElement;
		expect(confirm.disabled).toBe(true);
		fireEvent.click(await within(dialog).findByTestId("move-folder-src"));
		expect(within(dialog).getByTestId("move-destination").textContent).toContain("src");
		fireEvent.click(within(dialog).getByTestId("dialog-confirm"));

		await waitFor(() =>
			expect(moves).toEqual([{ from: "README.md", to: "src/README.md" }]),
		);
	});

	it("does not offer a folder as a place to move itself", async () => {
		renderPane();
		fireEvent.keyDown(await screen.findByTestId("file-menu-src"), { key: "Enter" });
		fireEvent.click(await screen.findByTestId("row-move"));

		const dialog = await screen.findByTestId("dialog-move-file");
		await within(dialog).findByTestId("move-folder-node_modules");
		expect(within(dialog).queryByTestId("move-folder-src")).toBeNull();
	});
});
