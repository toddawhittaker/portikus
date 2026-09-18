/**
 * The search hook: one request per pause in typing, and the request behind a
 * superseded search is cancelled (SPEC.md §11.5).
 */
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { createQueryClient } from "../api/queryClient.js";
import { useSearch } from "./useSearch.js";

const WORKSPACE = "ws-1";
const PROJECT = "pr-1";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

/** Render one probe with its own query client, and allow a rerender. */
function renderProbe(ui: ReactElement) {
	const client = createQueryClient(() => {});
	const view = render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
	return {
		rerender: (next: ReactElement) =>
			view.rerender(<QueryClientProvider client={client}>{next}</QueryClientProvider>),
	};
}

function Probe({ query, hidden = false }: { query: string; hidden?: boolean }) {
	const { result } = useSearch(WORKSPACE, PROJECT, query, hidden);
	return <output data-testid="count">{result.data?.matches.length ?? -1}</output>;
}

/** A fetch that never answers, so an in-flight request can be inspected. */
function stubPendingFetch() {
	const calls: { url: string; signal: AbortSignal | undefined }[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
			calls.push({ url: String(input), signal: init?.signal ?? undefined });
			return new Promise<Response>(() => {});
		}),
	);
	return calls;
}

test("typing sends one search, after the debounce", async () => {
	const calls = stubPendingFetch();

	const { rerender } = renderProbe(<Probe query="" />);
	rerender(<Probe query="an" />);
	rerender(<Probe query="ans" />);
	rerender(<Probe query="answ" />);

	expect(calls).toHaveLength(0);
	await waitFor(() => expect(calls).toHaveLength(1));
	expect(calls[0]?.url).toContain("q=answ");
	expect(calls[0]?.url).toContain("hidden=false");
});

test("an empty query sends nothing", async () => {
	const calls = stubPendingFetch();

	renderProbe(<Probe query="   " />);

	await new Promise((resolve) => setTimeout(resolve, 400));
	expect(calls).toHaveLength(0);
});

test("a superseded search has its request aborted", async () => {
	const calls = stubPendingFetch();

	const { rerender } = renderProbe(<Probe query="answer" />);
	await waitFor(() => expect(calls).toHaveLength(1));

	rerender(<Probe query="question" />);
	await waitFor(() => expect(calls).toHaveLength(2));

	await waitFor(() => expect(calls[0]?.signal?.aborted).toBe(true));
	expect(calls[1]?.signal?.aborted).toBe(false);
});

test("the hidden flag is part of the request", async () => {
	const calls = stubPendingFetch();

	renderProbe(<Probe query="answer" hidden={true} />);

	await waitFor(() => expect(calls).toHaveLength(1));
	expect(calls[0]?.url).toContain("hidden=true");
});

test("a finished search reports its matches", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async () =>
				new Response(JSON.stringify({ matches: [], truncated: false }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		),
	);

	renderProbe(<Probe query="answer" />);

	await waitFor(() => expect(document.querySelector("output")?.textContent).toBe("0"));
});
