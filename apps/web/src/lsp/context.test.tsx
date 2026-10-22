/**
 * The page's code-help manager follows the set of languages (SPEC.md §13.6):
 * a new set makes a new manager, the same set read again does not, and an
 * empty set makes none.
 */
import type { CodeHelpLanguage } from "@portikus/contracts";
import { renderHook } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { useCodeHelpManager } from "./context.js";

const PROJECT = { id: "p1", path: "/home/student/projects/p", name: "p" };

function render(initial: CodeHelpLanguage[]) {
	return renderHook(
		({ languages }: { languages: CodeHelpLanguage[] }) =>
			useCodeHelpManager("w1", PROJECT, new Set(languages), vi.fn()),
		{ initialProps: { languages: initial } },
	);
}

test("there is no manager while no language is on", () => {
	const { result } = render([]);
	expect(result.current).toBeNull();
});

test("the languages given reach the manager", () => {
	const { result } = render(["typescript"]);
	expect(result.current?.allows("typescript")).toBe(true);
	expect(result.current?.allows("python")).toBe(false);
});

test("the same languages in a new set keep the same manager", () => {
	const { result, rerender } = render(["python", "typescript"]);
	const first = result.current;
	expect(first).not.toBeNull();
	rerender({ languages: ["typescript", "python"] });
	expect(result.current).toBe(first);
});

test("a changed set makes a new manager that follows it", () => {
	const { result, rerender } = render(["python", "typescript"]);
	const first = result.current;
	rerender({ languages: ["typescript"] });
	expect(result.current).not.toBe(first);
	expect(result.current?.allows("python")).toBe(false);
	expect(result.current?.allows("typescript")).toBe(true);
	rerender({ languages: [] });
	expect(result.current).toBeNull();
	rerender({ languages: ["python"] });
	expect(result.current?.allows("python")).toBe(true);
});
