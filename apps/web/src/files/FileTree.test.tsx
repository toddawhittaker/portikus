import { MAX_LAYOUT_TABS } from "@portikus/contracts";
import { ToastProvider } from "@portikus/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

function renderPane(store = createLayoutStore()) {
	const client = createQueryClient(() => {});
	render(
		<QueryClientProvider client={client}>
			<ToastProvider>
				<LayoutStoreContext.Provider value={store}>
					<FileTreePane workspaceId={WORKSPACE.id} project={PROJECT} />
				</LayoutStoreContext.Provider>
			</ToastProvider>
		</QueryClientProvider>,
	);
	return store;
}

beforeEach(() => {
	// The view store outlives a test, so each one starts from a closed tree.
	useFileViewStore.setState({ byProject: {} });
	stubFetch((url) => {
		if (url.includes("/tree?path=src")) return json(200, SRC);
		if (url.includes("/tree?path=")) return json(200, ROOT);
		throw new Error(`unexpected request: ${url}`);
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("the file tree", () => {
	/** SPEC.md §11.3. */
	it("hides generated and dotted names until Show hidden is on", async () => {
		renderPane();

		expect(await screen.findByText("README.md")).toBeDefined();
		expect(screen.getByText("src")).toBeDefined();
		expect(screen.queryByText(".env")).toBeNull();
		expect(screen.queryByText("node_modules")).toBeNull();

		fireEvent.keyDown(screen.getByTestId("files-more"), { key: "Enter" });
		fireEvent.click(await screen.findByText("Show hidden and generated files"));

		expect(await screen.findByText(".env")).toBeDefined();
		expect(screen.getByText("node_modules")).toBeDefined();
	});

	/** SPEC.md §11.2: a directory is fetched when it is expanded. */
	it("fetches a directory's contents when it is expanded", async () => {
		renderPane();
		expect(await screen.findByText("src")).toBeDefined();
		expect(screen.queryByText("app.ts")).toBeNull();

		fireEvent.click(screen.getByText("src"));

		expect(await screen.findByText("app.ts")).toBeDefined();
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

	it("says so when there is no room for another tab", async () => {
		const store = createLayoutStore();
		store.getState().load({
			tabs: Array.from({ length: MAX_LAYOUT_TABS }, (_item, index) => ({
				id: `file:full-${index}.txt`,
				root: { type: "file" as const, path: `full-${index}.txt` },
			})),
		});
		renderPane(store);

		fireEvent.click(await screen.findByText("README.md"));

		expect(
			await screen.findByText("Too many tabs are open. Close one to open another."),
		).toBeDefined();
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
});
