/**
 * Settings, Profile: the read-only sign-in, the picture and the links.
 */
import { EDITOR_SETTINGS_DEFAULTS } from "@portikus/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderWithQuery, stubFetch } from "../test-utils.js";
import { SettingsDialog } from "./SettingsDialog.js";
import {
	ACCOUNT_USER,
	buttonNamed,
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

test("a sign-in name reads as an ID, in the small monospace face", async () => {
	stubSettings(EDITOR_SETTINGS_DEFAULTS, {
		...ACCOUNT_USER,
		signInName: "CiQ5ZGM0ZjE3Ny1hYjEyLTQ0ZTUtOGJiMC0xZjI3ZDE3YzQyNmESBWxvY2Fs",
	});
	renderWithQuery(<SettingsDialog onClose={() => {}} />);
	await openProfile();
	const name = within(screen.getByTestId("profile-signin"))
		.getAllByRole("term")
		.find((term) => term.textContent === "Sign-in name")?.nextElementSibling;
	expect(name?.className).toContain("pk-mono-small");
	// A long unbroken subject still wraps inside the dialog.
	expect(name?.className).toContain("pk-settings-value");
});

test("the section heading is for screen readers; the section list shows which is open", async () => {
	stubSettings(EDITOR_SETTINGS_DEFAULTS, ACCOUNT_USER);
	renderWithQuery(<SettingsDialog onClose={() => {}} />);
	await openProfile();
	const heading = screen.getByRole("heading", { level: 2, name: "Profile" });
	expect(heading.className).toBe("sr-only");
	expect(screen.getByRole("region", { name: "Profile" }).firstElementChild).toBe(
		heading,
	);
});

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
	expect(stub.profileWrites).toHaveLength(0);
	fireEvent.blur(githubField);
	await waitFor(() =>
		expect(stub.profileWrites.map((write) => write.body)).toEqual([
			{ github: "alice-ex" },
		]),
	);
	await waitFor(() =>
		expect(screen.getByTestId("settings-saved").textContent).toBe("Saved"),
	);
	// Leaving it again sends nothing more.
	fireEvent.blur(githubField);

	const siteField = screen.getByLabelText("Personal site");
	fireEvent.change(siteField, { target: { value: "https://alice.example.edu/" } });
	fireEvent.keyDown(siteField, { key: "Enter" });
	await waitFor(() => expect(stub.profileWrites).toHaveLength(2));
	expect(stub.profileWrites[1]?.body).toEqual({
		website: "https://alice.example.edu/",
	});
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
		expect(stub.profileWrites.map((write) => write.body)).toEqual([
			{ github: "alice-ex" },
		]),
	);
	await new Promise((resolve) => setTimeout(resolve, 20));
	expect(stub.profileWrites).toHaveLength(1);
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
	expect(stub.profileWrites).toHaveLength(0);

	fireEvent.change(screen.getByLabelText("GitHub"), { target: { value: "alice" } });
	fireEvent.click(screen.getByTestId("settings-close"));
	await waitFor(() =>
		expect(stub.profileWrites.map((write) => write.body)).toEqual([
			{ github: "alice" },
		]),
	);
	expect(writes).toHaveLength(0);
});

/** A button opens the hidden file field, so no "No file chosen" sits beside a saved picture. */
test("the profile picture is chosen with a button described by its hint", async () => {
	stubSettings(EDITOR_SETTINGS_DEFAULTS, ACCOUNT_USER);
	renderWithQuery(<SettingsDialog onClose={() => {}} />);
	await openProfile();

	const choose = screen.getByRole("button", { name: "Choose picture…" });
	expect(choose.getAttribute("aria-describedby")).toBe("profile-picture-hint");
	expect(document.getElementById("profile-picture-hint")?.textContent).toContain(
		"A PNG or JPEG of up to 1 MiB.",
	);
	const input = screen.getByTestId("profile-picture-input") as HTMLInputElement;
	expect(input.type).toBe("file");
	expect(input.hidden).toBe(true);
	expect(input.accept).toBe("image/png,image/jpeg");
	const click = vi.spyOn(input, "click");
	fireEvent.click(choose);
	expect(click).toHaveBeenCalled();
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

	const error = await screen.findByTestId("profile-picture-error");
	expect(error.textContent).toBe("The picture is too big");
	// Read out when it appears, and tied to the button, after the hint.
	expect(error.getAttribute("role")).toBe("alert");
	const choose = screen.getByRole("button", { name: "Choose picture…" });
	expect(choose.getAttribute("aria-describedby")).toBe(
		"profile-picture-hint profile-picture-err",
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
