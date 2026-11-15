import { EDITOR_SETTINGS_DEFAULTS } from "@portikus/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { useEditorSettings } from "./editor/settingsQueries.js";
import { readPaneZoom, resetPaneZooms } from "./layout/paneZoomKeeper.js";
import { json, stubFetch, USER } from "./test-utils.js";
import { useMe } from "./useMe.js";

beforeEach(() => resetPaneZooms());
afterEach(() => vi.unstubAllGlobals());

test("a different signed-in user's pane zooms are loaded again, though their settings were cached", async () => {
	let user = USER;
	let zooms: Record<string, number> = { "p1:t:t1": 150 };
	stubFetch((url) => {
		if (url === "/auth/me") return json(200, user);
		return json(200, { ...EDITOR_SETTINGS_DEFAULTS, timezones: [], paneZooms: zooms });
	});
	const client = new QueryClient();
	const wrapper = ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
	const { result } = renderHook(
		() => {
			useEditorSettings();
			return useMe();
		},
		{ wrapper },
	);
	await waitFor(() => expect(result.current.status).toBe("authenticated"));
	await waitFor(() => expect(readPaneZoom("p1:t:t1")).toBe(150));

	user = { ...USER, id: "99999999-9999-4999-8999-999999999999" };
	zooms = { "p1:t:t1": 90 };
	await client.invalidateQueries({ queryKey: ["me"], exact: true });

	await waitFor(() => expect(readPaneZoom("p1:t:t1")).toBe(90));
});
