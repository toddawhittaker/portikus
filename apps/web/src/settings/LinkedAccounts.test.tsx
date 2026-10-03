/**
 * Settings, Profile, Linked accounts (ADR 0026).
 */
import { EDITOR_SETTINGS_DEFAULTS } from "@portikus/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderWithQuery } from "../test-utils.js";
import { SettingsDialog } from "./SettingsDialog.js";
import {
	ACCOUNT_USER,
	openProfile,
	resetStubs,
	stub,
	stubSettings,
} from "./test-data.js";

afterEach(() => {
	document.documentElement.removeAttribute("data-theme");
	localStorage.clear();
	vi.unstubAllGlobals();
	resetStubs();
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
	stub.myLinks = {
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
	expect(stub.linkWrites).toEqual(["/me/links/start"]);
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
	stub.startAnswer = json(403, {
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
	stub.myLinks = {
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
	stub.myLinks = {
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
	expect(stub.linkWrites).toEqual([`/me/links/${courseUserId}/unlink`]);
	expect(await within(region).findByText(/No course sign-ins are linked/)).toBeTruthy();
	// The last row is gone, so focus lands on the section heading.
	await waitFor(() =>
		expect(document.activeElement?.id).toBe("settings-profile-linked"),
	);
});

test("an unlink that ends this session goes to the unlinked page", async () => {
	const assign = vi.fn();
	vi.stubGlobal("location", { ...window.location, assign });
	stub.unlinkSignsOut = true;
	stub.myLinks = {
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
	stub.myLinks = {
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
	stub.myLinks = {
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
		if (String(input) === "/me/links" && stub.linkWrites.length > 0) {
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
