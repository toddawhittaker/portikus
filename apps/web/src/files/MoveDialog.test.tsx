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

const MORE = "Show more folders";

test("a folder past the first page is reached through the Show more folders button", async () => {
	const trees: string[] = [];
	paged(trees);
	const onMove = renderDialog();
	await screen.findByTestId("move-folder-b");
	expect(screen.queryByTestId("move-folder-c")).toBeNull();
	// Not "No folders here": the listing is not finished.
	expect(screen.queryByText("No folders here.")).toBeNull();

	// A plain button in the list area, with no tree around it and no count.
	const more = screen.getByRole("button", { name: MORE });
	expect(more.closest("[role=tree]")).toBeNull();
	expect(screen.queryByRole("tree")).toBeNull();
	expect(screen.queryByRole("treeitem")).toBeNull();
	expect(screen.queryByText(/shown/)).toBeNull();
	fireEvent.click(more);

	const later = await screen.findByTestId("move-folder-c");
	// The new page is reached, the button is gone, and the keyboard stays in the list.
	expect(screen.queryByRole("button", { name: MORE })).toBeNull();
	await waitFor(() => expect(document.activeElement).toBe(later));
	fireEvent.click(later);
	expect(screen.getByTestId("move-destination").textContent).toContain("/c");
	expect(trees.some((url) => url.includes("path=c"))).toBe(true);
	fireEvent.click(screen.getByTestId("dialog-confirm"));
	expect(onMove).toHaveBeenCalledWith("c");
});

test("the button stays focusable but inert while the next page loads", async () => {
	let release: (response: Response) => void = () => {};
	let nextPages = 0;
	stubFetch((url) => {
		if (!url.includes("after=")) {
			return json(200, { entries: [dir("a")], truncated: true, next: "d/a" });
		}
		nextPages += 1;
		return new Promise<Response>((resolve) => {
			release = resolve;
		});
	});
	renderDialog();
	const more = await screen.findByRole("button", { name: MORE });
	more.focus();
	fireEvent.click(more);
	await waitFor(() => expect(more.getAttribute("aria-disabled")).toBe("true"));
	fireEvent.click(more);
	expect(document.activeElement).toBe(more);
	release(json(200, { entries: [dir("b")], truncated: false }));
	await screen.findByTestId("move-folder-b");
	expect(nextPages).toBe(1);
});

test("Enter on the Show more folders button loads the next page", async () => {
	paged([]);
	renderDialog();
	const more = await screen.findByRole("button", { name: MORE });
	more.focus();
	// A real browser turns Enter on a button into a click.
	fireEvent.click(more);
	await screen.findByTestId("move-folder-c");
});

test("a last page with no new folder focuses the last folder", async () => {
	stubFetch((url) =>
		url.includes("after=")
			? json(200, { entries: [file("z.txt")], truncated: false })
			: json(200, { entries: [dir("a")], truncated: true, next: "d/a" }),
	);
	renderDialog();
	fireEvent.click(await screen.findByRole("button", { name: MORE }));
	await waitFor(() => expect(screen.queryByRole("button", { name: MORE })).toBeNull());
	await waitFor(() =>
		expect(document.activeElement).toBe(screen.getByTestId("move-folder-a")),
	);
});

test("a page with no new folder, still cut short, keeps focus on the button and says so", async () => {
	stubFetch((url) => {
		if (url.includes("after=d%2Fa")) {
			return json(200, { entries: [file("y.txt")], truncated: true, next: "f/y.txt" });
		}
		if (url.includes("after=")) {
			return json(200, { entries: [dir("c")], truncated: false });
		}
		return json(200, { entries: [dir("a")], truncated: true, next: "d/a" });
	});
	renderDialog();
	const more = await screen.findByRole("button", { name: MORE });
	more.focus();
	fireEvent.click(more);
	await waitFor(() =>
		expect(screen.getByRole("status").textContent).toBe(
			"No folders in the next page; more entries remain.",
		),
	);
	expect(document.activeElement).toBe(more);

	// The next page does bring a folder, which takes focus and clears the notice.
	fireEvent.click(more);
	const later = await screen.findByTestId("move-folder-c");
	await waitFor(() => expect(document.activeElement).toBe(later));
	expect(screen.getByRole("status").textContent).toBe("");
});

test("a page that lands after the student opened another folder pulls no focus", async () => {
	let release: (response: Response) => void = () => {};
	stubFetch((url) => {
		// The folder opened holds a folder with the same name as the late page's.
		if (url.includes("path=a")) {
			return json(200, { entries: [dir("b")], truncated: false });
		}
		if (url.includes("after=")) {
			return new Promise<Response>((resolve) => {
				release = resolve;
			});
		}
		return json(200, { entries: [dir("a")], truncated: true, next: "d/a" });
	});
	renderDialog();
	fireEvent.click(await screen.findByRole("button", { name: MORE }));
	fireEvent.click(screen.getByTestId("move-folder-a"));
	const inside = await screen.findByTestId("move-folder-a/b");
	release(json(200, { entries: [dir("b")], truncated: false }));
	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(document.activeElement).not.toBe(inside);
});

test("a short listing has no Show more folders button, and an empty one says so", async () => {
	stubFetch(() => json(200, { entries: [file("a.txt")], truncated: false }));
	renderDialog();
	await screen.findByText("No folders here.");
	expect(screen.queryByRole("button", { name: MORE })).toBeNull();
});
