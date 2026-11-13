/**
 * The editor pane's color scheme submenu (SPEC.md §13.1, §25.8): every scheme
 * in Settings' order, the one in use ticked, and a choice saves the same
 * `editorScheme` setting Settings saves.
 */
import { EDITOR_SETTINGS_DEFAULTS } from "@portikus/contracts";
import { Menu, MenuRoot, MenuTrigger } from "@portikus/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { createQueryClient } from "../api/queryClient.js";
import { SchemeSubmenu } from "./SchemeSubmenu.js";
import { EDITOR_SCHEME_LIST } from "./schemes/index.js";
import { editorSettingsKey } from "./settingsQueries.js";

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	document.body.replaceChildren();
});

const SAVED = {
	...EDITOR_SETTINGS_DEFAULTS,
	appearance: "system",
	appearanceStored: true,
	timezones: ["America/New_York"],
};

function renderMenu(editorScheme: string) {
	const client = createQueryClient();
	client.setQueryData(editorSettingsKey, { ...SAVED, editorScheme });
	const puts: unknown[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_url: string, init?: RequestInit) => {
			if (init?.method === "PUT") puts.push(JSON.parse(String(init.body)));
			const body = init?.method === "PUT" ? puts.at(-1) : { editorScheme };
			return new Response(JSON.stringify({ ...SAVED, ...(body as object) }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		}),
	);
	render(
		<QueryClientProvider client={client}>
			<MenuRoot>
				<MenuTrigger data-testid="open">Actions</MenuTrigger>
				<Menu label="Actions">
					<SchemeSubmenu />
				</Menu>
			</MenuRoot>
		</QueryClientProvider>,
	);
	fireEvent.pointerDown(screen.getByTestId("open"), { button: 0, ctrlKey: false });
	// The keyboard way in, as for any submenu.
	fireEvent.keyDown(screen.getByTestId("editor-scheme-menu"), { key: "ArrowRight" });
	return puts;
}

test("it lists every scheme by its label, in Settings' order", async () => {
	renderMenu("portikus");
	const items = await screen.findAllByRole("menuitemradio");
	expect(items.map((item) => item.textContent)).toEqual(
		EDITOR_SCHEME_LIST.map((scheme) => scheme.label),
	);
	expect(screen.getByRole("menu", { name: "Color scheme" })).toBeTruthy();
});

test("only the scheme in use is checked", async () => {
	renderMenu("solarized");
	const items = await screen.findAllByRole("menuitemradio");
	const checked = items.filter((item) => item.getAttribute("aria-checked") === "true");
	expect(checked.map((item) => item.textContent)).toEqual(["Solarized"]);
});

test("choosing a scheme saves the editorScheme setting", async () => {
	const puts = renderMenu("portikus");
	fireEvent.click(await screen.findByTestId("editor-scheme-github"));
	await waitFor(() => expect(puts).toEqual([{ editorScheme: "github" }]));
});
