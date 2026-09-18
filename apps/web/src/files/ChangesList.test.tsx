/**
 * What the Changes list says before it knows anything, and when the status
 * could not be read (SPEC.md §12.6). It must never claim there are no
 * changes when it simply has not been told.
 */
import type { GitStatus } from "@portikus/contracts";
import { ToastProvider } from "@portikus/ui";
import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { createLayoutStore, LayoutStoreContext } from "../layout/store.js";
import { ChangesList } from "./ChangesList.js";

function show(status: GitStatus | undefined, error = false) {
	render(
		<ToastProvider>
			<LayoutStoreContext.Provider value={createLayoutStore()}>
				<ChangesList projectId="pid" status={status} error={error} />
			</LayoutStoreContext.Provider>
		</ToastProvider>,
	);
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
