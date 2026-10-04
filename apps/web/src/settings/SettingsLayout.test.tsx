/**
 * The settings fields share one order: label, then control, then hint, the
 * order TextField uses, so every field reads the same way (SPEC.md §13.5).
 */
import { EDITOR_SETTINGS_DEFAULTS } from "@portikus/contracts";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderWithQuery, stubFetch } from "../test-utils.js";
import { SettingsDialog } from "./SettingsDialog.js";

afterEach(() => {
	vi.unstubAllGlobals();
});

function renderPreferences() {
	stubFetch((url) => {
		if (url !== "/me/settings") throw new Error(`unexpected request to ${url}`);
		return json(200, { ...EDITOR_SETTINGS_DEFAULTS, timezones: ["UTC"] });
	});
	renderWithQuery(<SettingsDialog onClose={() => {}} />);
}

test("the color scheme choice shows its hint after the legend and the choices", async () => {
	renderPreferences();
	const group = await screen.findByRole("group", { name: "Color scheme" });
	const legend = group.querySelector("legend");
	const hint = screen.getByText("Light, dark, or follow this computer.");
	const choice = screen.getByRole("radio", { name: "System" });

	expect(legend?.compareDocumentPosition(hint)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
	expect(
		choice.compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING,
	).toBeTruthy();
	expect(group.getAttribute("aria-describedby")).toBe(hint.id);
});

test("the auto-save delay is named Auto-save delay and its hint gives the unit", async () => {
	renderPreferences();
	const field = await screen.findByRole("textbox", { name: "Auto-save delay" });
	expect(field.getAttribute("data-testid")).toBe("editor-settings-delay");
	const hint = document.getElementById(field.getAttribute("aria-describedby") ?? "");
	expect(hint?.textContent).toBe("Seconds, 1 to 60");
});

test("a search hit puts focus on the field, not on the help button beside its label", async () => {
	renderPreferences();
	const search = await screen.findByLabelText("Search");
	fireEvent.change(search, { target: { value: "seconds" } });
	fireEvent.click(screen.getByRole("button", { name: "Auto-save delay" }));
	await waitFor(() =>
		expect(document.activeElement).toBe(
			screen.getByRole("textbox", { name: "Auto-save delay" }),
		),
	);
});

test("the terminal colors hint follows the switch and describes it", async () => {
	renderPreferences();
	const toggle = await screen.findByRole("switch", { name: "Light terminal" });
	const hint = screen.getByText("What a new terminal starts with.");
	expect(
		toggle.compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING,
	).toBeTruthy();
	expect(toggle.getAttribute("aria-describedby")).toBe(hint.id);
});
