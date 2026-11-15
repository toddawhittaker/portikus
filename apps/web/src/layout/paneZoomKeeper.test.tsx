import { EDITOR_SETTINGS_DEFAULTS, type MeSettings } from "@portikus/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { meSettingsQuery } from "../editor/settingsQueries";
import { usePersistedZoom } from "./paneZoom";
import {
	fileZoomKey,
	flushPaneZooms,
	movePaneZooms,
	paneZoomsFor,
	prunePaneZooms,
	readPaneZoom,
	resetPaneZooms,
	SAVE_DELAY_MS,
	seedPaneZooms,
	terminalZoomKey,
	writePaneZoom,
} from "./paneZoomKeeper";

const fetchMock = vi.fn();

beforeEach(() => {
	resetPaneZooms();
	fetchMock.mockReset();
	fetchMock.mockResolvedValue(
		new Response(JSON.stringify({ ...EDITOR_SETTINGS_DEFAULTS, timezones: [] }), {
			status: 200,
			headers: { "content-type": "application/json" },
		}),
	);
	vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

function settingsAnswer(paneZooms: MeSettings["paneZooms"]) {
	fetchMock.mockResolvedValue(
		new Response(
			JSON.stringify({ ...EDITOR_SETTINGS_DEFAULTS, timezones: [], paneZooms }),
			{ status: 200, headers: { "content-type": "application/json" } },
		),
	);
}

function sentBodies(): unknown[] {
	return fetchMock.mock.calls.map(([, init]) =>
		JSON.parse((init as RequestInit).body as string),
	);
}

test("keys name the project and the terminal id or file path", () => {
	expect(terminalZoomKey("p1", "t1")).toBe("p1:t:t1");
	expect(fileZoomKey("p1", "src/a.ts")).toBe("p1:f:src/a.ts");
});

test("a run of zoom steps is saved once, after the delay, with the newest value", () => {
	vi.useFakeTimers();
	const key = terminalZoomKey("p1", "t1");
	writePaneZoom(key, 110);
	writePaneZoom(key, 120);
	writePaneZoom(key, 130);
	expect(fetchMock).not.toHaveBeenCalled();
	vi.advanceTimersByTime(SAVE_DELAY_MS);
	expect(fetchMock).toHaveBeenCalledTimes(1);
	const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
	expect(url).toContain("/me/settings");
	expect(init.method).toBe("PUT");
	expect(sentBodies()).toEqual([{ paneZooms: { [key]: 130 } }]);
	expect(readPaneZoom(key)).toBe(130);
});

test("a failed save keeps the zoom in this tab", async () => {
	fetchMock.mockRejectedValue(new TypeError("offline"));
	const key = fileZoomKey("p1", "a.ts");
	writePaneZoom(key, 150);
	flushPaneZooms();
	await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
	expect(readPaneZoom(key)).toBe(150);
});

test("values outside the zoom range are clamped before they are kept", () => {
	writePaneZoom("k", 9999);
	expect(readPaneZoom("k")).toBe(300);
	seedPaneZooms({ s: 10 });
	expect(readPaneZoom("s")).toBe(50);
});

test("this tab's zoom wins over the server's", () => {
	seedPaneZooms({ k: 120 });
	writePaneZoom("k", 140);
	seedPaneZooms({ k: 200 });
	expect(readPaneZoom("k")).toBe(140);
});

test("pruning forgets missing panes of one project and saves that as null", () => {
	seedPaneZooms({ "p1:t:a": 120, "p1:t:b": 130, "p2:t:b": 140 });
	prunePaneZooms("p1", new Set(["p1:t:a"]));
	expect(readPaneZoom("p1:t:b")).toBeUndefined();
	expect(readPaneZoom("p2:t:b")).toBe(140);
	flushPaneZooms();
	expect(sentBodies()).toEqual([{ paneZooms: { "p1:t:b": null } }]);
});

test("pruning before the server's zooms arrive does nothing", () => {
	writePaneZoom("p1:t:a", 120);
	prunePaneZooms("p1", new Set());
	expect(readPaneZoom("p1:t:a")).toBe(120);
});

test("moving a folder moves its files' zooms", () => {
	seedPaneZooms({ "p1:f:src/a.ts": 120, "p1:f:other.ts": 130 });
	movePaneZooms("p1", "src", "lib");
	expect(readPaneZoom("p1:f:lib/a.ts")).toBe(120);
	expect(readPaneZoom("p1:f:src/a.ts")).toBeUndefined();
	expect(readPaneZoom("p1:f:other.ts")).toBe(130);
});

test("the hook opens at the zoom the settings query brought", async () => {
	settingsAnswer({ "p1:t:t1": 170 });
	const client = new QueryClient();
	await client.fetchQuery(meSettingsQuery);
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	const { result } = renderHook(() => usePersistedZoom("p1:t:t1"), { wrapper });
	expect(result.current[0]).toBe(170);
	act(() => result.current[1](100));
	expect(result.current[0]).toBe(100);
});

test("a pane drawn before the settings arrive takes up their zoom", async () => {
	settingsAnswer({ "p1:t:t1": 170 });
	const { result } = renderHook(() => usePersistedZoom("p1:t:t1"));
	expect(result.current[0]).toBe(100);
	await act(() => new QueryClient().fetchQuery(meSettingsQuery));
	expect(result.current[0]).toBe(170);
});

test("closing the tab sends a waiting save at once, with keepalive", () => {
	vi.useFakeTimers();
	writePaneZoom("p1:t:t1", 140);
	window.dispatchEvent(new Event("pagehide"));
	expect(fetchMock).toHaveBeenCalledTimes(1);
	const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
	expect(url).toBe("/me/settings");
	expect(init).toMatchObject({ method: "PUT", keepalive: true });
	expect(sentBodies()).toEqual([{ paneZooms: { "p1:t:t1": 140 } }]);
	vi.advanceTimersByTime(SAVE_DELAY_MS);
	expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("closing the tab with nothing waiting sends nothing", () => {
	window.dispatchEvent(new Event("pagehide"));
	expect(fetchMock).not.toHaveBeenCalled();
});

test("another signed-in user never sees or saves the last user's zooms", () => {
	vi.useFakeTimers();
	paneZoomsFor("user-a");
	seedPaneZooms({ "p1:t:t1": 150 });
	writePaneZoom("p1:t:t2", 130);
	paneZoomsFor("user-a");
	expect(readPaneZoom("p1:t:t1")).toBe(150);
	paneZoomsFor("user-b");
	expect(readPaneZoom("p1:t:t1")).toBeUndefined();
	expect(readPaneZoom("p1:t:t2")).toBeUndefined();
	vi.advanceTimersByTime(SAVE_DELAY_MS);
	expect(fetchMock).not.toHaveBeenCalled();
	seedPaneZooms({ "p1:t:t1": 90 });
	expect(readPaneZoom("p1:t:t1")).toBe(90);
});

test("with no key the hook keeps its zoom to itself and saves nothing", () => {
	const { result } = renderHook(() => usePersistedZoom(null));
	act(() => result.current[1](130));
	expect(result.current[0]).toBe(130);
	flushPaneZooms();
	expect(fetchMock).not.toHaveBeenCalled();
});
