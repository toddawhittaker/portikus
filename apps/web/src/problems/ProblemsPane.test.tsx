import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createLayoutStore, LayoutStoreContext } from "../layout/store.js";
import { type Problem, useCodeHelpStore } from "../lsp/store.js";
import { type RightPaneApi, RightPaneContext } from "../shell/rightPane.js";
import { ProblemsPane } from "./ProblemsPane.js";

const PROJECT = "p1";

function problem(overrides: Partial<Problem> = {}): Problem {
	return {
		path: "main.py",
		line: 3,
		column: 5,
		severity: "error",
		message: "Name is not defined",
		...overrides,
	};
}

function show(problems: Problem[], path = "main.py") {
	act(() => {
		useCodeHelpStore.getState().setProblems(PROJECT, "python", path, problems);
	});
}

function renderPane(store = createLayoutStore()) {
	render(
		<LayoutStoreContext.Provider value={store}>
			<ProblemsPane projectId={PROJECT} />
		</LayoutStoreContext.Provider>,
	);
	return store;
}

beforeEach(() => {
	useCodeHelpStore.setState({ problems: {}, status: {} });
});
afterEach(cleanup);

test("with nothing found it says it covers open files and that Checks covers the project", () => {
	renderPane();
	const empty = screen.getByTestId("problems-empty");
	expect(within(empty).getByText("No problems in open files")).toBeTruthy();
	expect(empty.textContent).toContain("files you have open");
	expect(empty.textContent).toContain("Checks covers the whole project");
	expect(screen.getByRole("heading", { level: 2, name: "Problems" })).toBeTruthy();
});

test("its Open Checks button asks the right pane for Checks", () => {
	const shown = vi.fn();
	const api = { show: shown } as unknown as RightPaneApi;
	render(
		<RightPaneContext.Provider value={api}>
			<LayoutStoreContext.Provider value={createLayoutStore()}>
				<ProblemsPane projectId={PROJECT} />
			</LayoutStoreContext.Provider>
		</RightPaneContext.Provider>,
	);
	fireEvent.click(screen.getByRole("button", { name: "Open Checks" }));
	expect(shown).toHaveBeenCalledWith("checks");
});

test("problems are grouped by file, each row naming severity, line and message", () => {
	renderPane();
	show([
		problem({ line: 9, severity: "warning", message: "Unused variable" }),
		problem({ line: 3 }),
	]);
	show([problem({ path: "util.py", line: 1, message: "Bad import" })], "util.py");

	const headings = screen.getAllByRole("heading", { level: 3 });
	expect(headings.map((heading) => heading.textContent)).toEqual([
		"main.py",
		"util.py",
	]);
	expect(screen.getByTestId("problems-summary").textContent).toBe(
		"2 errors, 1 warning in 2 open files",
	);

	const rows = screen.getAllByRole("button");
	expect(rows.map((row) => row.textContent)).toEqual([
		"Error Line 3 Name is not defined",
		"Warning Line 9 Unused variable",
		"Error Line 1 Bad import",
	]);
});

test("a row opens its file at its line", () => {
	const store = renderPane();
	show([problem({ path: "src/app.py", line: 12 })], "src/app.py");

	fireEvent.click(screen.getByRole("button", { name: /Line 12/ }));

	const state = store.getState();
	expect(state.activeTabId).toBe("file:src/app.py");
	expect(state.pendingView["file:src/app.py"]).toMatchObject({
		mode: "edit",
		line: 12,
	});
});

test("a message is shown as text, never as markup", () => {
	renderPane();
	show([problem({ message: '<img src=x onerror="alert(1)"> <b>bold</b>' })]);

	const row = screen.getByRole("button");
	expect(row.querySelector("img")).toBeNull();
	expect(row.querySelector("b")).toBeNull();
	expect(row.textContent).toContain('<img src=x onerror="alert(1)"> <b>bold</b>');
});

test("closing a file empties its group, and the last one brings the empty state back", () => {
	renderPane();
	show([problem()]);
	expect(screen.queryByTestId("problems-empty")).toBeNull();

	show([]);
	expect(screen.getByTestId("problems-empty")).toBeTruthy();
	expect(screen.queryByTestId("problems-list")).toBeNull();
});
