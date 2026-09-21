/**
 * The find-in-files panel: grouped results, the truncation notice, the
 * hidden-files toggle and closing it (SPEC.md §11.5).
 */
import type { SearchMatch } from "@portikus/contracts";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { renderWithQuery } from "../test-utils.js";
import { SearchPanel } from "./SearchPanel.js";

const WORKSPACE = "ws-1";
const PROJECT = "pr-1";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

function match(overrides: Partial<SearchMatch> = {}): SearchMatch {
	return {
		path: "src/app.ts",
		line: 3,
		column: 7,
		text: "const answer = 42;",
		before: ["// the answer"],
		after: ["export {};"],
		...overrides,
	};
}

/** Answer every search with these matches, and record what was asked. */
function stubSearch(body: { matches: SearchMatch[]; truncated?: boolean }) {
	const urls: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			urls.push(String(input));
			return new Response(
				JSON.stringify({ matches: body.matches, truncated: body.truncated ?? false }),
				{ status: 200, headers: { "content-type": "application/json" } },
			);
		}),
	);
	return urls;
}

function type(text: string) {
	fireEvent.change(screen.getByTestId("search-input"), { target: { value: text } });
}

test("results are grouped by file, with the match highlighted", async () => {
	stubSearch({
		matches: [
			match(),
			match({ line: 9, column: 1, text: "answer" }),
			match({ path: "src/b.ts", line: 2 }),
		],
	});
	renderWithQuery(
		<SearchPanel workspaceId={WORKSPACE} projectId={PROJECT} onClose={() => {}} />,
	);

	type("answer");

	await waitFor(() =>
		expect(screen.getByTestId("search-group-src/app.ts")).toBeTruthy(),
	);
	expect(screen.getByTestId("search-group-src/b.ts")).toBeTruthy();
	const row = screen.getByTestId("search-result-src/app.ts-3");
	expect(row.textContent).toContain("const answer = 42;");
	expect(row.querySelector("mark")?.textContent).toBe("answer");
	// One line of context on each side (SPEC.md §11.5).
	expect(screen.getByTestId("search-results").textContent).toContain("// the answer");
	expect(screen.getByTestId("search-results").textContent).toContain("export {};");
});

test("a truncated answer says only the first matches are shown", async () => {
	stubSearch({ matches: [match()], truncated: true });
	renderWithQuery(
		<SearchPanel workspaceId={WORKSPACE} projectId={PROJECT} onClose={() => {}} />,
	);

	type("answer");

	await waitFor(() =>
		expect(screen.getByTestId("search-truncated").textContent).toBe(
			"Showing the first matches only. Narrow the search to see the rest.",
		),
	);
});

test("the query is capped, so no huge string is ever sent", () => {
	stubSearch({ matches: [] });
	renderWithQuery(
		<SearchPanel workspaceId={WORKSPACE} projectId={PROJECT} onClose={() => {}} />,
	);

	expect(screen.getByTestId("search-input").getAttribute("maxlength")).toBe("512");
});

test("a search with no matches says so", async () => {
	stubSearch({ matches: [] });
	renderWithQuery(
		<SearchPanel workspaceId={WORKSPACE} projectId={PROJECT} onClose={() => {}} />,
	);

	type("nothing");

	await waitFor(() => expect(screen.getByTestId("search-empty")).toBeTruthy());
});

/** Answer every search with one error body. */
function stubError(status: number, body: unknown) {
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async () =>
				new Response(JSON.stringify(body), {
					status,
					headers: { "content-type": "application/json" },
				}),
		),
	);
}

test("an unreachable workspace is explained in plain English", async () => {
	// SPEC.md §24.6, §28: the agent's own message is never shown.
	stubError(503, { code: "AGENT_UNAVAILABLE", message: "no agent at /run/pk.sock" });
	renderWithQuery(
		<SearchPanel workspaceId={WORKSPACE} projectId={PROJECT} onClose={() => {}} />,
	);

	type("answer");

	await waitFor(() =>
		expect(screen.getByTestId("search-error").textContent).toBe(
			"The workspace is not responding. Try again in a moment.",
		),
	);
});

test("any other failure gets the general sentence, not the raw message", async () => {
	stubError(500, { code: "INTERNAL", message: "ripgrep died in /home/student" });
	renderWithQuery(
		<SearchPanel workspaceId={WORKSPACE} projectId={PROJECT} onClose={() => {}} />,
	);

	type("answer");

	await waitFor(() =>
		expect(screen.getByTestId("search-error").textContent).toBe(
			"Something went wrong. Please try again.",
		),
	);
});

test("including hidden files changes what is asked for", async () => {
	const urls = stubSearch({ matches: [] });
	renderWithQuery(
		<SearchPanel workspaceId={WORKSPACE} projectId={PROJECT} onClose={() => {}} />,
	);

	type("answer");
	await waitFor(() => expect(urls).toHaveLength(1));
	expect(urls[0]).toContain("hidden=false");

	fireEvent.click(screen.getByLabelText("Include hidden and generated files"));

	await waitFor(() => expect(urls).toHaveLength(2));
	expect(urls[1]).toContain("hidden=true");
});

test("Escape leaves the search", async () => {
	stubSearch({ matches: [] });
	const onClose = vi.fn();
	renderWithQuery(
		<SearchPanel workspaceId={WORKSPACE} projectId={PROJECT} onClose={onClose} />,
	);

	fireEvent.keyDown(screen.getByTestId("search-panel"), { key: "Escape" });

	expect(onClose).toHaveBeenCalled();
});

test("the arrows walk the result rows", async () => {
	stubSearch({ matches: [match(), match({ line: 9 })] });
	renderWithQuery(
		<SearchPanel workspaceId={WORKSPACE} projectId={PROJECT} onClose={() => {}} />,
	);

	type("answer");
	await waitFor(() =>
		expect(screen.getByTestId("search-result-src/app.ts-9")).toBeTruthy(),
	);

	const panel = screen.getByTestId("search-panel");
	fireEvent.keyDown(panel, { key: "ArrowDown" });
	expect(document.activeElement).toBe(screen.getByTestId("search-result-src/app.ts-3"));
	fireEvent.keyDown(panel, { key: "ArrowDown" });
	expect(document.activeElement).toBe(screen.getByTestId("search-result-src/app.ts-9"));
	fireEvent.keyDown(panel, { key: "ArrowUp" });
	expect(document.activeElement).toBe(screen.getByTestId("search-result-src/app.ts-3"));
});

test("a click with no work area to open into does nothing", async () => {
	stubSearch({ matches: [match()] });
	renderWithQuery(
		<SearchPanel workspaceId={WORKSPACE} projectId={PROJECT} onClose={() => {}} />,
	);

	type("answer");
	await waitFor(() =>
		expect(screen.getByTestId("search-result-src/app.ts-3")).toBeTruthy(),
	);
	fireEvent.click(screen.getByTestId("search-result-src/app.ts-3"));

	// There is no tab cap to complain about any more (issue #240), and no work
	// area in this render, so the click is simply ignored.
	expect(screen.getByTestId("search-result-src/app.ts-3")).toBeTruthy();
	expect(document.querySelectorAll(".pk-toast")).toHaveLength(0);
});
