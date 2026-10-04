import { useState } from "react";
import { type SortDirection, type SortState, sortText } from "./sort.js";

/** What a screen reader hears after a header is pressed, such as "Sorted by Workspace, descending". */
export function sortAnnouncement(label: string, direction: SortDirection): string {
	const text = sortText(label, direction);
	return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * A table's sort and the words to announce when it changes (SPEC.md section
 * 25.8): `aria-sort` alone is not read out when it changes under focus. Every
 * press changes the sort, so the words always differ from the last ones and
 * a repeat press is still spoken.
 */
export function useAnnouncedSort<C extends string>(
	initial: SortState<C>,
	labels: Record<C, string>,
) {
	const [sort, setSortState] = useState(initial);
	const [announcement, setAnnouncement] = useState("");
	function setSort(next: SortState<C>) {
		setSortState(next);
		setAnnouncement(sortAnnouncement(labels[next.column], next.direction));
	}
	return { sort, setSort, announcement };
}

/** The polite region a table's sort is announced in; mounted with the tab so it never misses one. */
export function SortAnnouncement({ text, testId }: { text: string; testId: string }) {
	return (
		<span className="sr-only" role="status" aria-live="polite" data-testid={testId}>
			{text}
		</span>
	);
}
