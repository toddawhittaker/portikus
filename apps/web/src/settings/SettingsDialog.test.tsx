/**
 * The editor settings dialog (SPEC.md §13.5): it shows what the
 * server holds and sends the changes back.
 */
import { EDITOR_SETTINGS_DEFAULTS } from "@portikus/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderWithQuery, stubFetch, USER } from "../test-utils.js";
import { SettingsDialog } from "./SettingsDialog.js";
import { SETTINGS_SECTIONS } from "./sections.js";

afterEach(() => {
	document.documentElement.removeAttribute("data-theme");
	localStorage.clear();
	vi.unstubAllGlobals();
});

interface Sent {
	body: unknown;
}

/**
 * The zone names the server says it accepts. The dialog offers these and
 * nothing else, so the browser's own zone list never comes into it.
 */
const SERVER_ZONES = [
	"UTC",
	"America/New_York",
	"Europe/Berlin",
	"Europe/Madrid",
	"Asia/Tokyo",
];

/** Answers GET /me/settings with `stored` and records what is written. */
function stubSettings(
	stored = EDITOR_SETTINGS_DEFAULTS,
	user: Record<string, unknown> | null = null,
) {
	const writes: Sent[] = [];
	let current = { ...stored, timezones: SERVER_ZONES };
	let profile = { ...PROFILE };
	profileWrites = [];
	stubFetch((url, init) => {
		if (url === "/auth/me") {
			if (!user) throw new Error("unexpected request to /auth/me");
			return json(200, user);
		}
		if (url === "/me/profile") {
			if ((init?.method ?? "GET") !== "GET") {
				const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
				profileWrites.push({ body });
				profile = { ...profile, ...body };
			}
			return json(200, profile);
		}
		if (url === "/me/links") return json(200, myLinks);
		if (url === "/me/links/start") {
			linkWrites.push(url);
			return startAnswer;
		}
		if (url.startsWith("/me/links/") && url.endsWith("/unlink")) {
			linkWrites.push(url);
			myLinks = {
				...myLinks,
				links: myLinks.links.filter((link) => !url.includes(link.courseUserId)),
			};
			return json(200, { signedOut: unlinkSignsOut });
		}
		if (url === "/me/password") return new Response(null, { status: 204 });
		if (url === "/me/picture") {
			return json(413, { code: "FILE_TOO_LARGE", message: "The picture is too big" });
		}
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

/** What GET /me/profile answers with before anything is changed. */
const PROFILE = {
	displayName: "Alice Example",
	email: "alice@example.edu",
	workspaceLabel: "alice",
	github: null,
	website: null,
	picture: null,
};

/** Profile writes seen by the last stubSettings. */
let profileWrites: Sent[] = [];

/** What GET /me/links answers; an SSO account with no links unless a test says otherwise. */
let myLinks: {
	source: string;
	linkUntil: string | null;
	links: { courseUserId: string; [key: string]: unknown }[];
	launch: null;
} = { source: "sso", linkUntil: null, links: [], launch: null };
let startAnswer = json(200, { redirectUrl: "https://sso.example.edu/authorize?x=1" });
let linkWrites: string[] = [];
let unlinkSignsOut = false;

afterEach(() => {
	myLinks = { source: "sso", linkUntil: null, links: [], launch: null };
	startAnswer = json(200, { redirectUrl: "https://sso.example.edu/authorize?x=1" });
	linkWrites = [];
	unlinkSignsOut = false;
});

function checkbox(name: RegExp) {
	return screen.getByRole("checkbox", { name });
}

/** The accessible name is the whole string, not a substring of a longer one. */
function buttonNamed(label: string): HTMLElement {
	const found = screen
		.getAllByRole("button")
		.filter((button) => button.textContent === label);
	expect(found).toHaveLength(1);
	const button = found[0];
	if (!button) throw new Error(`missing button ${label}`);
	return button;
}

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
		if (url === "/me/links") return json(200, myLinks);
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

const ACCOUNT_USER = { ...USER, signInName: "university-alice" };

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

async function openProfile() {
	fireEvent.click(await screen.findByRole("button", { name: "Profile" }));
	await screen.findByLabelText("GitHub");
}

test("Profile shows the institution sign-in, read-only", async () => {
	stubSettings(EDITOR_SETTINGS_DEFAULTS, ACCOUNT_USER);
	renderWithQuery(<SettingsDialog onClose={() => {}} />);
	await openProfile();

	expect(screen.getByText(/come from the institution sign-in/)).toBeTruthy();
	expect(screen.getByTestId("account-initials").textContent).toBe("AE");
	// Label and value pairs, not form fields.
	const list = screen.getByTestId("profile-signin");
	expect(list.tagName).toBe("DL");
	const pairs = within(list)
		.getAllByRole("term")
		.map((term) => [term.textContent, term.nextElementSibling?.textContent]);
	expect(pairs).toEqual([
		["Display name", "Alice Example"],
		["Email", PROFILE.email],
		["Sign-in name", "university-alice"],
		["Workspace label", "alice"],
	]);
	expect(within(list).queryByRole("textbox")).toBeNull();
});

/** The value beside a sign-in label, read from the description list. */
function signInValue(label: string): string | null | undefined {
	const term = within(screen.getByTestId("profile-signin"))
		.getAllByRole("term")
		.find((item) => item.textContent === label);
	return term?.nextElementSibling?.textContent;
}

test("a missing email is shown as not provided", async () => {
	stubSettings(EDITOR_SETTINGS_DEFAULTS, ACCOUNT_USER);
	stubFetch((url) => {
		if (url === "/auth/me") return json(200, ACCOUNT_USER);
		if (url === "/me/profile") return json(200, { ...PROFILE, email: null });
		return json(200, { ...EDITOR_SETTINGS_DEFAULTS, timezones: SERVER_ZONES });
	});
	renderWithQuery(<SettingsDialog onClose={() => {}} />);
	await openProfile();

	expect(signInValue("Email")).toBe("Not provided");
});

test("choosing the sign-in name hit opens Profile on that field", async () => {
	stubSettings(EDITOR_SETTINGS_DEFAULTS, ACCOUNT_USER);
	renderWithQuery(<SettingsDialog onClose={() => {}} />);
	await waitFor(() => expect(screen.getByLabelText("Search")).toBeTruthy());

	fireEvent.change(screen.getByLabelText("Search"), { target: { value: "sign-in" } });
	fireEvent.click(buttonNamed("Sign-in name"));

	await screen.findByTestId("profile-signin");
	expect(signInValue("Sign-in name")).toBe("university-alice");
	expect(
		document
			.getElementById("settings-control-sign-in-name")
			?.getAttribute("data-highlighted"),
	).toBe("true");
});

test("a failed account request explains that the details are missing", async () => {
	stubFetch((url) => {
		if (url === "/auth/me") return json(500, { code: "INTERNAL", message: "no" });
		if (url === "/me/profile") return json(200, PROFILE);
		if (url === "/me/settings") {
			return json(200, { ...EDITOR_SETTINGS_DEFAULTS, timezones: SERVER_ZONES });
		}
		throw new Error(`unexpected request to ${url}`);
	});
	renderWithQuery(<SettingsDialog onClose={() => {}} />);
	fireEvent.click(await screen.findByRole("button", { name: "Profile" }));

	expect((await screen.findByTestId("account-error")).textContent).toContain(
		"could not be loaded",
	);
});

/** Links save like the delay, on leaving the field, Enter or close. */
test("a link is saved when the field is left and shown as a plain anchor", async () => {
	const writes = stubSettings(EDITOR_SETTINGS_DEFAULTS, ACCOUNT_USER);
	const onClose = vi.fn();
	renderWithQuery(<SettingsDialog onClose={onClose} />);
	await openProfile();
	expect(screen.queryByRole("button", { name: "Save links" })).toBeNull();

	const githubField = screen.getByLabelText("GitHub");
	fireEvent.change(githubField, { target: { value: " alice-ex " } });
	expect(profileWrites).toHaveLength(0);
	fireEvent.blur(githubField);
	await waitFor(() =>
		expect(profileWrites.map((write) => write.body)).toEqual([{ github: "alice-ex" }]),
	);
	await waitFor(() =>
		expect(screen.getByTestId("settings-saved").textContent).toBe("Saved"),
	);
	// Leaving it again sends nothing more.
	fireEvent.blur(githubField);

	const siteField = screen.getByLabelText("Personal site");
	fireEvent.change(siteField, { target: { value: "https://alice.example.edu/" } });
	fireEvent.keyDown(siteField, { key: "Enter" });
	await waitFor(() => expect(profileWrites).toHaveLength(2));
	expect(profileWrites[1]?.body).toEqual({ website: "https://alice.example.edu/" });
	expect(writes).toHaveLength(0);
	expect(onClose).not.toHaveBeenCalled();

	const github = await screen.findByTestId("profile-github-link");
	expect(github.tagName).toBe("A");
	expect(github.getAttribute("href")).toBe("https://github.com/alice-ex");
	expect(github.getAttribute("rel")).toBe("noopener");
	const site = await screen.findByTestId("profile-website-link");
	expect(site.getAttribute("href")).toBe("https://alice.example.edu/");
	expect(site.getAttribute("rel")).toBe("noopener");
});

test("closing the dialog saves a link still being typed, once", async () => {
	stubSettings(EDITOR_SETTINGS_DEFAULTS, ACCOUNT_USER);
	const onClose = vi.fn();
	renderWithQuery(<SettingsDialog onClose={onClose} />);
	await openProfile();

	const field = screen.getByLabelText("GitHub");
	fireEvent.change(field, { target: { value: "alice-ex" } });
	// Pressing Close first takes focus from the field, then closes.
	fireEvent.blur(field);
	fireEvent.click(screen.getByTestId("settings-close"));

	expect(onClose).toHaveBeenCalled();
	await waitFor(() =>
		expect(profileWrites.map((write) => write.body)).toEqual([{ github: "alice-ex" }]),
	);
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(profileWrites).toHaveLength(1);
});

test("an invalid link keeps its error and is not sent, but a valid one beside it is", async () => {
	const writes = stubSettings(EDITOR_SETTINGS_DEFAULTS, ACCOUNT_USER);
	const onClose = vi.fn();
	renderWithQuery(<SettingsDialog onClose={onClose} />);
	await openProfile();

	fireEvent.change(screen.getByLabelText("Personal site"), {
		target: { value: "javascript:alert(1)" },
	});
	expect(screen.getByText("Give an https:// link")).toBeTruthy();
	fireEvent.blur(screen.getByLabelText("Personal site"));
	fireEvent.change(screen.getByLabelText("GitHub"), {
		target: { value: "http://github.com/alice" },
	});
	expect(screen.getByText("Give a GitHub username or an https:// link")).toBeTruthy();
	fireEvent.keyDown(screen.getByLabelText("GitHub"), { key: "Enter" });
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(profileWrites).toHaveLength(0);

	fireEvent.change(screen.getByLabelText("GitHub"), { target: { value: "alice" } });
	fireEvent.click(screen.getByTestId("settings-close"));
	await waitFor(() =>
		expect(profileWrites.map((write) => write.body)).toEqual([{ github: "alice" }]),
	);
	expect(writes).toHaveLength(0);
});

/** The long explanations sit behind a help button beside each control. */
test("the long explanations are toggletips beside their controls", async () => {
	stubSettings(EDITOR_SETTINGS_DEFAULTS, ACCOUNT_USER);
	renderWithQuery(<SettingsDialog onClose={() => {}} />);
	await screen.findByRole("region", { name: "Accessibility" });
	for (const name of [
		"About Auto-save delay in seconds",
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

/** A labelled button opens the file picker; the native input is hidden. */
test("Choose picture opens the hidden file input", async () => {
	stubSettings(EDITOR_SETTINGS_DEFAULTS, ACCOUNT_USER);
	renderWithQuery(<SettingsDialog onClose={() => {}} />);
	await openProfile();

	const input = screen.getByTestId("profile-picture-input") as HTMLInputElement;
	expect(input.hidden).toBe(true);
	const opened = vi.spyOn(input, "click");
	fireEvent.click(screen.getByRole("button", { name: "Choose picture…" }));
	expect(opened).toHaveBeenCalled();
	// No picture yet, so there is nothing to remove.
	expect(screen.queryByRole("button", { name: "Remove picture" })).toBeNull();
});

test("a refused picture upload shows the server's reason", async () => {
	stubSettings(EDITOR_SETTINGS_DEFAULTS, ACCOUNT_USER);
	renderWithQuery(<SettingsDialog onClose={() => {}} />);
	await openProfile();

	const file = new File([new Uint8Array(8)], "me.png", { type: "image/png" });
	fireEvent.change(screen.getByTestId("profile-picture-input"), {
		target: { files: [file] },
	});

	expect((await screen.findByTestId("profile-picture-error")).textContent).toBe(
		"The picture is too big",
	);
});

test("a picture over the cap is refused before it is sent", async () => {
	stubSettings(EDITOR_SETTINGS_DEFAULTS, ACCOUNT_USER);
	renderWithQuery(<SettingsDialog onClose={() => {}} />);
	await openProfile();
	const sent = vi.mocked(fetch).mock.calls.length;

	const file = new File([new Uint8Array(1024 * 1024 + 1)], "big.png", {
		type: "image/png",
	});
	fireEvent.change(screen.getByTestId("profile-picture-input"), {
		target: { files: [file] },
	});

	expect((await screen.findByTestId("profile-picture-error")).textContent).toBe(
		"The picture must be at most 1 MiB",
	);
	expect(vi.mocked(fetch).mock.calls.length).toBe(sent);
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

/** ADR 0026. */
async function openLinked() {
	renderWithQuery(<SettingsDialog onClose={() => {}} />);
	await openProfile();
	return await screen.findByRole("region", { name: "Linked accounts" });
}

function minutesFromNow(minutes: number): string {
	return new Date(Date.now() + minutes * 60_000).toISOString();
}

function courseLinks() {
	myLinks = {
		source: "course",
		linkUntil: minutesFromNow(10),
		links: [],
		launch: null,
	};
	stubSettings(EDITOR_SETTINGS_DEFAULTS, ACCOUNT_USER);
}

function tell(message: { type: string }) {
	const channel = new BroadcastChannel("portikus-link");
	channel.postMessage(message);
	channel.close();
}

function fakeTab() {
	return { opener: {} as unknown, location: { href: "" }, close: vi.fn() };
}

test("Link to my SSO account starts the link here and sends a new tab to the SSO sign-in", async () => {
	const tab = fakeTab();
	const open = vi.fn(() => tab);
	vi.stubGlobal("open", open);
	courseLinks();
	const region = await openLinked();

	fireEvent.click(
		await within(region).findByRole("button", { name: "Link to my SSO account" }),
	);

	expect(open).toHaveBeenCalledWith("", "_blank");
	expect(tab.opener).toBeNull();
	await waitFor(() =>
		expect(tab.location.href).toBe("https://sso.example.edu/authorize?x=1"),
	);
	expect(linkWrites).toEqual(["/me/links/start"]);
	expect(within(region).getByRole("status").textContent).toBe(
		"Finish signing in in the new tab.",
	);
	const reopen = within(region).getByRole("button", {
		name: "Open the sign-in tab again",
	});
	expect(document.activeElement).toBe(reopen);
	fireEvent.click(reopen);
	expect(open).toHaveBeenCalledTimes(2);
});

test("a refused start closes the new tab and is announced in Settings", async () => {
	const tab = fakeTab();
	vi.stubGlobal(
		"open",
		vi.fn(() => tab),
	);
	startAnswer = json(403, {
		code: "FORBIDDEN",
		message: "Open Portikus again from your course to link it.",
	});
	courseLinks();
	const region = await openLinked();

	fireEvent.click(
		await within(region).findByRole("button", { name: "Link to my SSO account" }),
	);

	expect((await within(region).findByRole("alert")).textContent).toBe(
		"Open Portikus again from your course to link it.",
	);
	expect(tab.close).toHaveBeenCalled();
	expect(tab.location.href).toBe("");
	await waitFor(() =>
		expect(document.activeElement).toBe(
			within(region).getByRole("button", { name: "Link to my SSO account" }),
		),
	);
});

test("a blocked pop-up falls back to the start page in this tab", async () => {
	vi.stubGlobal(
		"open",
		vi.fn(() => null),
	);
	const assign = vi.fn();
	vi.stubGlobal("location", { ...window.location, assign });
	courseLinks();
	const region = await openLinked();

	fireEvent.click(
		await within(region).findByRole("button", { name: "Link to my SSO account" }),
	);

	expect(assign).toHaveBeenCalledWith("/link/start");
});

test("the waiting tab stops waiting when the new tab cancels", async () => {
	vi.stubGlobal(
		"open",
		vi.fn(() => fakeTab()),
	);
	courseLinks();
	const region = await openLinked();
	fireEvent.click(
		await within(region).findByRole("button", { name: "Link to my SSO account" }),
	);

	tell({ type: "cancelled" });
	const start = await within(region).findByRole("button", {
		name: "Link to my SSO account",
	});
	await waitFor(() => expect(document.activeElement).toBe(start));
	expect(within(region).getByRole("status").textContent).toBe("");
});

test("a course session past the 15-minute window is told to open Portikus again", async () => {
	myLinks = {
		source: "course",
		linkUntil: minutesFromNow(-1),
		links: [],
		launch: null,
	};
	stubSettings(EDITOR_SETTINGS_DEFAULTS, ACCOUNT_USER);
	const region = await openLinked();

	expect((await within(region).findByTestId("link-too-late")).textContent).toBe(
		"Open Portikus again from your course to link it.",
	);
	expect(
		within(region).queryByRole("button", { name: "Link to my SSO account" }),
	).toBeNull();
});

test("an SSO account with no links says how to link one and offers no button", async () => {
	stubSettings(EDITOR_SETTINGS_DEFAULTS, ACCOUNT_USER);
	const region = await openLinked();

	expect(await within(region).findByText(/No course sign-ins are linked/)).toBeTruthy();
	// Only the help button beside the heading; nothing to link or unlink.
	expect(
		within(region)
			.getAllByRole("button")
			.map((button) => button.getAttribute("aria-label")),
	).toEqual(["About Linked accounts"]);
});

test("an SSO account lists its links and unlinks one", async () => {
	const courseUserId = "33333333-3333-4333-8333-333333333333";
	myLinks = {
		source: "sso",
		linkUntil: null,
		links: [
			{
				courseUserId,
				platformName: "mock-lms",
				displayName: "Sam Student",
				linkedAt: "2026-09-24T12:00:00.000Z",
			},
		],
		launch: null,
	};
	stubSettings(EDITOR_SETTINGS_DEFAULTS, ACCOUNT_USER);
	const region = await openLinked();

	fireEvent.click(
		await within(region).findByRole("button", {
			name: "Unlink Sam Student from mock-lms",
		}),
	);

	await waitFor(() =>
		expect(within(region).getByRole("status").textContent).toMatch(/^Unlinked\./),
	);
	expect(linkWrites).toEqual([`/me/links/${courseUserId}/unlink`]);
	expect(await within(region).findByText(/No course sign-ins are linked/)).toBeTruthy();
	// The last row is gone, so focus lands on the section heading.
	await waitFor(() =>
		expect(document.activeElement?.id).toBe("settings-profile-linked"),
	);
});

test("an unlink that ends this session goes to the unlinked page", async () => {
	const assign = vi.fn();
	vi.stubGlobal("location", { ...window.location, assign });
	unlinkSignsOut = true;
	myLinks = {
		source: "sso",
		linkUntil: null,
		links: [
			{
				courseUserId: "33333333-3333-4333-8333-333333333333",
				platformName: "mock-lms",
				displayName: "Sam Student",
				linkedAt: "2026-09-24T12:00:00.000Z",
			},
		],
		launch: null,
	};
	stubSettings(EDITOR_SETTINGS_DEFAULTS, ACCOUNT_USER);
	const region = await openLinked();

	fireEvent.click(
		await within(region).findByRole("button", {
			name: "Unlink Sam Student from mock-lms",
		}),
	);

	await waitFor(() => expect(assign).toHaveBeenCalledWith("/unlinked"));
});

test("after an unlink, focus moves to the next Unlink button", async () => {
	const first = "33333333-3333-4333-8333-333333333333";
	const second = "44444444-4444-4444-8444-444444444444";
	const row = (courseUserId: string, displayName: string) => ({
		courseUserId,
		platformName: "mock-lms",
		displayName,
		linkedAt: "2026-09-24T12:00:00.000Z",
	});
	myLinks = {
		source: "sso",
		linkUntil: null,
		links: [row(first, "Sam Student"), row(second, "Sam Other")],
		launch: null,
	};
	stubSettings(EDITOR_SETTINGS_DEFAULTS, ACCOUNT_USER);
	const region = await openLinked();

	fireEvent.click(
		await within(region).findByRole("button", {
			name: "Unlink Sam Student from mock-lms",
		}),
	);
	await waitFor(() =>
		expect(document.activeElement?.getAttribute("aria-label")).toBe(
			"Unlink Sam Other from mock-lms",
		),
	);
});

test("focus moves only after the refetch has removed the unlinked row", async () => {
	const courseUserId = "33333333-3333-4333-8333-333333333333";
	myLinks = {
		source: "sso",
		linkUntil: null,
		links: [
			{
				courseUserId,
				platformName: "mock-lms",
				displayName: "Sam Student",
				linkedAt: "2026-09-24T12:00:00.000Z",
			},
		],
		launch: null,
	};
	stubSettings(EDITOR_SETTINGS_DEFAULTS, ACCOUNT_USER);
	// A slow refetch, so focus code that does not wait for it sees the old row.
	const inner = globalThis.fetch;
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		if (String(input) === "/me/links" && linkWrites.length > 0) {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
		return inner(input, init);
	});
	const region = await openLinked();
	const button = await within(region).findByRole("button", {
		name: "Unlink Sam Student from mock-lms",
	});
	const rowPresentAtFocus: boolean[] = [];
	const heading = document.getElementById("settings-profile-linked") as HTMLElement;
	const focus = heading.focus.bind(heading);
	heading.focus = (options?: FocusOptions) => {
		rowPresentAtFocus.push(screen.queryByTestId(`link-row-${courseUserId}`) !== null);
		focus(options);
	};

	fireEvent.click(button);

	await waitFor(() => expect(rowPresentAtFocus).toEqual([false]));
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
