import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderWithQuery, stubFetch } from "../../test-utils.js";
import { SEARCH_DELAY_MS, useCourseAccountSearch } from "./linkQueries.js";

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

function Search() {
	const [text, setText] = useState("");
	useCourseAccountSearch(text, true);
	return (
		<input aria-label="Search" value={text} onChange={(e) => setText(e.target.value)} />
	);
}

function searched(fetch: ReturnType<typeof stubFetch>): (string | null)[] {
	return fetch.mock.calls.map(([url]) =>
		new URL(String(url), "http://x").searchParams.get("q"),
	);
}

// The link dialog's search waits for typing to pause, so each keystroke is not a request.
test("the search is sent once typing pauses, not per keystroke", async () => {
	vi.useFakeTimers();
	const fetch = stubFetch(() => json(200, { users: [], total: 0, dexUsers: false }));
	renderWithQuery(<Search />);
	await act(async () => {
		await vi.advanceTimersByTimeAsync(0);
	});
	expect(searched(fetch)).toEqual([null]);

	const box = screen.getByLabelText("Search");
	for (const value of ["a", "al", "ali"]) {
		fireEvent.change(box, { target: { value } });
		await act(async () => {
			await vi.advanceTimersByTimeAsync(SEARCH_DELAY_MS - 50);
		});
	}
	expect(searched(fetch)).toEqual([null]);

	await act(async () => {
		await vi.advanceTimersByTimeAsync(50);
	});
	expect(searched(fetch)).toEqual([null, "ali"]);
});
