import { act, renderHook } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import { type Problem, useCodeHelpStore } from "../lsp/store.js";
import { countProblems, groupProblems, useProblems } from "./problems.js";

function problem(overrides: Partial<Problem> = {}): Problem {
	return {
		path: "a.py",
		line: 1,
		column: 1,
		severity: "error",
		message: "bad",
		...overrides,
	};
}

beforeEach(() => {
	useCodeHelpStore.setState({ problems: {}, status: {} });
});

test("groupProblems orders files by path and problems by line, then column", () => {
	const files = groupProblems({
		"b.py": { python: [problem({ path: "b.py" })] },
		"a.py": {
			python: [
				problem({ line: 9, message: "last" }),
				problem({ line: 2, column: 8, message: "second" }),
				problem({ line: 2, column: 3, message: "first" }),
			],
		},
	});
	expect(files.map((file) => file.path)).toEqual(["a.py", "b.py"]);
	expect(files[0]?.problems.map((item) => item.message)).toEqual([
		"first",
		"second",
		"last",
	]);
});

test("groupProblems joins what two servers said about one file", () => {
	const files = groupProblems({
		"a.py": {
			python: [problem({ line: 4, message: "from pyright" })],
			ruff: [problem({ line: 1, message: "from ruff", severity: "warning" })],
		},
	});
	expect(files[0]?.problems.map((item) => item.message)).toEqual([
		"from ruff",
		"from pyright",
	]);
});

test("groupProblems leaves out information and files with nothing left", () => {
	const files = groupProblems({
		"a.py": { python: [problem({ severity: "info" })] },
		"b.py": { python: [] },
		"c.py": {
			python: [problem({ severity: "warning" }), problem({ severity: "info" })],
		},
	});
	expect(files.map((file) => file.path)).toEqual(["c.py"]);
	expect(countProblems(files)).toBe(1);
});

test("groupProblems of nothing is empty", () => {
	expect(groupProblems(undefined)).toEqual([]);
	expect(countProblems([])).toBe(0);
});

test("useProblems follows the store for its own project only", () => {
	const { result } = renderHook(() => useProblems("p1"));
	expect(result.current).toEqual([]);

	act(() => {
		useCodeHelpStore.getState().setProblems("p2", "python", "x.py", [problem()]);
	});
	expect(result.current).toEqual([]);

	act(() => {
		useCodeHelpStore.getState().setProblems("p1", "python", "a.py", [problem()]);
	});
	expect(result.current.map((file) => file.path)).toEqual(["a.py"]);

	// A closed file's editor sends an empty list for it.
	act(() => {
		useCodeHelpStore.getState().setProblems("p1", "python", "a.py", []);
	});
	expect(result.current).toEqual([]);
});

test("useProblems with no project is empty", () => {
	const { result } = renderHook(() => useProblems(undefined));
	expect(result.current).toEqual([]);
});
