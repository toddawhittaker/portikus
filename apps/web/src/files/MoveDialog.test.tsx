/**
 * The Move to dialog lists a folder's sub-folders a page at a time, as the
 * tree does, so a folder past one listing page can still be reached
 * (SPEC.md §11.2, §25.8).
 */
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderWithQuery, stubFetch } from "../test-utils.js";
import { MoveDialog } from "./MoveDialog.js";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

function dir(name: string) {
	return { name, type: "dir" as const, size: 0, mtimeMs: 0 };
}
function file(name: string) {
	return { name, type: "file" as const, size: 0, mtimeMs: 0 };
}

function renderDialog(onMove = vi.fn()) {
	renderWithQuery(
		<MoveDialog
			workspaceId="ws-1"
			projectId="p-1"
			slug="demo"
			nodes={[{ path: "a.txt", name: "a.txt", isDir: false }]}
			showHidden={false}
			onMove={onMove}
			onClose={() => {}}
		/>,
	);
	return onMove;
}

/** Page one ends at `d/b`; page two holds the later folders and a file. */
function paged(trees: string[]) {
	stubFetch((url) => {
		trees.push(url);
		if (url.includes("after=d%2Fb")) {
			return json(200, { entries: [dir("c"), file("z.txt")], truncated: false });
		}
		return json(200, { entries: [dir("a"), dir("b")], truncated: true, next: "d/b" });
	});
}

test("a folder past the first page is reached through the Show more row", async () => {
	const trees: string[] = [];
	paged(trees);
	const onMove = renderDialog();
	await screen.findByTestId("move-folder-b");
	expect(screen.queryByTestId("move-folder-c")).toBeNull();
	// Not "No folders here": the listing is not finished.
	expect(screen.queryByText("No folders here.")).toBeNull();

	const more = screen.getByTestId("file-tree-show-more");
	expect(more.getAttribute("role")).toBe("treeitem");
	expect(more.closest("[role=tree]")).not.toBeNull();
	expect(screen.getByTestId("file-tree-truncated").textContent).toContain(
		"2 entries shown",
	);
	fireEvent.click(more);

	const later = await screen.findByTestId("move-folder-c");
	// The new page is reached, the row is gone, and the keyboard stays in the list.
	expect(screen.queryByTestId("file-tree-show-more")).toBeNull();
	await waitFor(() => expect(document.activeElement).toBe(later));
	fireEvent.click(later);
	expect(screen.getByTestId("move-destination").textContent).toContain("/c");
	expect(trees.some((url) => url.includes("path=c"))).toBe(true);
	fireEvent.click(screen.getByTestId("dialog-confirm"));
	expect(onMove).toHaveBeenCalledWith("c");
});

test("Enter and Space on the Show more row load the next page", async () => {
	paged([]);
	renderDialog();
	const more = await screen.findByTestId("file-tree-show-more");
	more.focus();
	fireEvent.keyDown(more, { key: "Enter" });
	await screen.findByTestId("move-folder-c");
});

test("a last page with no new folder leaves focus in the list", async () => {
	stubFetch((url) =>
		url.includes("after=")
			? json(200, { entries: [file("z.txt")], truncated: false })
			: json(200, { entries: [dir("a")], truncated: true, next: "d/a" }),
	);
	renderDialog();
	fireEvent.click(await screen.findByTestId("file-tree-show-more"));
	await waitFor(() => expect(screen.queryByTestId("file-tree-show-more")).toBeNull());
	await waitFor(() =>
		expect(document.activeElement).toBe(screen.getByTestId("move-folder-a")),
	);
});

test("a short listing has no Show more row, and an empty one says so", async () => {
	stubFetch(() => json(200, { entries: [file("a.txt")], truncated: false }));
	renderDialog();
	await screen.findByText("No folders here.");
	expect(screen.queryByTestId("file-tree-show-more")).toBeNull();
});
