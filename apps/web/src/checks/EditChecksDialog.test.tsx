/**
 * Editing the project's checks (SPEC.md §18.1). The dialog writes the
 * student's own `.portikus/checks.json` through the file API, creating the
 * folder the first time.
 */
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { renderWithQuery } from "../test-utils.js";
import { definitionsOf, EditChecksDialog } from "./EditChecksDialog.js";

const WORKSPACE = "22222222-2222-4222-8222-222222222222";
const PROJECT = "44444444-4444-4444-8444-444444444444";
const FILE_URL = `/workspaces/${WORKSPACE}/projects/${PROJECT}/file?path=.portikus%2Fchecks.json`;

interface Call {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: string;
}

/** Answer the file API as an agent would, and record every call. */
function stubFileApi(fileExists: boolean): Call[] {
	const calls: Call[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			const method = init?.method ?? "GET";
			calls.push({
				url,
				method,
				headers: (init?.headers ?? {}) as Record<string, string>,
				body: String(init?.body ?? ""),
			});
			if (method === "GET") {
				if (!fileExists) return new Response("{}", { status: 404 });
				return new Response("{}", { status: 200, headers: { etag: "abc" } });
			}
			if (url.endsWith("/mkdir")) return new Response(null, { status: 201 });
			return new Response(JSON.stringify({ etag: "def", size: 1 }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}),
	);
	return calls;
}

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

test("a row without a name or a command is left out, and ids are slugs", () => {
	expect(
		definitionsOf([
			{ key: "a", name: "Unit Tests", command: "npm test" },
			{ key: "b", name: "", command: "npm run lint" },
			{ key: "c", name: "Build", command: "  " },
			{ key: "d", name: "Unit tests", command: "pytest" },
		]),
	).toEqual([{ id: "unit-tests", name: "Unit Tests", command: "npm test" }]);
});

test("saving into a project with no checks file creates the folder first", async () => {
	const calls = stubFileApi(false);
	renderWithQuery(
		<EditChecksDialog
			workspaceId={WORKSPACE}
			projectId={PROJECT}
			checks={[]}
			onClose={vi.fn()}
		/>,
	);

	fireEvent.change(screen.getByTestId("check-name-0"), { target: { value: "Tests" } });
	fireEvent.change(screen.getByTestId("check-command-0"), {
		target: { value: "npm test" },
	});
	fireEvent.click(screen.getByTestId("dialog-confirm"));

	await waitFor(() => expect(calls.some((call) => call.method === "PUT")).toBe(true));
	expect(calls.some((call) => call.url.endsWith("/mkdir"))).toBe(true);
	const write = calls.find((call) => call.method === "PUT");
	if (!write) throw new Error("nothing was written");
	expect(write.url).toBe(FILE_URL);
	// Creating: the write must not replace a file somebody else just made.
	expect(write.headers["if-none-match"]).toBe("*");
	expect(JSON.parse(write.body)).toEqual({
		checks: [{ id: "tests", name: "Tests", command: "npm test" }],
	});
});

test("saving over an existing file is conditional on the version just read", async () => {
	const calls = stubFileApi(true);
	renderWithQuery(
		<EditChecksDialog
			workspaceId={WORKSPACE}
			projectId={PROJECT}
			checks={[{ id: "tests", name: "Tests", command: "npm test" }]}
			onClose={vi.fn()}
		/>,
	);

	fireEvent.click(screen.getByTestId("check-add"));
	fireEvent.change(screen.getByTestId("check-name-1"), { target: { value: "Lint" } });
	fireEvent.change(screen.getByTestId("check-command-1"), {
		target: { value: "npm run lint" },
	});
	fireEvent.click(screen.getByTestId("dialog-confirm"));

	await waitFor(() => expect(calls.some((call) => call.method === "PUT")).toBe(true));
	expect(calls.some((call) => call.url.endsWith("/mkdir"))).toBe(false);
	const write = calls.find((call) => call.method === "PUT");
	if (!write) throw new Error("nothing was written");
	expect(write.headers["if-match"]).toBe("abc");
	expect(JSON.parse(write.body).checks).toEqual([
		{ id: "tests", name: "Tests", command: "npm test" },
		{ id: "lint", name: "Lint", command: "npm run lint" },
	]);
});

test("a row can be removed before saving", async () => {
	const calls = stubFileApi(true);
	renderWithQuery(
		<EditChecksDialog
			workspaceId={WORKSPACE}
			projectId={PROJECT}
			checks={[
				{ id: "tests", name: "Tests", command: "npm test" },
				{ id: "lint", name: "Lint", command: "npm run lint" },
			]}
			onClose={vi.fn()}
		/>,
	);

	fireEvent.click(screen.getByTestId("check-remove-0"));
	fireEvent.click(screen.getByTestId("dialog-confirm"));

	await waitFor(() => expect(calls.some((call) => call.method === "PUT")).toBe(true));
	const write = calls.find((call) => call.method === "PUT");
	if (!write) throw new Error("nothing was written");
	expect(JSON.parse(write.body).checks).toEqual([
		{ id: "lint", name: "Lint", command: "npm run lint" },
	]);
});

const TWO = [
	{ id: "tests", name: "Tests", command: "npm test" },
	{ id: "lint", name: "Lint", command: "npm run lint" },
];

test("each row's fields say which check they belong to (issue #371)", () => {
	stubFileApi(true);
	renderWithQuery(
		<EditChecksDialog
			workspaceId={WORKSPACE}
			projectId={PROJECT}
			checks={TWO}
			onClose={vi.fn()}
		/>,
	);

	expect(screen.getByLabelText(/^Check 1 name$/i)).toBe(
		screen.getByTestId("check-name-0"),
	);
	expect(screen.getByLabelText(/^Check 2 command$/i)).toBe(
		screen.getByTestId("check-command-1"),
	);
});

test("removing a row keeps focus in the dialog (issue #358)", async () => {
	stubFileApi(true);
	renderWithQuery(
		<EditChecksDialog
			workspaceId={WORKSPACE}
			projectId={PROJECT}
			checks={TWO}
			onClose={vi.fn()}
		/>,
	);

	// The row below takes the removed row's place, so its remove button takes focus.
	fireEvent.click(screen.getByTestId("check-remove-0"));
	await waitFor(() =>
		expect(document.activeElement).toBe(screen.getByTestId("check-remove-0")),
	);

	// With no rows left, focus goes to Add a check.
	fireEvent.click(screen.getByTestId("check-remove-0"));
	await waitFor(() =>
		expect(document.activeElement).toBe(screen.getByTestId("check-add")),
	);
});

test("a failed save is announced as an alert (issue #363)", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response("{}", { status: 500 })),
	);
	renderWithQuery(
		<EditChecksDialog
			workspaceId={WORKSPACE}
			projectId={PROJECT}
			checks={TWO}
			onClose={vi.fn()}
		/>,
	);

	fireEvent.click(screen.getByTestId("dialog-confirm"));

	const error = await screen.findByTestId("checks-save-error");
	expect(error.getAttribute("role")).toBe("alert");
});
