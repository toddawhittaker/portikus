import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { SHARE_POLL_MS, type ShareRef, useSharedFile } from "./queries.js";

const ref: ShareRef = { courseId: "c1", projectId: "p1" };

afterEach(() => vi.unstubAllGlobals());

function setup(version: string | undefined) {
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async () => new Response("hi", { headers: { "content-type": "text/plain" } }),
		),
	);
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	renderHook(() => useSharedFile(ref, "a.txt", version), { wrapper });
	return client;
}

test("a file with no version from the listing is polled every 10 seconds", async () => {
	const client = setup(undefined);
	await waitFor(() => expect(client.getQueryCache().getAll()).toHaveLength(1));
	const options = client.getQueryCache().getAll()[0]?.observers[0]?.options;
	expect(options?.refetchInterval).toBe(SHARE_POLL_MS);
	expect(SHARE_POLL_MS).toBe(10_000);
});

test("a file with a version is not polled", async () => {
	const client = setup("1-2");
	await waitFor(() => expect(client.getQueryCache().getAll()).toHaveLength(1));
	const options = client.getQueryCache().getAll()[0]?.observers[0]?.options;
	expect(options?.refetchInterval).toBe(false);
});
