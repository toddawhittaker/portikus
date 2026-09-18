/**
 * Saving a file also refreshes that file's diff (SPEC.md §12.6). Nothing
 * else invalidates a diff until the project events consumer lands, so this
 * is the link between a file tab's autosave and an open diff tab.
 */
import { QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type * as React from "react";
import { afterEach, expect, test, vi } from "vitest";
import { createQueryClient } from "../api/queryClient.js";
import { fileKeys, useSaveFile } from "./queries.js";

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
	const queryClient = createQueryClient(() => {});
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
