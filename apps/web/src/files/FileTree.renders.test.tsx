import { ToastProvider } from "@portikus/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createQueryClient } from "../api/queryClient.js";
import { createLayoutStore, LayoutStoreContext } from "../layout/store.js";
import { json, project, stubFetch, WORKSPACE } from "../test-utils.js";
import { FileTreePane } from "./FileTree.js";
import { useFileViewStore } from "./store.js";

// Every file row asks for its icon once per render, so counting the calls
// counts row renders without a hook in the component.
const iconCalls = vi.hoisted(() => new Map<string, number>());
vi.mock("./fileIcon.js", async (importOriginal) => {
	const real = await importOriginal<typeof import("./fileIcon.js")>();
	return {
		...real,
		fileIconName: (name: string) => {
			iconCalls.set(name, (iconCalls.get(name) ?? 0) + 1);
			return real.fileIconName(name);
		},
	};
});

const PROJECT = project();

function names(from: number, count: number): string[] {
	return Array.from({ length: count }, (_, index) => `f${String(from + index)}.txt`);
}

const entry = (name: string) => ({ name, type: "file", size: 0, mtimeMs: 0 });

/** Lets queued queries and effects finish, so late renders are counted too. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

beforeEach(() => {
	useFileViewStore.setState({ byProject: {} });
	iconCalls.clear();
	stubFetch((url) => {
		if (url.includes("/terminals")) return json(200, { terminals: [] });
		if (url.includes("/git/status")) return json(200, { repo: false });
		if (url.includes("after=")) {
			return json(200, { entries: names(20, 20).map(entry), truncated: false });
		}
		return json(200, {
			entries: names(0, 20).map(entry),
			truncated: true,
			next: "f/f19.txt",
		});
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
});

/** SPEC.md §11.2: loading the next page of a long folder draws only the new rows. */
it("does not redraw the rows already on screen when Show more loads entries", async () => {
	render(
		<QueryClientProvider client={createQueryClient()}>
			<ToastProvider>
				<LayoutStoreContext.Provider value={createLayoutStore()}>
					<FileTreePane
						workspaceId={WORKSPACE.id}
						project={PROJECT}
						onSearch={() => {}}
					/>
				</LayoutStoreContext.Provider>
			</ToastProvider>
		</QueryClientProvider>,
	);
	const more = await screen.findByTestId("file-tree-show-more");
	// The Tab stop moves to Show more first, so the first row's own redraw
	// for losing it is not counted.
	more.focus();
	await waitFor(() => expect(more.getAttribute("tabindex")).toBe("0"));
	await settle();
	const before = new Map(iconCalls);

	fireEvent.keyDown(more, { key: "Enter" });
	await waitFor(() =>
		expect(document.activeElement).toBe(screen.getByTestId("file-row-f20.txt")),
	);
	await settle();

	const redrawn = names(0, 20).filter(
		(name) => (iconCalls.get(name) ?? 0) !== (before.get(name) ?? 0),
	);
	expect(redrawn).toEqual([]);
	// The new rows are drawn, and not over and over.
	for (const name of names(20, 20)) {
		expect(iconCalls.get(name) ?? 0).toBeGreaterThan(0);
		expect(iconCalls.get(name) ?? 0).toBeLessThanOrEqual(2);
	}
});
