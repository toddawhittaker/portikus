/**
 * What the Changes list says before it knows anything, and when the status
 * could not be read (SPEC.md §12.6). It must never claim there are no
 * changes when it simply has not been told.
 */
import type { GitStatus } from "@portikus/contracts";
import { ToastProvider } from "@portikus/ui";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { createLayoutStore, LayoutStoreContext } from "../layout/store.js";
import { json, project, renderWithQuery, stubFetch, WORKSPACE } from "../test-utils.js";
import { ChangesList } from "./ChangesList.js";
import { sessionReviewLabel } from "./sessionReview.js";

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

test("a session review names the agent session, not the last commit", () => {
	const store = createLayoutStore();
	render(
		<ToastProvider>
			<LayoutStoreContext.Provider value={store}>
				<ChangesList
					projectId="pid"
					status={EMPTY}
					sessionLabel={sessionReviewLabel("claude")}
				/>
			</LayoutStoreContext.Provider>
		</ToastProvider>,
	);
	expect(screen.getByTestId("changes-title").textContent).toBe(
		"Changes since Claude session started",
	);
	expect(screen.getByTestId("changes-empty").textContent).toBe(
		"No changes since this session started",
	);
	expect(screen.queryByText("No changes since the last commit")).toBeNull();
	expect(sessionReviewLabel("codex")).toBe("Changes since Codex session started");
});

test("switching review mode moves focus and announces the new heading", () => {
	function Harness() {
		const [review, setReview] = useState(false);
		return (
			<ChangesList
				projectId="pid"
				status={EMPTY}
				sessionLabel={review ? sessionReviewLabel("claude") : undefined}
				onReviewSession={review ? undefined : () => setReview(true)}
				onShowGit={review ? () => setReview(false) : undefined}
			/>
		);
	}
	const store = createLayoutStore();
	render(
		<ToastProvider>
			<LayoutStoreContext.Provider value={store}>
				<Harness />
			</LayoutStoreContext.Provider>
		</ToastProvider>,
	);

	const title = screen.getByTestId("changes-title");
	expect(title.getAttribute("aria-live")).toBe("polite");
	fireEvent.click(screen.getByTestId("review-session"));
	expect(title.textContent).toBe("Changes since Claude session started");
	expect(document.activeElement).toBe(screen.getByTestId("show-git-changes"));

	fireEvent.click(screen.getByTestId("show-git-changes"));
	expect(title.textContent).toBe("Changes (0)");
	expect(document.activeElement).toBe(screen.getByTestId("review-session"));
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

test("the row whose file is the tab on show is marked selected (issue #274)", () => {
	const store = show({
		...EMPTY,
		entries: [
			{ path: "src/app.ts", x: ".", y: "M", unmerged: false },
			{ path: "src/other.ts", x: ".", y: "M", unmerged: false },
		],
	});

	fireEvent.click(screen.getByTestId("change-row-src/app.ts"));

	expect(store.getState().activeTabId).toBe("file:src/app.ts");
	expect(
		screen.getByTestId("change-row-src/app.ts").getAttribute("data-selected"),
	).toBe("true");
	expect(
		screen.getByTestId("change-row-src/other.ts").getAttribute("data-selected"),
	).toBeNull();
	// Screen readers hear which row is current, not only see a tint (issue #369).
	expect(screen.getByTestId("change-row-src/app.ts").getAttribute("aria-current")).toBe(
		"true",
	);
	expect(
		screen.getByTestId("change-row-src/other.ts").getAttribute("aria-current"),
	).toBeNull();
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

const PROJECT = project();
const POINT_ID = "55555555-5555-4555-8555-555555555555";

function showSession(points: { id: string }[], sessionLabel?: string) {
	stubFetch(() =>
		json(200, {
			points: points.map((point) => ({
				projectId: PROJECT.id,
				createdAt: "2026-09-20T10:15:00.000Z",
				reason: "agent-session",
				sizeBytes: 10,
				expiresAt: "2026-10-04T10:15:00.000Z",
				...point,
			})),
			usage: { usedBytes: 10, quotaBytes: 100 },
		}),
	);
	renderWithQuery(
		<LayoutStoreContext.Provider value={createLayoutStore()}>
			<ChangesList
				projectId={PROJECT.id}
				status={EMPTY}
				sessionLabel={sessionLabel}
				sessionRestore={{
					workspaceId: WORKSPACE.id,
					project: PROJECT,
					pointId: POINT_ID,
				}}
			/>
		</LayoutStoreContext.Provider>,
	);
}

afterEach(() => vi.unstubAllGlobals());

test("the session review offers Restore to before this session, confirmed with the project", async () => {
	showSession([{ id: POINT_ID }], sessionReviewLabel("claude"));

	fireEvent.click(await screen.findByTestId("restore-session"));

	const dialog = screen.getByTestId("dialog-restore-point");
	expect(dialog.textContent).toContain(`Restore ${PROJECT.name} to`);
});

test("no restore action outside the session review or once the point is gone", async () => {
	showSession([{ id: POINT_ID }]);
	expect(screen.queryByTestId("restore-session")).toBeNull();
});

test("a session whose point has expired offers no restore", async () => {
	showSession([], sessionReviewLabel("codex"));
	// Let the list arrive before checking that nothing appeared.
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(screen.queryByTestId("restore-session")).toBeNull();
});
