/**
 * The right pane's two states and the find-in-files shortcut (SPEC.md §8.4,
 * §11.5). Without a project there is nothing to search, so the shortcut does
 * nothing at all.
 */
import type { Project } from "@portikus/contracts";
import { ToastProvider } from "@portikus/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createQueryClient } from "../api/queryClient.js";
import { type Problem, useCodeHelpStore } from "../lsp/store.js";
import { DEFAULT_PROCESS_SORT } from "../monitor/sort.js";
import { renderWithQuery } from "../test-utils.js";
import { FilesPane } from "./FilesPane.js";
import {
	type RightPane,
	RightPaneContext,
	showMonitor,
	useRightPaneStore,
} from "./rightPane.js";

// The site switch for code help comes from /me/settings; these tests set it directly.
const codeHelp = vi.hoisted(() => ({ on: false }));
vi.mock("../editor/settingsQueries.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../editor/settingsQueries.js")>()),
	useCodeHelpEnabled: () => codeHelp.on,
}));

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

beforeEach(() => {
	codeHelp.on = false;
	useCodeHelpStore.setState({ problems: {}, status: {} });
});

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
						storage: { home: null, docker: null, recovery: null },
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

/** Answers every request with an empty listing, so the tree renders. */
function stubEmpty() {
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async () =>
				new Response(JSON.stringify({ entries: [], truncated: false }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		),
	);
}

test("the switcher is one tab stop, the arrows move along it, and each tab controls a panel", async () => {
	stubEmpty();
	renderWithQuery(<FilesPane workspaceId={WORKSPACE} project={project()} />);

	const files = screen.getByRole("tab", { name: "Files" });
	const checks = screen.getByRole("tab", { name: "Checks" });
	// The strip is the one Tab stop; entering it lands on the selected tab.
	const strip = screen.getByRole("tablist");
	expect(strip.getAttribute("tabindex")).toBe("0");
	for (const tab of screen.getAllByRole("tab")) {
		expect(tab.getAttribute("tabindex")).toBe("-1");
	}
	fireEvent.focus(strip);
	await waitFor(() => expect(document.activeElement).toBe(files));
	const panel = screen.getByRole("tabpanel");
	expect(files.getAttribute("aria-controls")).toBe(panel.id);
	expect(panel.getAttribute("aria-labelledby")).toBe(files.id);

	files.focus();
	fireEvent.keyDown(files, { key: "ArrowRight" });

	await waitFor(() => expect(document.activeElement).toBe(checks));
	expect(checks.getAttribute("aria-selected")).toBe("true");
	fireEvent.keyDown(checks, { key: "End" });
	await waitFor(() =>
		expect(
			screen.getByRole("tab", { name: "Monitor" }).getAttribute("aria-selected"),
		).toBe("true"),
	);
});

test("closing find in files returns focus to its button", async () => {
	stubEmpty();
	renderWithQuery(<FilesPane workspaceId={WORKSPACE} project={project()} />);

	fireEvent.click(await screen.findByTestId("search-open"));
	fireEvent.click(await screen.findByTestId("search-close"));

	await waitFor(() =>
		expect(document.activeElement).toBe(screen.getByTestId("search-open")),
	);
});

/** A workspace screen stand-in whose pane choice a test can change from outside. */
function SharedPane({ onShow }: { onShow: (show: (pane: RightPane) => void) => void }) {
	const [pane, setPane] = useState<RightPane>("files");
	onShow(setPane);
	return (
		<RightPaneContext.Provider
			value={{
				pane,
				show: setPane,
				monitorSort: DEFAULT_PROCESS_SORT,
				setMonitorSort: () => {},
				monitorFocus: false,
				setMonitorFocus: () => {},
			}}
		>
			<FilesPane workspaceId={WORKSPACE} project={project()} />
		</RightPaneContext.Provider>
	);
}

test("closing find in files while another surface is chosen focuses that surface's tab", async () => {
	stubEmpty();
	let show: (pane: RightPane) => void = () => {};
	renderWithQuery(
		<SharedPane
			onShow={(fn) => {
				show = fn;
			}}
		/>,
	);

	fireEvent.click(await screen.findByTestId("search-open"));
	// A Preview tab can switch the pane to Running while the search is open.
	await act(async () => show("running"));
	fireEvent.click(await screen.findByTestId("search-close"));

	await waitFor(() =>
		expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Running" })),
	);
});

/** A workspace screen stand-in with the real shared pane state. */
function RealPane({
	onApi,
}: {
	onApi: (api: ReturnType<typeof useRightPaneStore>) => void;
}) {
	const api = useRightPaneStore();
	onApi(api);
	return (
		<RightPaneContext.Provider value={api}>
			<FilesPane workspaceId={WORKSPACE} project={project()} />
		</RightPaneContext.Provider>
	);
}

test("opened from a notice while find in files is open, the search closes and Monitor's tab takes focus", async () => {
	stubEmpty();
	let api = {} as ReturnType<typeof useRightPaneStore>;
	renderWithQuery(
		<RealPane
			onApi={(value) => {
				api = value;
			}}
		/>,
	);
	fireEvent.click(await screen.findByTestId("search-open"));
	expect(await screen.findByTestId("search-panel")).toBeTruthy();

	await act(async () => showMonitor(api, "memory"));

	expect(screen.queryByTestId("search-panel")).toBeNull();
	await waitFor(() =>
		expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Monitor" })),
	);
	expect(
		screen.getByRole("tab", { name: "Monitor" }).getAttribute("aria-selected"),
	).toBe("true");
	expect(api.monitorFocus).toBe(false);
});

const PROJECT_ID = "44444444-4444-4444-8444-444444444444";

function problem(overrides: Partial<Problem> = {}): Problem {
	return {
		path: "main.py",
		line: 3,
		column: 1,
		severity: "error",
		message: "Name is not defined",
		...overrides,
	};
}

test("the Problems tab is the fifth tab, with a count of the open files' problems", async () => {
	stubEmpty();
	codeHelp.on = true;
	renderWithQuery(<FilesPane workspaceId={WORKSPACE} project={project()} />);

	const tabs = screen.getAllByRole("tab").map((tab) => tab.textContent);
	expect(tabs).toEqual(["Files", "Checks", "Running", "Monitor", "Problems"]);
	// A count of zero is not shown.
	expect(screen.queryByTestId("right-pane-count-problems")).toBeNull();

	act(() => {
		useCodeHelpStore
			.getState()
			.setProblems(PROJECT_ID, "python", "main.py", [
				problem(),
				problem({ line: 8, severity: "warning" }),
				problem({ line: 9, severity: "info" }),
			]);
	});
	expect(screen.getByTestId("right-pane-count-problems").textContent).toBe("2");
	expect(screen.getByRole("tab", { name: "Problems 2" })).toBeTruthy();

	fireEvent.click(screen.getByTestId("right-pane-tab-problems"));
	expect(await screen.findByTestId("problems-list")).toBeTruthy();
	expect(screen.getByRole("tabpanel", { name: /^Problems/ })).toBeTruthy();
});

test("the Problems tab is not shown when code help is off", async () => {
	stubEmpty();
	renderWithQuery(<FilesPane workspaceId={WORKSPACE} project={project()} />);

	expect(screen.queryByRole("tab", { name: /Problems/ })).toBeNull();
});

test("the Problems tab is not shown with no project open", () => {
	codeHelp.on = true;
	renderWithQuery(<FilesPane workspaceId={WORKSPACE} project={undefined} />);

	expect(screen.queryByRole("tab", { name: /Problems/ })).toBeNull();
});

test("a pane left on Problems shows Files once code help is off", async () => {
	stubEmpty();
	codeHelp.on = true;
	const client = createQueryClient();
	const wrap = () => (
		<QueryClientProvider client={client}>
			<ToastProvider>
				<RealPaneOn />
			</ToastProvider>
		</QueryClientProvider>
	);
	const view = render(wrap());
	fireEvent.click(screen.getByTestId("right-pane-tab-problems"));
	expect(await screen.findByTestId("problems-empty")).toBeTruthy();

	codeHelp.on = false;
	view.rerender(wrap());

	expect(screen.queryByRole("tab", { name: /Problems/ })).toBeNull();
	expect(await screen.findByTestId("file-tree-body")).toBeTruthy();
	expect(screen.getByRole("tab", { name: "Files" }).getAttribute("aria-selected")).toBe(
		"true",
	);
});

function RealPaneOn() {
	const api = useRightPaneStore();
	return (
		<RightPaneContext.Provider value={api}>
			<FilesPane workspaceId={WORKSPACE} project={project()} />
		</RightPaneContext.Provider>
	);
}
