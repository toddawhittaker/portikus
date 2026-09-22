/** Issue #357: the skip-link-style toggle for screen-reader mode. */
import { EDITOR_SETTINGS_DEFAULTS } from "@portikus/contracts";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderWithQuery, stubFetch } from "../test-utils.js";
import { ScreenReaderToggle } from "./ScreenReaderToggle.js";

afterEach(() => {
	vi.unstubAllGlobals();
});

function stubSettings(screenReaderMode: boolean) {
	const writes: unknown[] = [];
	let current = { ...EDITOR_SETTINGS_DEFAULTS, screenReaderMode, timezones: [] };
	stubFetch((url, init) => {
		if (url !== "/me/settings") throw new Error(`unexpected request to ${url}`);
		if ((init?.method ?? "GET") !== "GET") {
			const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
			writes.push(body);
			current = { ...current, ...body };
		}
		return json(200, current);
	});
	return writes;
}

test("before the settings arrive the toggle offers the opposite of the default", () => {
	stubFetch(() => new Response(null, { status: 500 }));
	renderWithQuery(<ScreenReaderToggle />);
	const name = EDITOR_SETTINGS_DEFAULTS.screenReaderMode
		? "Turn off screen-reader mode"
		: "Turn on screen-reader mode";
	expect(screen.getByRole("button", { name })).toBeTruthy();
});

test("pressing it saves the setting and announces the change", async () => {
	const writes = stubSettings(false);
	renderWithQuery(<ScreenReaderToggle />);
	fireEvent.click(
		await screen.findByRole("button", { name: "Turn on screen-reader mode" }),
	);

	await waitFor(() => expect(writes).toEqual([{ screenReaderMode: true }]));
	await waitFor(() =>
		expect(screen.getByRole("status").textContent).toBe("Screen-reader mode is on."),
	);
	expect(
		screen.getByRole("button", { name: "Turn off screen-reader mode" }),
	).toBeTruthy();
});

test("when the mode is on it offers to turn it off", async () => {
	const writes = stubSettings(true);
	renderWithQuery(<ScreenReaderToggle />);
	fireEvent.click(
		await screen.findByRole("button", { name: "Turn off screen-reader mode" }),
	);
	await waitFor(() => expect(writes).toEqual([{ screenReaderMode: false }]));
	await waitFor(() =>
		expect(screen.getByRole("status").textContent).toBe("Screen-reader mode is off."),
	);
});
