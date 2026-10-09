/**
 * Saving a file also refreshes that file's diff (SPEC.md §12.6): the link
 * between a file tab's autosave and an open diff tab, without waiting for
 * the project events socket to say the same thing.
 */
import { QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type * as React from "react";
import { afterEach, expect, test, vi } from "vitest";
import { createQueryClient } from "../api/queryClient.js";
import {
	fileKeys,
	selectionDownloadUrl,
	useExtractProgress,
	useSaveFile,
} from "./queries.js";

const WORKSPACE = "ws-1";
const PROJECT = "p-1";
const PATH = "src/app.ts";

afterEach(() => {
	vi.unstubAllGlobals();
});

test("a successful save invalidates the diff of the same file", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async () =>
				new Response(JSON.stringify({ etag: "v2", size: 6 }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		),
	);
	const queryClient = createQueryClient();
	const invalidate = vi.spyOn(queryClient, "invalidateQueries");
	const wrapper = ({ children }: { children: React.ReactNode }) => (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	);

	const { result } = renderHook(() => useSaveFile(WORKSPACE, PROJECT, PATH), {
		wrapper,
	});
	result.current.mutate({ text: "hello\n", etag: "v1" });

	await waitFor(() => expect(result.current.isSuccess).toBe(true));
	expect(invalidate).toHaveBeenCalledWith({
		queryKey: fileKeys.diff(WORKSPACE, PROJECT, PATH),
	});
});

test("a selection download names every path once each, escaped", () => {
	expect(selectionDownloadUrl(WORKSPACE, PROJECT, ["src/a b.ts", "docs"])).toBe(
		`/workspaces/${WORKSPACE}/projects/${PROJECT}/download?path=src%2Fa+b.ts&path=docs`,
	);
});

test("extraction progress is read only while an extraction runs", async () => {
	const fetchMock = vi.fn(
		async () =>
			new Response(JSON.stringify({ done: 3, total: 10 }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
	);
	vi.stubGlobal("fetch", fetchMock);
	const queryClient = createQueryClient();
	const wrapper = ({ children }: { children: React.ReactNode }) => (
		<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
	);
	const { result, rerender } = renderHook(
		({ running }) => useExtractProgress(WORKSPACE, PROJECT, running),
		{ wrapper, initialProps: { running: false } },
	);
	expect(fetchMock).not.toHaveBeenCalled();
	rerender({ running: true });
	await waitFor(() => expect(result.current.data).toEqual({ done: 3, total: 10 }));
	expect(fetchMock).toHaveBeenCalledWith(
		`/workspaces/${WORKSPACE}/projects/${PROJECT}/extract/progress`,
		expect.anything(),
	);
});
