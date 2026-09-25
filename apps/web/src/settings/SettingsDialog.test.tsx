/**
 * The editor settings dialog (issue #159, SPEC.md §13.5): it shows what the
 * server holds and sends the changes back.
 */
import { EDITOR_SETTINGS_DEFAULTS } from "@portikus/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
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
 * nothing else, so the browser's own zone list never comes into it (#287).
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

/** Issue #288, plus appearance in the same dialog (issue #329). */
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
		screenReaderMode: EDITOR_SETTINGS_DEFAULTS.screenReaderMode,
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
 * Issues #329 and #300: page appearance is chosen here, applied at once,
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

	fireEvent.click(screen.getByTestId("editor-settings-save"));
	await waitFor(() => expect(writes).toHaveLength(3));
	expect(writes[2]?.body).toEqual({
		autoSave: true,
		autoSaveDelaySeconds: 5,
		wordWrap: true,
		terminalTheme: "dark",
		timezone: "America/New_York",
		screenReaderMode: EDITOR_SETTINGS_DEFAULTS.screenReaderMode,
	});
});

/**
 * Issue #239: the dialog shows the stored terminal theme and sends it back
 * with everything else.
 */
test("the stored terminal theme is shown and sent back", async () => {
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

	fireEvent.click(checkbox(/Word wrap/));
	fireEvent.click(screen.getByTestId("editor-settings-save"));

	await waitFor(() => expect(writes).toHaveLength(1));
	expect(writes[0]?.body).toMatchObject({ terminalTheme: "dark", wordWrap: true });
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
		appearance: "system",
		screenReaderMode: false,
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

/**
 * Issue #287: the zone select is built from the list the server sent with the
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
	// Account is folded into Profile (issue #300).
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
	stubSettings();
	renderWithQuery(<SettingsDialog onClose={() => {}} />);
	await waitFor(() => expect(screen.getByLabelText("Search")).toBeTruthy());

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
	const displayName = screen.getByLabelText("Display name") as HTMLInputElement;
	expect(displayName.value).toBe("Alice Example");
	expect(displayName.readOnly).toBe(true);
	expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe(
		PROFILE.email,
	);
	expect((screen.getByLabelText("Sign-in name") as HTMLInputElement).value).toBe(
		"university-alice",
	);
	const label = screen.getByLabelText("Workspace label") as HTMLInputElement;
	expect(label.value).toBe("alice");
	expect(label.readOnly).toBe(true);
});

test("a missing email is shown as not provided", async () => {
	stubSettings(EDITOR_SETTINGS_DEFAULTS, ACCOUNT_USER);
	stubFetch((url) => {
		if (url === "/auth/me") return json(200, ACCOUNT_USER);
		if (url === "/me/profile") return json(200, { ...PROFILE, email: null });
		return json(200, { ...EDITOR_SETTINGS_DEFAULTS, timezones: SERVER_ZONES });
	});
	renderWithQuery(<SettingsDialog onClose={() => {}} />);
	await openProfile();

	expect((screen.getByLabelText("Email") as HTMLInputElement).value).toBe(
		"Not provided",
	);
});

test("choosing the sign-in name hit opens Profile on that field", async () => {
	stubSettings(EDITOR_SETTINGS_DEFAULTS, ACCOUNT_USER);
	renderWithQuery(<SettingsDialog onClose={() => {}} />);
	await waitFor(() => expect(screen.getByLabelText("Search")).toBeTruthy());

	fireEvent.change(screen.getByLabelText("Search"), { target: { value: "sign-in" } });
	fireEvent.click(buttonNamed("Sign-in name"));

	expect(
		((await screen.findByLabelText("Sign-in name")) as HTMLInputElement).value,
	).toBe("university-alice");
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

test("valid links are saved with the rest and shown as plain anchors", async () => {
	const writes = stubSettings(EDITOR_SETTINGS_DEFAULTS, ACCOUNT_USER);
	const onClose = vi.fn();
	renderWithQuery(<SettingsDialog onClose={onClose} />);
	await openProfile();

	fireEvent.change(screen.getByLabelText("GitHub"), {
		target: { value: " alice-ex " },
	});
	fireEvent.change(screen.getByLabelText("Personal site"), {
		target: { value: "https://alice.example.edu/" },
	});
	fireEvent.click(screen.getByTestId("editor-settings-save"));

	await waitFor(() => expect(onClose).toHaveBeenCalled());
	expect(profileWrites.map((write) => write.body)).toEqual([
		{ github: "alice-ex", website: "https://alice.example.edu/" },
	]);
	expect(writes).toHaveLength(1);

	const github = screen.getByTestId("profile-github-link");
	expect(github.tagName).toBe("A");
	expect(github.getAttribute("href")).toBe("https://github.com/alice-ex");
	expect(github.getAttribute("rel")).toBe("noopener");
	const site = screen.getByTestId("profile-website-link");
	expect(site.getAttribute("href")).toBe("https://alice.example.edu/");
	expect(site.getAttribute("rel")).toBe("noopener");
});

test("an invalid link is refused before anything is sent", async () => {
	const writes = stubSettings(EDITOR_SETTINGS_DEFAULTS, ACCOUNT_USER);
	renderWithQuery(<SettingsDialog onClose={() => {}} />);
	await openProfile();

	fireEvent.change(screen.getByLabelText("Personal site"), {
		target: { value: "javascript:alert(1)" },
	});
	expect(screen.getByText("Give an https:// link")).toBeTruthy();
	fireEvent.change(screen.getByLabelText("GitHub"), {
		target: { value: "http://github.com/alice" },
	});
	expect(screen.getByText("Give a GitHub username or an https:// link")).toBeTruthy();

	const save = screen.getByTestId("editor-settings-save") as HTMLButtonElement;
	expect(save.disabled).toBe(true);
	fireEvent.click(save);
	expect(profileWrites).toHaveLength(0);
	expect(writes).toHaveLength(0);
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

/** Issue #357: screen-reader mode is a per-user setting, saved with the rest. */
test("screen reader mode shows what is stored and is saved when turned on", async () => {
	const writes = stubSettings({ ...EDITOR_SETTINGS_DEFAULTS, screenReaderMode: false });
	renderWithQuery(<SettingsDialog onClose={() => {}} />);
	const region = await screen.findByRole("region", { name: "Accessibility" });
	const box = within(region).getByRole("checkbox", {
		name: /Screen reader mode/,
	}) as HTMLInputElement;
	await waitFor(() => expect(box.checked).toBe(false));

	fireEvent.click(box);
	fireEvent.click(screen.getByTestId("editor-settings-save"));

	await waitFor(() => expect(writes).toHaveLength(1));
	expect(writes[0]?.body).toMatchObject({ screenReaderMode: true });
});

/** Issue #373: the switch is named for what "on" means, whatever it shows. */
test("the terminal colours switch is named Light terminal", async () => {
	stubSettings();
	renderWithQuery(<SettingsDialog onClose={() => {}} />);
	const terminal = await screen.findByRole("region", { name: "Terminal" });
	const toggle = within(terminal).getByRole("switch", { name: "Light terminal" });
	fireEvent.click(toggle);
	expect(within(terminal).getByRole("switch", { name: "Light terminal" })).toBe(toggle);
});

/** Issue #359: the hard-to-find keys and the library limits are written down. */
test("the keyboard section lists the keys and the terminal and editor limits", async () => {
	stubSettings();
	renderWithQuery(<SettingsDialog onClose={() => {}} />);
	fireEvent.click(
		await screen.findByRole("button", { name: "Keyboard and screen readers" }),
	);

	const section = screen.getByRole("region", { name: "Keyboard and screen readers" });
	for (const keys of [
		"Alt+Shift+Q",
		"Ctrl+M",
		"Alt+F1",
		"Alt+Shift+Left Arrow",
		"Shift+F10",
		"F8",
	]) {
		expect(section.textContent).toContain(keys);
	}
	const limits = within(section).getByRole("region", {
		name: "What the terminal and editor cannot do",
	});
	expect(limits.textContent).toContain("Screen reader mode");
});

/** Issue #359: search finds the help section by its title. */
test("searching for keyboard finds the help section", async () => {
	stubSettings();
	renderWithQuery(<SettingsDialog onClose={() => {}} />);
	fireEvent.change(await screen.findByLabelText("Search"), {
		target: { value: "keyboard" },
	});
	expect(
		screen.getByRole("button", { name: "Keyboard and screen readers" }),
	).toBeTruthy();
});

/** docs/archive/epics/EPIC-13-1.md, "The flow" steps 1, 2 and 7. */
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
	expect(within(region).queryByRole("button")).toBeNull();
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

test("focus moves only after the refetch has removed the unlinked row (review C2)", async () => {
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

/** Issue #363: a failed save is announced, not only shown. */
test("a failed save is shown as an alert", async () => {
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
	fireEvent.click(screen.getByTestId("editor-settings-save"));

	const alert = await screen.findByRole("alert");
	expect(alert.getAttribute("data-testid")).toBe("editor-settings-error");
});
