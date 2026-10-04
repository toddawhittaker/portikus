/**
 * The settings dialog (SPEC.md §13.5): it shows what the server holds and
 * sends the changes back. Profile and Linked accounts have files of their own.
 */
import { EDITOR_SETTINGS_DEFAULTS } from "@portikus/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderWithQuery, stubFetch, USER } from "../test-utils.js";
import { SettingsDialog } from "./SettingsDialog.js";
import { SETTINGS_SECTIONS } from "./sections.js";
import {
	ACCOUNT_USER,
	buttonNamed,
	checkbox,
	openProfile,
	PROFILE,
	resetStubs,
	SERVER_ZONES,
	stub,
	stubSettings,
} from "./test-data.js";

afterEach(() => {
	document.documentElement.removeAttribute("data-theme");
	localStorage.clear();
	vi.unstubAllGlobals();
	resetStubs();
});

/** The settings dialog, appearance included. */
test("each section holds its own fields", async () => {
	stubSettings();
	renderWithQuery(<SettingsDialog onClose={() => {}} />);
	// The zone select waits for the server's list, so it arrives last.
	await waitFor(() => expect(screen.getByLabelText("Workspace timezone")).toBeTruthy());
	expect((screen.getByTestId("editor-settings-delay") as HTMLInputElement).value).toBe(
		"5",
	);

	const editor = screen.getByRole("region", { name: "Editor" });
	const terminal = screen.getByRole("region", { name: "Terminal" });
	const workspace = screen.getByRole("region", { name: "Workspace" });
	const appearance = screen.getByRole("region", { name: "Appearance" });

	expect(editor.textContent).toContain("Auto-save");
	expect(editor.textContent).toContain("Word wrap");
	expect(editor.contains(screen.getByTestId("editor-settings-delay"))).toBe(true);
	expect(terminal.textContent).toContain("Terminal colors");
	expect(workspace.textContent).toContain("Workspace timezone");
	expect(appearance.contains(screen.getByRole("group", { name: "Color scheme" }))).toBe(
		true,
	);
	expect(
		(within(appearance).getByRole("radio", { name: "System" }) as HTMLInputElement)
			.checked,
	).toBe(true);
});

test("it shows the settings the server holds", async () => {
	stubSettings({
		autoSave: false,
		autoSaveDelaySeconds: 12,
		wordWrap: true,
		terminalTheme: "light",
		timezone: "America/New_York",
		appearance: "system",
		screenReaderMode: false,
	});
	renderWithQuery(<SettingsDialog onClose={() => {}} />);

	await waitFor(() =>
		expect(
			(screen.getByTestId("editor-settings-delay") as HTMLInputElement).value,
		).toBe("12"),
	);
	expect((checkbox(/Auto-save/) as HTMLInputElement).checked).toBe(false);
	expect((checkbox(/Word wrap/) as HTMLInputElement).checked).toBe(true);
	expect(
		(
			within(screen.getByRole("region", { name: "Terminal" })).getByRole("switch", {
				name: "Light terminal",
			}) as HTMLInputElement
		).checked,
	).toBe(true);
});

/** A preference is saved the moment it changes, one field per request. */
test("a changed preference is saved at once and Saved is announced", async () => {
	const writes = stubSettings();
	const onClose = vi.fn();
	renderWithQuery(<SettingsDialog onClose={onClose} />);
	await waitFor(() =>
		expect(
			(screen.getByTestId("editor-settings-delay") as HTMLInputElement).value,
		).toBe("5"),
	);
	// The live region is there, empty, before anything changes.
	const status = screen.getByRole("status");
	expect(status.getAttribute("data-testid")).toBe("settings-saved");
	expect(status.textContent).toBe("");

	fireEvent.click(checkbox(/Word wrap/));

	await waitFor(() => expect(writes).toHaveLength(1));
	// The box starts ticked, so the click clears it.
	expect(writes[0]?.body).toEqual({ wordWrap: false });
	await waitFor(() => expect(status.textContent).toBe("Saved"));
	expect(onClose).not.toHaveBeenCalled();

	// One status line for the whole dialog. The shared pane starts Profile at
	// its top, not where Preferences was scrolled.
	const pane = screen.getByRole("heading", { name: "Preferences" }).parentElement
		?.parentElement as HTMLElement;
	pane.scrollTop = 300;
	expect(pane.scrollTop).toBe(300);
	fireEvent.click(screen.getByRole("button", { name: "Profile" }));
	expect(pane.scrollTop).toBe(0);
	expect(screen.getByTestId("settings-saved")).toBe(status);
});

test("changes made quickly are saved one at a time, in order", async () => {
	const sent: unknown[] = [];
	let current = { ...EDITOR_SETTINGS_DEFAULTS, timezones: SERVER_ZONES };
	let release: () => void = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	vi.stubGlobal(
		"fetch",
		vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			if ((init?.method ?? "GET") !== "GET") {
				const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
				sent.push(body);
				// The first answer is slow; the second must wait for it.
				if (sent.length === 1) await held;
				current = { ...current, ...body };
			}
			return json(200, current);
		}),
	);
	renderWithQuery(<SettingsDialog onClose={() => {}} />);
	const wrap = (await screen.findByRole("checkbox", {
		name: /Word wrap/,
	})) as HTMLInputElement;
	await waitFor(() => expect(wrap.checked).toBe(true));

	fireEvent.click(wrap);
	fireEvent.click(screen.getByRole("switch", { name: "Light terminal" }));
	await waitFor(() => expect(sent).toHaveLength(1));
	expect(screen.getByRole("status").textContent).toBe("Saving…");
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(sent).toHaveLength(1);

	release();
	await waitFor(() =>
		expect(sent).toEqual([{ wordWrap: false }, { terminalTheme: "light" }]),
	);
	await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Saved"));
});

test("the footer is a single Close button and it does not undo a change", async () => {
	const writes = stubSettings();
	const onClose = vi.fn();
	renderWithQuery(<SettingsDialog onClose={onClose} />);
	await screen.findByRole("region", { name: "Editor" });

	expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
	expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
	fireEvent.click(checkbox(/Word wrap/));
	fireEvent.click(screen.getByTestId("settings-close"));

	expect(onClose).toHaveBeenCalledTimes(1);
	await waitFor(() => expect(writes).toHaveLength(1));
});

/** A save that fails after the dialog has closed is not silent. */
test("a save that fails after the dialog has closed shows a danger toast", async () => {
	let release: () => void = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (url === "/me/profile") return json(200, PROFILE);
		if (url === "/me/links") return json(200, stub.myLinks);
		if (url === "/me/settings" && (init?.method ?? "GET") !== "GET") {
			await held;
			return json(500, { code: "INTERNAL", message: "The server could not save it." });
		}
		if (url === "/me/settings") {
			return json(200, { ...EDITOR_SETTINGS_DEFAULTS, timezones: SERVER_ZONES });
		}
		return json(404, { code: "NOT_FOUND", message: "no" });
	});
	function Host() {
		const [open, setOpen] = useState(true);
		return open ? <SettingsDialog onClose={() => setOpen(false)} /> : null;
	}
	renderWithQuery(<Host />);
	await screen.findByRole("region", { name: "Editor" });

	fireEvent.click(checkbox(/Word wrap/));
	fireEvent.click(screen.getByTestId("settings-close"));
	await waitFor(() => expect(screen.queryByTestId("settings-close")).toBeNull());
	release();

	const toast = await screen.findByText("Your settings change was not saved");
	expect(toast.closest(".pk-toast--danger")).not.toBeNull();
	expect(screen.getByText("The server could not save it.")).toBeDefined();
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

	await waitFor(() => expect(writes).toHaveLength(1));
	expect(writes[0]?.body).toEqual({ autoSave: false });
});

test("a typed delay is saved when the field is left, not on each keystroke", async () => {
	const writes = stubSettings();
	renderWithQuery(<SettingsDialog onClose={() => {}} />);
	const field = (await screen.findByTestId(
		"editor-settings-delay",
	)) as HTMLInputElement;
	await waitFor(() => expect(field.value).toBe("5"));

	fireEvent.change(field, { target: { value: "1" } });
	fireEvent.change(field, { target: { value: "18" } });
	expect(writes).toHaveLength(0);
	fireEvent.blur(field);

	await waitFor(() => expect(writes).toHaveLength(1));
	expect(writes[0]?.body).toEqual({ autoSaveDelaySeconds: 18 });
	// Leaving it again with the same value sends nothing more.
	fireEvent.blur(field);
	await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Saved"));
	expect(writes).toHaveLength(1);
});

test("Enter saves the typed delay", async () => {
	const writes = stubSettings();
	renderWithQuery(<SettingsDialog onClose={() => {}} />);
	const field = (await screen.findByTestId(
		"editor-settings-delay",
	)) as HTMLInputElement;
	await waitFor(() => expect(field.value).toBe("5"));

	fireEvent.change(field, { target: { value: "9" } });
	fireEvent.keyDown(field, { key: "Enter" });

	await waitFor(() => expect(writes).toHaveLength(1));
	expect(writes[0]?.body).toEqual({ autoSaveDelaySeconds: 9 });
});

test("closing the dialog saves a delay still being typed", async () => {
	const writes = stubSettings();
	const onClose = vi.fn();
	renderWithQuery(<SettingsDialog onClose={onClose} />);
	const field = (await screen.findByTestId(
		"editor-settings-delay",
	)) as HTMLInputElement;
	await waitFor(() => expect(field.value).toBe("5"));

	fireEvent.change(field, { target: { value: "12" } });
	fireEvent.keyDown(field, { key: "Escape" });

	expect(onClose).toHaveBeenCalled();
	await waitFor(() => expect(writes).toHaveLength(1));
	expect(writes[0]?.body).toEqual({ autoSaveDelaySeconds: 12 });
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
	fireEvent.blur(screen.getByTestId("editor-settings-delay"));
	fireEvent.click(screen.getByTestId("settings-close"));
	expect(writes).toHaveLength(0);
});

/**
 * Page appearance is chosen here, applied at once,
 * cached in this browser, and saved on the server at once. It does not
 * change the terminal color scheme sent with everything else.
 */
test("choosing an appearance applies at once, is cached, and is saved", async () => {
	const writes = stubSettings();
	renderWithQuery(<SettingsDialog onClose={() => {}} />);
	const terminal = () => screen.getByRole("region", { name: "Terminal" });
	const appearance = () => screen.getByRole("region", { name: "Appearance" });
	await waitFor(() =>
		expect(
			(
				within(terminal()).getByRole("switch", {
					name: "Light terminal",
				}) as HTMLInputElement
			).checked,
		).toBe(false),
	);

	fireEvent.click(within(appearance()).getByRole("radio", { name: "Light" }));

	expect(document.documentElement.getAttribute("data-theme")).toBe("light");
	expect(localStorage.getItem("pk-theme")).toBe("light");
	expect(
		(
			within(terminal()).getByRole("switch", {
				name: "Light terminal",
			}) as HTMLInputElement
		).checked,
	).toBe(false);

	await waitFor(() => expect(writes).toHaveLength(1));
	expect(writes[0]?.body).toEqual({ appearance: "light" });

	fireEvent.click(within(appearance()).getByRole("radio", { name: "System" }));
	expect(document.documentElement.getAttribute("data-theme")).toBeNull();
	expect(localStorage.getItem("pk-theme")).toBe("system");
	await waitFor(() => expect(writes).toHaveLength(2));
	expect(writes[1]?.body).toEqual({ appearance: "system" });
});

/**
 * The dialog shows the stored terminal theme, and switching it
 * saves only that.
 */
test("the stored terminal theme is shown and a switch saves it", async () => {
	const writes = stubSettings({
		autoSave: true,
		autoSaveDelaySeconds: 5,
		wordWrap: false,
		terminalTheme: "light",
		timezone: "America/New_York",
		appearance: "system",
		screenReaderMode: false,
	});
	renderWithQuery(<SettingsDialog onClose={() => {}} />);
	const terminal = () => screen.getByRole("region", { name: "Terminal" });
	await waitFor(() =>
		expect(
			(
				within(terminal()).getByRole("switch", {
					name: "Light terminal",
				}) as HTMLInputElement
			).checked,
		).toBe(true),
	);
	fireEvent.click(within(terminal()).getByRole("switch", { name: "Light terminal" }));

	await waitFor(() => expect(writes).toHaveLength(1));
	expect(writes[0]?.body).toEqual({ terminalTheme: "dark" });
});

/**
 * The dialog shows the stored zone. Choosing a different zone
 * from the Radix list needs a real browser, so that is covered in
 * e2e/timezone.spec.ts.
 */
test("the stored timezone is shown", async () => {
	stubSettings({
		autoSave: true,
		autoSaveDelaySeconds: 5,
		wordWrap: false,
		terminalTheme: "dark",
		timezone: "Europe/Berlin",
		appearance: "system",
		screenReaderMode: false,
	});
	renderWithQuery(<SettingsDialog onClose={() => {}} />);
	await waitFor(() =>
		expect(screen.getByLabelText("Workspace timezone").textContent).toContain(
			"Europe/Berlin",
		),
	);
});

/**
 * The zone select is built from the list the server sent with the
 * settings, so it can only offer names the API accepts. The browser's own
 * zone list, which differs, is never read.
 */
test("the zone select offers exactly the zones the server sent", async () => {
	stubSettings();
	renderWithQuery(<SettingsDialog onClose={() => {}} />);
	// The select takes no choice until the server's list is there, so waiting
	// for the zone to show is not enough: wait for it to be usable.
	await waitFor(() =>
		expect(screen.getByLabelText("Workspace timezone").hasAttribute("disabled")).toBe(
			false,
		),
	);

	fireEvent.click(screen.getByLabelText("Workspace timezone"));
	const offered = await waitFor(() => {
		const found = screen.getAllByRole("option");
		expect(found.length).toBe(SERVER_ZONES.length);
		return found;
	});
	expect(offered.map((option) => option.textContent).sort()).toEqual([
		"America/New York (current)",
		"Berlin",
		"Madrid",
		"Tokyo",
		"UTC",
	]);
});

/**
 * While the zone list is still on its way the setting is shown, not left
 * out: an empty space where a setting belongs reads as a fault. It takes no
 * choice until the list it would have to choose from is there.
 */
test("the zone select waits with the current zone, not with nothing", async () => {
	// A request that never answers: the dialog stays in its loading state.
	vi.stubGlobal(
		"fetch",
		vi.fn(() => new Promise<Response>(() => {})),
	);
	renderWithQuery(<SettingsDialog onClose={() => {}} />);

	const select = await screen.findByLabelText("Workspace timezone");
	expect(select.textContent).toContain("America/New York");
	expect(select.hasAttribute("disabled")).toBe(true);
});

/** A zone list that does not arrive at all says so in one line. */
test("a failed settings request explains why the zone cannot be changed", async () => {
	stubFetch(() => json(500, { code: "INTERNAL", message: "no" }));
	renderWithQuery(<SettingsDialog onClose={() => {}} />);

	await waitFor(() =>
		expect(screen.getByTestId("editor-settings-zones-error").textContent).toContain(
			"could not be loaded",
		),
	);
	expect(screen.getByLabelText("Workspace timezone").hasAttribute("disabled")).toBe(
		true,
	);
});

test("settings opens on Preferences, with Profile first in the list", async () => {
	stubSettings();
	renderWithQuery(<SettingsDialog onClose={() => {}} />);
	await waitFor(() => expect(screen.getByLabelText("Workspace timezone")).toBeTruthy());

	expect(
		screen.getByRole("button", { name: "Preferences" }).getAttribute("aria-current"),
	).toBe("page");
	const nav = screen.getByRole("navigation", { name: "Settings sections" });
	expect(within(nav).getAllByRole("button")[0]?.textContent).toBe("Profile");
	// Account is folded into Profile.
	expect(screen.queryByRole("button", { name: "Account" })).toBeNull();
	expect(screen.getByRole("heading", { name: "Preferences" })).toBeTruthy();
	expect(screen.queryByLabelText("Display name")).toBeNull();
});

test("the saved appearance is shown and wins over this browser's copy", async () => {
	localStorage.setItem("pk-theme", "light");
	stubSettings({ ...EDITOR_SETTINGS_DEFAULTS, appearance: "dark" });
	renderWithQuery(<SettingsDialog onClose={() => {}} />);
	const appearance = () => screen.getByRole("region", { name: "Appearance" });

	await waitFor(() =>
		expect(
			(within(appearance()).getByRole("radio", { name: "Dark" }) as HTMLInputElement)
				.checked,
		).toBe(true),
	);
	expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
	expect(localStorage.getItem("pk-theme")).toBe("dark");
});

test("every control label on the section list is a search hit", async () => {
	stubSettings(EDITOR_SETTINGS_DEFAULTS, { ...USER, localPassword: true });
	renderWithQuery(<SettingsDialog onClose={() => {}} />);
	await waitFor(() => expect(screen.getByLabelText("Search")).toBeTruthy());
	await screen.findByRole("button", { name: "Password" });

	for (const section of SETTINGS_SECTIONS) {
		for (const group of section.groups) {
			for (const control of group.controls) {
				fireEvent.change(screen.getByLabelText("Search"), {
					target: { value: control.label },
				});
				expect(buttonNamed(control.label)).toBeTruthy();
			}
		}
	}
});

test("choosing a search hit opens the section and shows that control", async () => {
	stubSettings();
	renderWithQuery(<SettingsDialog onClose={() => {}} />);
	await waitFor(() => expect(screen.getByLabelText("Search")).toBeTruthy());

	fireEvent.change(screen.getByLabelText("Search"), { target: { value: "word wrap" } });
	expect(screen.queryByRole("button", { name: "Profile" })).toBeNull();
	fireEvent.click(buttonNamed("Word wrap"));

	const frame = document.getElementById("settings-control-word-wrap");
	expect(frame?.getAttribute("data-highlighted")).toBe("true");
	expect(frame?.contains(checkbox(/Word wrap/))).toBe(true);
	expect(screen.getByRole("heading", { name: "Editor" })).toBeTruthy();
});

test("a search with no match says so", async () => {
	stubSettings();
	renderWithQuery(<SettingsDialog onClose={() => {}} />);
	await waitFor(() => expect(screen.getByLabelText("Search")).toBeTruthy());

	fireEvent.change(screen.getByLabelText("Search"), { target: { value: "billing" } });
	expect(screen.getByText("No matching settings.")).toBeTruthy();
	expect(screen.queryByRole("button", { name: "Preferences" })).toBeNull();
});

/** The long explanations sit behind a help button beside each control. */
test("the long explanations are toggletips beside their controls", async () => {
	stubSettings(EDITOR_SETTINGS_DEFAULTS, ACCOUNT_USER);
	renderWithQuery(<SettingsDialog onClose={() => {}} />);
	await screen.findByRole("region", { name: "Accessibility" });
	for (const name of [
		"About Auto-save delay",
		"About Terminal colors",
		"About Screen reader mode",
		"About Workspace timezone",
	]) {
		expect(screen.getByRole("button", { name })).toBeTruthy();
	}
	// The help button is not part of the checkbox's name.
	expect(checkbox(/Screen reader mode/).closest("label")?.textContent).not.toContain(
		"dictation",
	);

	await openProfile();
	expect(screen.getByRole("button", { name: "About Workspace label" })).toBeTruthy();
	await screen.findByTestId("link-sso");
	expect(screen.getByRole("button", { name: "About Linked accounts" })).toBeTruthy();
});

/** Screen-reader mode is a per-user setting. */
test("screen reader mode shows what is stored and is saved when turned on", async () => {
	const writes = stubSettings({ ...EDITOR_SETTINGS_DEFAULTS, screenReaderMode: false });
	renderWithQuery(<SettingsDialog onClose={() => {}} />);
	const region = await screen.findByRole("region", { name: "Accessibility" });
	const box = within(region).getByRole("checkbox", {
		name: /Screen reader mode/,
	}) as HTMLInputElement;
	await waitFor(() => expect(box.checked).toBe(false));

	fireEvent.click(box);

	await waitFor(() => expect(writes).toHaveLength(1));
	expect(writes[0]?.body).toEqual({ screenReaderMode: true });
});

/** The switch is named for what "on" means, whatever it shows. */
test("the terminal colours switch is named Light terminal", async () => {
	stubSettings();
	renderWithQuery(<SettingsDialog onClose={() => {}} />);
	const terminal = await screen.findByRole("region", { name: "Terminal" });
	const toggle = within(terminal).getByRole("switch", { name: "Light terminal" });
	fireEvent.click(toggle);
	expect(within(terminal).getByRole("switch", { name: "Light terminal" })).toBe(toggle);
});

/** The keys and the library limits live on the Help page. */
test("Accessibility points to the keys on the Help page, in a new tab", async () => {
	stubSettings();
	renderWithQuery(<SettingsDialog onClose={() => {}} />);
	const region = await screen.findByRole("region", { name: "Accessibility" });

	const link = within(region).getByRole("link", {
		name: /^Help ?\(opens in a new tab\)$/,
	});
	expect(link.getAttribute("href")).toBe("/help#student-keyboard");
	expect(link.getAttribute("target")).toBe("_blank");
	expect(link.getAttribute("rel")).toBe("noopener");
	expect(link.closest("p")?.textContent).toBe(
		"Keys and screen-reader limits are in Help (opens in a new tab).",
	);
	expect(
		screen.queryByRole("button", { name: "Keyboard and screen readers" }),
	).toBeNull();
});

/** Search still finds the pointer, now under Accessibility. */
test("searching for keyboard finds the pointer to Help", async () => {
	stubSettings();
	renderWithQuery(<SettingsDialog onClose={() => {}} />);
	fireEvent.change(await screen.findByLabelText("Search"), {
		target: { value: "keyboard" },
	});
	fireEvent.click(buttonNamed("Keyboard and screen readers"));

	const frame = document.getElementById("settings-control-keyboard-help");
	expect(frame?.getAttribute("data-highlighted")).toBe("true");
	expect(frame?.querySelector("a")?.getAttribute("href")).toBe(
		"/help#student-keyboard",
	);
});

/** A failed save is announced, not only shown, and the control goes back. */
test("a failed save is shown as an alert and the control shows what the server holds", async () => {
	stubFetch((url, init) => {
		if ((init?.method ?? "GET") !== "GET") {
			return json(500, { code: "INTERNAL", message: "The settings were not saved." });
		}
		if (url === "/me/settings") {
			return json(200, { ...EDITOR_SETTINGS_DEFAULTS, timezones: SERVER_ZONES });
		}
		throw new Error(`unexpected request to ${url}`);
	});
	renderWithQuery(<SettingsDialog onClose={() => {}} />);
	await screen.findByRole("region", { name: "Editor" });
	const wrap = checkbox(/Word wrap/) as HTMLInputElement;
	await waitFor(() => expect(wrap.checked).toBe(true));
	fireEvent.click(wrap);

	const alert = await screen.findByRole("alert");
	expect(alert.getAttribute("data-testid")).toBe("editor-settings-error");
	expect(alert.textContent).toContain("Your change was not saved.");
	expect((checkbox(/Word wrap/) as HTMLInputElement).checked).toBe(true);
});

test("Password is offered to a Dex local password and not to an SSO account (SPEC.md section 5.3)", async () => {
	stubSettings(EDITOR_SETTINGS_DEFAULTS, { ...USER, localPassword: true });
	renderWithQuery(<SettingsDialog onClose={() => {}} />);
	fireEvent.click(await screen.findByRole("button", { name: "Password" }));
	expect(await screen.findByRole("heading", { name: "Password" })).toBeTruthy();
	expect(screen.getByLabelText("Current password")).toBeTruthy();
	expect(screen.getByLabelText("New password")).toBeTruthy();
	expect(screen.getByLabelText("New password again")).toBeTruthy();
});

test("an SSO account has no Password section, not even in search", async () => {
	stubSettings(EDITOR_SETTINGS_DEFAULTS, USER);
	renderWithQuery(<SettingsDialog onClose={() => {}} />);
	await screen.findByRole("button", { name: "Profile" });
	// Wait for /auth/me, so the absence is not just the loading state.
	await waitFor(() =>
		expect(vi.mocked(fetch).mock.calls.some(([url]) => url === "/auth/me")).toBe(true),
	);
	expect(screen.queryByRole("button", { name: "Password" })).toBeNull();
	fireEvent.change(screen.getByLabelText("Search"), {
		target: { value: "change password" },
	});
	expect(screen.getByText("No matching settings.")).toBeTruthy();
});

test("choosing the Change password search hit puts focus on the form's first field", async () => {
	stubSettings(EDITOR_SETTINGS_DEFAULTS, { ...USER, localPassword: true });
	renderWithQuery(<SettingsDialog onClose={() => {}} />);
	await screen.findByRole("button", { name: "Password" });
	fireEvent.change(screen.getByLabelText("Search"), {
		target: { value: "change password" },
	});
	fireEvent.click(buttonNamed("Change password"));
	await waitFor(() =>
		expect(document.activeElement).toBe(screen.getByLabelText("Current password")),
	);
});

test("a second password change in one visit is announced again", async () => {
	stubSettings(EDITOR_SETTINGS_DEFAULTS, { ...USER, localPassword: true });
	renderWithQuery(<SettingsDialog onClose={() => {}} />);
	fireEvent.click(await screen.findByRole("button", { name: "Password" }));
	const status = await screen.findByTestId("password-changed");

	async function change(from: string, to: string) {
		fireEvent.change(screen.getByLabelText("Current password"), {
			target: { value: from },
		});
		fireEvent.change(screen.getByLabelText("New password"), { target: { value: to } });
		fireEvent.change(screen.getByLabelText("New password again"), {
			target: { value: to },
		});
		fireEvent.click(screen.getByRole("button", { name: "Change password" }));
	}

	await change("old-password-one", "correct horse battery staple");
	await waitFor(() =>
		expect(status.textContent).toBe("Your password has been changed."),
	);
	await change("correct horse battery staple", "another long passphrase here");
	// The message is cleared as the second submit starts, so its return is a new announcement.
	expect(status.textContent).toBe("");
	await waitFor(() =>
		expect(status.textContent).toBe("Your password has been changed."),
	);
});
