/**
 * Find in files: the search view that replaces the file tree in the right
 * pane (SPEC.md §11.5, §8.4). Results are grouped by file, each row shows the
 * line number and the matching line, and opening one opens the file at that
 * line.
 */
import { Checkbox, EmptyState, TextField } from "@portikus/ui";
import { type KeyboardEvent, useContext, useRef, useState } from "react";
import { ApiError } from "../api/request.js";
import { LayoutStoreContext } from "../layout/store.js";
import { groupByFile, highlightParts } from "./results.js";
import { useSearch } from "./useSearch.js";
import "./search.css";

/** The longest query the box takes; a search term is a phrase, not a file. */
const MAX_QUERY_LENGTH = 512;

/**
 * What the student is told when a search fails (SPEC.md §28). The agent's own
 * message is never shown, because it is written for an administrator and can
 * carry paths the student has no use for (SPEC.md §24.6).
 */
function searchErrorMessage(error: unknown): string {
	if (error instanceof ApiError && error.code === "AGENT_UNAVAILABLE") {
		return "The workspace is not responding. Try again in a moment.";
	}
	return "Something went wrong. Please try again.";
}

export interface SearchPanelProps {
	workspaceId: string;
	projectId: string;
	/** Go back to the file tree. */
	onClose: () => void;
}

export function SearchPanel({ workspaceId, projectId, onClose }: SearchPanelProps) {
	const [query, setQuery] = useState("");
	const [hidden, setHidden] = useState(false);
	const { result, term } = useSearch(workspaceId, projectId, query, hidden);
	const results = useRef<HTMLDivElement | null>(null);
	// The panel sits inside the workspace provider, so it shares the work
	// area's store and can open a file there.
	const store = useContext(LayoutStoreContext);

	const matches = result.data?.matches ?? [];
	const groups = groupByFile(matches);

	/** Open one match in the work area, at its line (SPEC.md §11.5). */
	function open(path: string, line: number) {
		store?.getState().openFile(path, { line });
	}

	/** Escape leaves the search; the arrows walk the result rows. */
	function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
		if (event.key === "Escape") {
			event.preventDefault();
			onClose();
			return;
		}
		if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
		const rows = [
			...(results.current?.querySelectorAll<HTMLButtonElement>(
				"button.pk-search-row",
			) ?? []),
		];
		if (rows.length === 0) return;
		const at = rows.indexOf(document.activeElement as HTMLButtonElement);
		const next = event.key === "ArrowDown" ? at + 1 : at - 1;
		const target = rows[next < 0 ? rows.length - 1 : next % rows.length];
		if (!target) return;
		event.preventDefault();
		target.focus();
	}

	function body() {
		if (term === "") {
			return (
				<EmptyState icon="search" title="Find in files">
					Type to search this project.
				</EmptyState>
			);
		}
		if (result.isError) {
			return (
				<EmptyState icon="alert" title="The search failed">
					<span data-testid="search-error">{searchErrorMessage(result.error)}</span>
				</EmptyState>
			);
		}
		if (result.isPending) {
			return (
				<p className="pk-search-note" data-testid="search-busy">
					Searching…
				</p>
			);
		}
		if (matches.length === 0) {
			return (
				<EmptyState icon="search" title="No matches">
					<span data-testid="search-empty">
						Nothing in this project matches {term}.
					</span>
				</EmptyState>
			);
		}
		return (
			<div className="pk-search-results" ref={results} data-testid="search-results">
				{groups.map((group) => (
					<div
						className="pk-search-group"
						key={group.path}
						data-testid={`search-group-${group.path}`}
					>
						<div className="pk-search-path" title={group.path}>
							{group.path}
						</div>
						{group.matches.map((match) => {
							const parts = highlightParts(match.text, match.column, term.length);
							return (
								<div key={`${match.line}:${match.column}`}>
									{match.before.map((text, index) => (
										<div
											className="pk-search-row pk-search-context"
											// Context lines have nothing to key them by but position.
											// biome-ignore lint/suspicious/noArrayIndexKey: fixed context
											key={`b${index}`}
										>
											<span className="pk-search-line">
												{match.line - match.before.length + index}
											</span>
											{text}
										</div>
									))}
									<button
										type="button"
										className="pk-search-row"
										data-testid={`search-result-${match.path}-${match.line}`}
										onClick={() => open(match.path, match.line)}
									>
										<span className="pk-search-line">{match.line}</span>
										{parts.before}
										<mark className="pk-search-hit">{parts.match}</mark>
										{parts.after}
									</button>
									{match.after.map((text, index) => (
										// biome-ignore lint/suspicious/noArrayIndexKey: fixed context
										<div className="pk-search-row pk-search-context" key={`a${index}`}>
											<span className="pk-search-line">{match.line + 1 + index}</span>
											{text}
										</div>
									))}
								</div>
							);
						})}
					</div>
				))}
			</div>
		);
	}

	return (
		// The whole panel listens, so Escape works from the input and the rows.
		// biome-ignore lint/a11y/noStaticElementInteractions: a keyboard shortcut host
		<div className="pk-search" data-testid="search-panel" onKeyDown={onKeyDown}>
			<div className="pk-search-controls">
				<TextField
					id="pk-search-query"
					label="Find in files"
					placeholder="Search this project"
					value={query}
					autoFocus={true}
					data-testid="search-input"
					maxLength={MAX_QUERY_LENGTH}
					onChange={(event) => setQuery(event.target.value)}
				/>
				<Checkbox
					label="Include hidden and generated files"
					checked={hidden}
					onChange={(event) => setHidden(event.target.checked)}
				/>
			</div>
			{body()}
			{result.data?.truncated ? (
				<p className="pk-search-note" data-testid="search-truncated">
					Showing the first matches only. Narrow the search to see the rest.
				</p>
			) : null}
		</div>
	);
}
