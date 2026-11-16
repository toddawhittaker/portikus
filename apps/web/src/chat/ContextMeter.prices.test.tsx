import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { ContextMeter } from "./ContextMeter.js";
import { createChatStore } from "./chatStore.js";
import { resetPriceTable } from "./restartEstimate.js";

/** The site's price table is read when the chat mounts, before any estimate (SPEC.md §10.8). */

afterEach(() => {
	cleanup();
	resetPriceTable();
	vi.unstubAllGlobals();
});

test("mounting the chat reads the price table once, before the first context report", async () => {
	const fetch = vi.fn(async () => new Response(JSON.stringify({ prices: [] })));
	vi.stubGlobal("fetch", fetch);
	const store = createChatStore(() => true);
	render(<ContextMeter store={store} onAnnounce={() => undefined} />);
	await act(async () => undefined);
	expect(fetch).toHaveBeenCalledTimes(1);
	expect(String((fetch.mock.calls[0] as unknown[])[0])).toContain("/pricing");
});
