/**
 * The editor settings dialog (issue #159, SPEC.md §13.5): it shows what the
 * server holds and sends the changes back.
 */
import { EDITOR_SETTINGS_DEFAULTS } from "@portikus/contracts";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderWithQuery, stubFetch } from "../test-utils.js";
import { SettingsDialog } from "./SettingsDialog.js";

afterEach(() => {
	vi.unstubAllGlobals();
});

interface Sent {
	body: unknown;
}

/** Answers GET /me/settings with `stored` and records what is written. */
function stubSettings(stored = EDITOR_SETTINGS_DEFAULTS) {
	const writes: Sent[] = [];
	let current = stored;
	stubFetch((url, init) => {
		if (url !== "/me/settings") throw new Error(`unexpected request to ${url}`);
		if ((init?.method ?? "GET") !== "GET") {
			const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
			writes.push({ body });
			current = { ...current, ...body } as typeof current;
		}
		return json(200, current);
	});
	return writes;
}

function checkbox(name: RegExp) {
	return screen.getByRole("checkbox", { name });
}

/** Issue #288: one dialog, three headed groups, every field under its own. */
test("the three sections each hold their fields", async () => {
	stubSettings();
	renderWithQuery(<SettingsDialog onClose={() => {}} />);
	await waitFor(() =>
		expect(
			(screen.getByTestId("editor-settings-delay") as HTMLInputElement).value,
		).toBe("5"),
	);

	const editor = screen.getByRole("region", { name: "Editor" });
	const terminal = screen.getByRole("region", { name: "Terminal" });
	const workspace = screen.getByRole("region", { name: "Workspace" });

	expect(editor.textContent).toContain("Auto-save");
	expect(editor.textContent).toContain("Word wrap");
	expect(editor.contains(screen.getByTestId("editor-settings-delay"))).toBe(true);
	expect(terminal.textContent).toContain("Terminal colours");
	expect(workspace.textContent).toContain("Workspace timezone");
});

test("it shows the settings the server holds", async () => {
	stubSettings({
		autoSave: false,
		autoSaveDelaySeconds: 12,
		wordWrap: true,
		terminalTheme: "light",
		timezone: "America/New_York",
	});
	renderWithQuery(<SettingsDialog onClose={() => {}} />);

	await waitFor(() =>
		expect(
			(screen.getByTestId("editor-settings-delay") as HTMLInputElement).value,
		).toBe("12"),
	);
	expect((checkbox(/Auto-save/) as HTMLInputElement).checked).toBe(false);
	expect((checkbox(/Word wrap/) as HTMLInputElement).checked).toBe(true);
	expect(screen.getByLabelText("Terminal colours").textContent).toContain("Light");
});

test("saving sends every setting and closes the dialog", async () => {
	const writes = stubSettings();
	const onClose = vi.fn();
	renderWithQuery(<SettingsDialog onClose={onClose} />);
	await waitFor(() =>
		expect(
			(screen.getByTestId("editor-settings-delay") as HTMLInputElement).value,
		).toBe("5"),
	);

	fireEvent.click(checkbox(/Word wrap/));
	fireEvent.change(screen.getByTestId("editor-settings-delay"), {
		target: { value: "8" },
	});
	fireEvent.click(screen.getByTestId("editor-settings-save"));

	await waitFor(() => expect(writes).toHaveLength(1));
	expect(writes[0]?.body).toEqual({
		autoSave: true,
		autoSaveDelaySeconds: 8,
		// The box starts ticked now (issue #270), so the click clears it.
		wordWrap: false,
		terminalTheme: "dark",
		timezone: "America/New_York",
	});
	await waitFor(() => expect(onClose).toHaveBeenCalled());
});

test("turning auto-save off is saved and the delay field is disabled", async () => {
	const writes = stubSettings();
	renderWithQuery(<SettingsDialog onClose={() => {}} />);
	await waitFor(() =>
		expect(
			(screen.getByTestId("editor-settings-delay") as HTMLInputElement).value,
		).toBe("5"),
	);

	fireEvent.click(checkbox(/Auto-save/));
	expect(
		(screen.getByTestId("editor-settings-delay") as HTMLInputElement).disabled,
	).toBe(true);

	fireEvent.click(screen.getByTestId("editor-settings-save"));
	await waitFor(() => expect(writes).toHaveLength(1));
	expect(writes[0]?.body).toMatchObject({ autoSave: false });
});

test("a delay outside 1 to 60 seconds is refused before anything is sent", async () => {
	const writes = stubSettings();
	renderWithQuery(<SettingsDialog onClose={() => {}} />);
	await waitFor(() =>
		expect(
			(screen.getByTestId("editor-settings-delay") as HTMLInputElement).value,
		).toBe("5"),
	);

	fireEvent.change(screen.getByTestId("editor-settings-delay"), {
		target: { value: "90" },
	});
	expect(screen.getByText(/between 1 and 60/)).not.toBeNull();
	fireEvent.click(screen.getByTestId("editor-settings-save"));
	expect(writes).toHaveLength(0);
});

/**
 * Issue #239: the dialog shows the stored terminal theme and sends it back
 * with everything else. The Radix select cannot be opened in jsdom, so
 * actually choosing a different theme is covered in e2e/editor.spec.ts.
 */
test("the stored terminal theme is shown and sent back", async () => {
	const writes = stubSettings({
		autoSave: true,
		autoSaveDelaySeconds: 5,
		wordWrap: false,
		terminalTheme: "light",
		timezone: "America/New_York",
	});
	renderWithQuery(<SettingsDialog onClose={() => {}} />);
	await waitFor(() =>
		expect(screen.getByLabelText("Terminal colours").textContent).toContain("Light"),
	);

	fireEvent.click(checkbox(/Word wrap/));
	fireEvent.click(screen.getByTestId("editor-settings-save"));

	await waitFor(() => expect(writes).toHaveLength(1));
	expect(writes[0]?.body).toMatchObject({ terminalTheme: "light", wordWrap: true });
});

/**
 * Issue #287: the dialog shows the stored zone and sends it back with the
 * rest. Choosing a different zone from the Radix list needs a real browser,
 * so that is covered in e2e/timezone.spec.ts.
 */
test("the stored timezone is shown and sent back", async () => {
	const writes = stubSettings({
		autoSave: true,
		autoSaveDelaySeconds: 5,
		wordWrap: false,
		terminalTheme: "dark",
		timezone: "Europe/Berlin",
	});
	renderWithQuery(<SettingsDialog onClose={() => {}} />);
	await waitFor(() =>
		expect(screen.getByLabelText("Workspace timezone").textContent).toContain(
			"Europe/Berlin",
		),
	);

	fireEvent.click(checkbox(/Word wrap/));
	fireEvent.click(screen.getByTestId("editor-settings-save"));

	await waitFor(() => expect(writes).toHaveLength(1));
	expect(writes[0]?.body).toMatchObject({ timezone: "Europe/Berlin" });
});
