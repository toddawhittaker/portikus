/**
 * The right pane's two states and the find-in-files shortcut (SPEC.md §8.4,
 * §11.5). Without a project there is nothing to search, so the shortcut does
 * nothing at all.
 */
import type { Project } from "@portikus/contracts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { renderWithQuery } from "../test-utils.js";
import { FilesPane } from "./FilesPane.js";

const WORKSPACE = "22222222-2222-4222-8222-222222222222";

function project(overrides: Partial<Project> = {}): Project {
	return {
		id: "44444444-4444-4444-8444-444444444444",
		workspaceId: WORKSPACE,
		slug: "todo-api",
		name: "todo-api",
		path: "/home/student/projects/todo-api",
		state: "active",
		source: "new",
		isGitRepo: false,
		missing: false,
		createdAt: "2026-01-01T00:00:00.000Z",
		archivedAt: null,
		...overrides,
	} as Project;
}

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

function pressFindInFiles() {
	fireEvent.keyDown(window, { key: "F", ctrlKey: true, shiftKey: true });
}

test("the find-in-files shortcut does nothing when no project is open", () => {
	renderWithQuery(<FilesPane workspaceId={WORKSPACE} project={undefined} />);

	pressFindInFiles();

	expect(screen.queryByTestId("search-panel")).toBeNull();
	expect(screen.getByText("No project open")).toBeTruthy();
});

test("the find-in-files shortcut opens the search when a project is open", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async () =>
				new Response(JSON.stringify({ entries: [], matches: [], truncated: false }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		),
	);
	renderWithQuery(<FilesPane workspaceId={WORKSPACE} project={project()} />);

	pressFindInFiles();

	await waitFor(() => expect(screen.getByTestId("search-panel")).toBeTruthy());
});
