/**
 * The Problems list's data (SPEC.md §13.6): the diagnostics the language
 * servers sent for the open files, flattened out of the code-help store.
 */
import type { LanguageServerId } from "@portikus/contracts";
import { useMemo } from "react";
import { type Problem, useCodeHelpStore } from "../lsp/store.js";

export interface FileProblems {
	path: string;
	problems: Problem[];
}

type ByPath = Record<string, Partial<Record<LanguageServerId, Problem[]>>> | undefined;

function inOrder(a: Problem, b: Problem): number {
	return a.line - b.line || a.column - b.column;
}

/**
 * Errors and warnings by file, files by path and problems by position.
 * Information and hints stay in the editor, so a file with none is left out.
 */
export function groupProblems(byPath: ByPath): FileProblems[] {
	const files: FileProblems[] = [];
	for (const [path, byServer] of Object.entries(byPath ?? {})) {
		const problems = Object.values(byServer)
			.flat()
			.filter((problem) => problem.severity !== "info")
			.sort(inOrder);
		if (problems.length > 0) files.push({ path, problems });
	}
	return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

export function countProblems(files: readonly FileProblems[]): number {
	return files.reduce((total, file) => total + file.problems.length, 0);
}

/** The open files' problems for one project; empty when there is no project. */
export function useProblems(projectId: string | undefined): FileProblems[] {
	// The store replaces a project's record only when its problems change.
	const byPath = useCodeHelpStore((state) =>
		projectId === undefined ? undefined : state.problems[projectId],
	);
	return useMemo(() => groupProblems(byPath), [byPath]);
}
