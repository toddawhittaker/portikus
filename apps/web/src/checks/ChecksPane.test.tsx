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
	vi.unstubAllGlobals();
});

test("a project with no checks file offers to configure some", async () => {
	stubBrowserApis();
	stubChecks({ checks: [], error: null, runs: [] });
	renderWithQuery(<ChecksPane workspaceId={WORKSPACE} project={project()} />);

	await waitFor(() => expect(screen.getByText("No checks configured")).toBeTruthy());
	expect(screen.getByTestId("checks-empty-edit")).toBeTruthy();
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
