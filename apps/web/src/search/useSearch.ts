/**
 * Running one project search from the browser (SPEC.md §11.5). The query is
 * debounced so a typed word is one search rather than one per keystroke, and
 * every request carries the query's abort signal, so a search that is
 * superseded is cancelled all the way down to the agent's ripgrep.
 */
import { SearchResponse } from "@portikus/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { request } from "../api/request.js";

/** How long typing pauses before a search is sent (SPEC.md §11.5). */
const SEARCH_DEBOUNCE_MS = 250;

/** Hold a value back until it has stopped changing for `delay`. */
function useDebounced<T>(value: T, delay: number): T {
	const [held, setHeld] = useState(value);
	useEffect(() => {
		const timer = setTimeout(() => setHeld(value), delay);
		return () => clearTimeout(timer);
	}, [value, delay]);
	return held;
}

export const searchKeys = {
	search: (workspaceId: string, projectId: string, q: string, hidden: boolean) =>
		["search", workspaceId, projectId, q, hidden] as const,
};

/** The URL of one project's search. */
function searchUrl(
	workspaceId: string,
	projectId: string,
	q: string,
	hidden: boolean,
): string {
	const query = new URLSearchParams({ q, hidden: String(hidden) });
	return `/workspaces/${workspaceId}/projects/${projectId}/search?${query}`;
}

export function useSearch(
	workspaceId: string,
	projectId: string,
	query: string,
	hidden: boolean,
) {
	const term = useDebounced(query, SEARCH_DEBOUNCE_MS).trim();
	const result = useQuery({
		queryKey: searchKeys.search(workspaceId, projectId, term, hidden),
		enabled: term.length > 0,
		// Nothing is kept: a search is asked again when it is asked again, and
		// dropping the old query is what aborts its request.
		gcTime: 0,
		staleTime: 0,
		// Coming back to the tab must not re-run the search behind the student.
		refetchOnWindowFocus: false,
		queryFn: ({ signal }) =>
			request(SearchResponse, searchUrl(workspaceId, projectId, term, hidden), {
				signal,
			}),
	});
	// The term the result belongs to: the panel highlights with its length.
	return { result, term };
}
