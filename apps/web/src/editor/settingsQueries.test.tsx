/**
 * A theme a pilot student chose before appearance was saved per user
 * (issue #300) is carried over once, not overwritten by the server default.
 */
import { EDITOR_SETTINGS_DEFAULTS } from "@portikus/contracts";
import { QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type * as React from "react";
import { afterEach, expect, test, vi } from "vitest";
import { createQueryClient } from "../api/queryClient.js";
import { useEditorSettings } from "./settingsQueries.js";

afterEach(() => {
	vi.unstubAllGlobals();
	localStorage.clear();
});

function settings(appearance: string, appearanceStored: boolean) {
	return new Response(
		JSON.stringify({
			...EDITOR_SETTINGS_DEFAULTS,
			appearance,
			appearanceStored,
			timezones: ["America/New_York"],
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

function load() {
	const client = createQueryClient(() => {});
	const wrapper = ({ children }: { children: React.ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	return renderHook(() => useEditorSettings(), { wrapper });
}

test("a browser-only dark theme is saved once when the server has none stored", async () => {
	localStorage.setItem("pk-theme", "dark");
	const fetch = vi.fn(async (_url: string, init: RequestInit = {}) =>
		init.method === "PUT" ? settings("dark", true) : settings("system", false),
	);
	vi.stubGlobal("fetch", fetch);

	const { result } = load();
	await waitFor(() => expect(result.current.data?.appearance).toBe("dark"));
	const puts = fetch.mock.calls.filter(([, init]) => init?.method === "PUT");
	expect(puts).toHaveLength(1);
	expect(puts[0]?.[1]?.body).toBe(JSON.stringify({ appearance: "dark" }));
	expect(localStorage.getItem("pk-theme")).toBe("dark");
});

test("a stored appearance wins over this browser's copy and nothing is saved", async () => {
	localStorage.setItem("pk-theme", "dark");
	const fetch = vi.fn(async () => settings("light", true));
	vi.stubGlobal("fetch", fetch);

	const { result } = load();
	await waitFor(() => expect(result.current.data?.appearance).toBe("light"));
	expect(fetch).toHaveBeenCalledTimes(1);
	expect(localStorage.getItem("pk-theme")).toBe("light");
});

test("the carry-over happens once per browser, not once per account", async () => {
	localStorage.setItem("pk-theme", "dark");
	localStorage.setItem("pk-theme-synced", "1");
	const fetch = vi.fn(async () => settings("system", false));
	vi.stubGlobal("fetch", fetch);

	const { result } = load();
	await waitFor(() => expect(result.current.isSuccess).toBe(true));
	expect(fetch).toHaveBeenCalledTimes(1);
	expect(result.current.data?.appearance).toBe("system");
});

test("any settings load marks this browser as carried over", async () => {
	const fetch = vi.fn(async () => settings("light", true));
	vi.stubGlobal("fetch", fetch);

	const { result } = load();
	await waitFor(() => expect(result.current.isSuccess).toBe(true));
	expect(localStorage.getItem("pk-theme-synced")).toBe("1");
});

test("a failed carry-over save still loads the settings", async () => {
	localStorage.setItem("pk-theme", "dark");
	const fetch = vi.fn(async (_url: string, init: RequestInit = {}) =>
		init.method === "PUT"
			? new Response("{}", {
					status: 500,
					headers: { "content-type": "application/json" },
				})
			: settings("system", false),
	);
	vi.stubGlobal("fetch", fetch);

	const { result } = load();
	await waitFor(() => expect(result.current.isSuccess).toBe(true));
	expect(result.current.data?.appearance).toBe("system");
});

test("a browser that follows the system saves nothing", async () => {
	const fetch = vi.fn(async () => settings("system", false));
	vi.stubGlobal("fetch", fetch);

	const { result } = load();
	await waitFor(() => expect(result.current.isSuccess).toBe(true));
	expect(fetch).toHaveBeenCalledTimes(1);
});
