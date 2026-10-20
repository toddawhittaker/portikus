import { Button, EmptyState } from "@portikus/ui";
import { useLayoutStore } from "../layout/store.js";
import type { Problem } from "../lsp/store.js";
import { useShowRightPane } from "../shell/rightPane.js";
import { type FileProblems, useProblems } from "./problems.js";
import "./problems.css";

const SEVERITY_WORD = {
	error: "Error",
	warning: "Warning",
	info: "Information",
} as const;

function plural(count: number, word: string): string {
	return `${count} ${word}${count === 1 ? "" : "s"}`;
}

function summary(files: readonly FileProblems[]): string {
	const all = files.flatMap((file) => file.problems);
	const errors = all.filter((problem) => problem.severity === "error").length;
	const warnings = all.length - errors;
	const parts = [
		errors > 0 ? plural(errors, "error") : null,
		warnings > 0 ? plural(warnings, "warning") : null,
	].filter((part) => part !== null);
	return `${parts.join(", ")} in ${plural(files.length, "open file")}`;
}

/**
 * The Problems tab (SPEC.md §13.6): the errors and warnings the language
 * servers found in the files that are open, by file. It is not a project-wide
 * list; Checks is (SPEC.md §18.1). A server's message is plain text here,
 * never markup.
 */
export function ProblemsPane({ projectId }: { projectId: string }) {
	const files = useProblems(projectId);
	const layoutStore = useLayoutStore(projectId);
	const showPane = useShowRightPane();

	function open(problem: Problem) {
		layoutStore.getState().openFile(problem.path, { line: problem.line });
	}

	return (
		<>
			<h2 className="sr-only">Problems</h2>
			{files.length === 0 ? (
				<div className="pk-pane-body" data-testid="problems-empty">
					<EmptyState
						icon="check"
						title="No problems in open files"
						actions={
							<Button variant="secondary" onClick={() => showPane("checks")}>
								Open Checks
							</Button>
						}
					>
						Problems lists the errors and warnings in the files you have open. Checks
						covers the whole project.
					</EmptyState>
				</div>
			) : (
				<div className="pk-pane-body" data-testid="problems-list">
					<p className="pk-problems-summary" data-testid="problems-summary">
						{summary(files)}
					</p>
					<ul className="pk-problems-files">
						{files.map((file) => (
							<li key={file.path} className="pk-problems-file">
								<h3 className="pk-problems-path" title={file.path}>
									{file.path}
								</h3>
								<ul className="pk-problems-rows">
									{file.problems.map((problem) => (
										<li
											key={`${problem.line}:${problem.column}:${problem.source ?? ""}:${problem.message}`}
										>
											<button
												type="button"
												className="pk-problem"
												data-severity={problem.severity}
												data-testid={`problem-${file.path}:${problem.line}`}
												onClick={() => open(problem)}
											>
												<span className="pk-problem-meta">
													<span className="pk-problem-severity">
														{SEVERITY_WORD[problem.severity]}
													</span>{" "}
													<span className="pk-problem-line">Line {problem.line}</span>
												</span>{" "}
												<span className="pk-problem-message" title={problem.message}>
													{problem.message}
												</span>
											</button>
										</li>
									))}
								</ul>
							</li>
						))}
					</ul>
				</div>
			)}
		</>
	);
}
