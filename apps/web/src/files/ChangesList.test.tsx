/**
 * What the Changes list says before it knows anything, and when the status
 * could not be read (SPEC.md §12.6). It must never claim there are no
 * changes when it simply has not been told.
 */
import type { GitStatus } from "@portikus/contracts";
import { ToastProvider } from "@portikus/ui";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { createLayoutStore, LayoutStoreContext } from "../layout/store.js";
import { ChangesList } from "./ChangesList.js";

function show(status: GitStatus | undefined, error = false) {
	const store = createLayoutStore();
	render(
		<ToastProvider>
			<LayoutStoreContext.Provider value={store}>
				<ChangesList projectId="pid" status={status} error={error} />
			</LayoutStoreContext.Provider>
		</ToastProvider>,
	);
	return store;
}

const EMPTY: GitStatus = {
	repo: true,
	branch: "main",
	detached: false,
	upstream: "origin/main",
	ahead: 0,
	behind: 0,
	conflicts: 0,
	entries: [],
	ignored: [],
	truncated: false,
};

test("before the first status arrives it says nothing about changes", () => {
	show(undefined);
	expect(screen.getByTestId("changes-title").textContent).toBe("Changes");
	expect(screen.queryByTestId("changes-empty")).toBeNull();
	expect(screen.queryByTestId("changes-list")).toBeNull();
	expect(screen.queryByTestId("changes-error")).toBeNull();
});

test("a failed status read is reported, not read as an empty repository", () => {
	show(undefined, true);
	expect(screen.getByTestId("changes-error").textContent).toBe(
		"Could not read Git status",
	);
	expect(screen.queryByTestId("changes-empty")).toBeNull();
});

test("a repository with nothing changed says so", () => {
	show(EMPTY);
	expect(screen.getByTestId("changes-title").textContent).toBe("Changes (0)");
	expect(screen.getByTestId("changes-empty").textContent).toBe(
		"No changes since the last commit",
	);
});

test("clicking a changed file opens its one tab, showing the diff", () => {
	// Issue #160: a file already open is switched to its diff, not opened
	// again, so one path never has two tabs (SPEC.md §8.3, §12.6).
	const store = show({
		...EMPTY,
		entries: [{ path: "src/app.ts", x: ".", y: "M", unmerged: false }],
	});
	store.getState().openFile("src/app.ts");

	fireEvent.click(screen.getByTestId("change-row-src/app.ts"));

	expect(store.getState().layout.tabs.map((tab) => tab.id)).toEqual([
		"file:src/app.ts",
	]);
	expect(store.getState().activeTabId).toBe("file:src/app.ts");
	expect(store.getState().consumePendingDiff("file:src/app.ts")).toBe(true);
});

test("clicking a changed file that is not open opens one tab in diff view", () => {
	const store = show({
		...EMPTY,
		entries: [{ path: "src/app.ts", x: ".", y: "M", unmerged: false }],
	});

	fireEvent.click(screen.getByTestId("change-row-src/app.ts"));

	expect(store.getState().layout.tabs.map((tab) => tab.id)).toEqual([
		"file:src/app.ts",
	]);
	expect(store.getState().consumePendingDiff("file:src/app.ts")).toBe(true);
});
