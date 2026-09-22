/**
 * The Checks pane (SPEC.md §18.1): the configured commands, their state, and
 * a project with no checks file that is still usable.
 */
import type { Project } from "@portikus/contracts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { renderWithQuery } from "../test-utils.js";
import { ChecksPane } from "./ChecksPane.js";

const WORKSPACE = "22222222-2222-4222-8222-222222222222";
const PROJECT = "44444444-4444-4444-8444-444444444444";

const CHECKS = [
	{ id: "tests", name: "Tests", command: "npm test" },
	{ id: "lint", name: "Lint", command: "npm run lint" },
];

function project(): Project {
	return {
		id: PROJECT,
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
	} as Project;
}

/** xterm.js needs these, and jsdom has neither. */
function stubBrowserApis() {
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
			onmessage: ((event: { data: unknown }) => void) | null = null;
			constructor(public url: string) {}
			send() {}
			close() {}
		},
	);
}

function stubChecks(body: unknown, calls: { url: string; method: string }[] = []) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			calls.push({ url, method: init?.method ?? "GET" });
			if (init?.method === "POST") {
				return new Response(
					JSON.stringify({
						id: "run-1",
						checkId: "tests",
						state: "running",
						startedAt: "2026-01-01T00:00:00.000Z",
					}),
					{ status: 201, headers: { "content-type": "application/json" } },
				);
			}
			return new Response(JSON.stringify(body), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}),
	);
}

afterEach(() => {
	cleanup();
	sessionStorage.clear();
	vi.unstubAllGlobals();
});

test("a project with no checks file offers to configure some", async () => {
	stubBrowserApis();
	stubChecks({ checks: [], error: null, runs: [] });
	renderWithQuery(<ChecksPane workspaceId={WORKSPACE} project={project()} />);

	await waitFor(() => expect(screen.getByText("No checks configured")).toBeTruthy());
	expect(screen.getByTestId("checks-empty-edit")).toBeTruthy();
	expect(screen.queryByRole("separator")).toBeNull();
});

test("each check shows its name, its real command, and what it last did", async () => {
	stubBrowserApis();
	stubChecks({
		checks: CHECKS,
		error: null,
		runs: [
			{
				id: "run-1",
				checkId: "tests",
				state: "failed",
				startedAt: "2026-01-01T00:00:00.000Z",
				endedAt: "2026-01-01T00:00:01.000Z",
				exitCode: 1,
			},
		],
	});
	renderWithQuery(<ChecksPane workspaceId={WORKSPACE} project={project()} />);

	await waitFor(() => expect(screen.getByTestId("checks-list")).toBeTruthy());
	// The command is never hidden from the student (SPEC.md §18.1).
	expect(screen.getByText("npm test")).toBeTruthy();
	expect(screen.getByText("npm run lint")).toBeTruthy();
	expect(screen.getByTestId("check-state-tests").textContent).toContain("Failed");
	expect(screen.getByTestId("check-state-lint").textContent).toContain("Not run yet");
});

test("the check whose output shows is marked current for screen readers (issue #369)", async () => {
	stubBrowserApis();
	stubChecks({ checks: CHECKS, error: null, runs: [] });
	renderWithQuery(<ChecksPane workspaceId={WORKSPACE} project={project()} />);

	await waitFor(() => expect(screen.getByTestId("checks-list")).toBeTruthy());
	const face = (id: string) =>
		screen.getByTestId(`check-item-${id}`).querySelector(".pk-check-face");
	expect(face("tests")?.getAttribute("aria-current")).toBe("true");
	expect(face("lint")?.getAttribute("aria-current")).toBeNull();

	fireEvent.click(face("lint") as Element);

	expect(face("lint")?.getAttribute("aria-current")).toBe("true");
	expect(face("tests")?.getAttribute("aria-current")).toBeNull();
});

test("a check that is running offers Stop instead of Run", async () => {
	stubBrowserApis();
	stubChecks({
		checks: CHECKS,
		error: null,
		runs: [
			{
				id: "run-1",
				checkId: "tests",
				state: "running",
				startedAt: "2026-01-01T00:00:00.000Z",
			},
		],
	});
	renderWithQuery(<ChecksPane workspaceId={WORKSPACE} project={project()} />);

	await waitFor(() => expect(screen.getByTestId("check-stop-tests")).toBeTruthy());
	expect(screen.queryByTestId("check-run-tests")).toBeNull();
	expect(screen.getByTestId("check-run-lint")).toBeTruthy();
});

test("Run posts a run for that check", async () => {
	stubBrowserApis();
	const calls: { url: string; method: string }[] = [];
	stubChecks({ checks: CHECKS, error: null, runs: [] }, calls);
	renderWithQuery(<ChecksPane workspaceId={WORKSPACE} project={project()} />);

	await waitFor(() => expect(screen.getByTestId("check-run-tests")).toBeTruthy());
	fireEvent.click(screen.getByTestId("check-run-tests"));

	await waitFor(() =>
		expect(
			calls.some(
				(call) =>
					call.method === "POST" &&
					call.url === `/workspaces/${WORKSPACE}/projects/${PROJECT}/checks/tests/runs`,
			),
		).toBe(true),
	);
});

test("a broken checks file is reported without stopping the pane", async () => {
	stubBrowserApis();
	stubChecks({
		checks: [],
		error: ".portikus/checks.json is not valid JSON.",
		runs: [],
	});
	renderWithQuery(<ChecksPane workspaceId={WORKSPACE} project={project()} />);

	await waitFor(() =>
		expect(screen.getByTestId("checks-file-error").textContent).toContain(
			"not valid JSON",
		),
	);
	expect(screen.getByText("No checks configured")).toBeTruthy();
});

test("Run and Stop are icon buttons that name their check (issue #274)", async () => {
	stubBrowserApis();
	stubChecks({
		checks: CHECKS,
		error: null,
		runs: [
			{
				id: "run-1",
				checkId: "tests",
				state: "running",
				startedAt: "2026-01-01T00:00:00.000Z",
			},
		],
	});
	renderWithQuery(<ChecksPane workspaceId={WORKSPACE} project={project()} />);

	await waitFor(() => expect(screen.getByTestId("check-stop-tests")).toBeTruthy());
	const stop = screen.getByTestId("check-stop-tests");
	const run = screen.getByTestId("check-run-lint");
	expect(stop.getAttribute("aria-label")).toBe("Stop Tests");
	expect(run.getAttribute("aria-label")).toBe("Run Lint");
	// An icon, not a word: the button holds no text.
	expect(run.textContent).toBe("");
	// Colour is a class on top of the name, not a different control (issue #324).
	expect(stop.classList.contains("pk-check-stop")).toBe(true);
	expect(run.classList.contains("pk-check-run")).toBe(true);
});

test("a long command keeps the whole of it in a tooltip (issue #274)", async () => {
	stubBrowserApis();
	const long = `docker run --rm -p 8080:80 --name bar-project ${"x".repeat(80)}`;
	stubChecks({
		checks: [{ id: "tests", name: "Tests", command: long }],
		error: null,
		runs: [],
	});
	renderWithQuery(<ChecksPane workspaceId={WORKSPACE} project={project()} />);

	await waitFor(() => expect(screen.getByTestId("checks-list")).toBeTruthy());
	expect(screen.getByText(long).getAttribute("title")).toBe(long);
});

test("the output divider is a keyboard-focusable handle and keeps its height", async () => {
	const key = "react-resizable-panels:pk-checks-output";
	const saved = JSON.stringify({
		"pk-checks-output-list": 70,
		"pk-checks-output-panel": 30,
	});
	sessionStorage.setItem(key, saved);
	stubBrowserApis();
	stubChecks({
		checks: [{ id: "tests", name: "Tests", command: "npm test" }],
		error: null,
		runs: [],
	});
	renderWithQuery(<ChecksPane workspaceId={WORKSPACE} project={project()} />);

	await waitFor(() => expect(screen.getByTestId("checks-list")).toBeTruthy());
	const handle = screen.getByRole("separator", { name: "Resize output" });
	expect(handle.getAttribute("tabindex")).toBe("0");
	expect(handle.className).toContain("pk-handle");
	// Mounting must not replace the height kept for this browser session.
	expect(sessionStorage.getItem(key)).toBe(saved);
	expect(document.getElementById("pk-checks-output-panel")?.style.flexGrow).toBe("30");
});
