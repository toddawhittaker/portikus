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

test("the right pane switches between Files and Checks", async () => {
	// xterm.js needs both of these, and jsdom has neither.
	vi.stubGlobal(
		"matchMedia",
		vi.fn(() => ({
			matches: false,
			media: "",
			onchange: null,
			addListener: vi.fn(),
			removeListener: vi.fn(),
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			dispatchEvent: () => false,
		})),
	);
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
	vi.stubGlobal(
		"WebSocket",
		class {
			static readonly OPEN = 1;
			readyState = 1;
			constructor(public url: string) {}
			send() {}
			close() {}
		},
	);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			const body = url.includes("/checks")
				? {
						checks: [{ id: "tests", name: "Tests", command: "npm test" }],
						error: null,
						runs: [],
					}
				: { entries: [], truncated: false };
			return new Response(JSON.stringify(body), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}),
	);
	renderWithQuery(<FilesPane workspaceId={WORKSPACE} project={project()} />);

	await waitFor(() => expect(screen.getByTestId("file-tree-body")).toBeTruthy());

	fireEvent.click(screen.getByTestId("right-pane-tab-checks"));
	await waitFor(() => expect(screen.getByTestId("checks-list")).toBeTruthy());
	expect(screen.queryByTestId("file-tree-body")).toBeNull();

	fireEvent.click(screen.getByTestId("right-pane-tab-files"));
	await waitFor(() => expect(screen.getByTestId("file-tree-body")).toBeTruthy());
});

test("the Monitor tab sits with the others and shows usage", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			const body = url.includes("/usage")
				? {
						observedAt: "2026-01-01T00:00:00.000Z",
						cpuPercent: 3,
						memory: { usedBytes: 1024, totalBytes: 2048 },
						disk: { usedBytes: 1024, totalBytes: 4096 },
						network: { receiveBytesPerSecond: null, transmitBytesPerSecond: null },
						processes: [],
					}
				: { entries: [], truncated: false };
			return new Response(JSON.stringify(body), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}),
	);
	renderWithQuery(<FilesPane workspaceId={WORKSPACE} project={project()} />);
	fireEvent.click(screen.getByTestId("right-pane-tab-monitor"));
	await waitFor(() =>
		expect(screen.getByTestId("monitor-cpu").textContent).toBe("3.0%"),
	);
	expect(screen.queryByTestId("file-tree-body")).toBeNull();
});
