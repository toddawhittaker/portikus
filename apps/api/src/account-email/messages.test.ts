import { expect, test } from "vitest";
import {
	emailChangedMessage,
	inviteMessage,
	resetConfirmationMessage,
	resetMessage,
	setPasswordLink,
} from "./messages.js";

/** Links come from PUBLIC_URL with the token in the fragment (SPEC.md section 5.3). */

const PUBLIC_URL = "https://portikus.school.edu";
const TOKEN = "a".repeat(43);

test("the link is built from PUBLIC_URL with the token in the fragment", () => {
	expect(setPasswordLink(PUBLIC_URL, TOKEN)).toBe(
		`https://portikus.school.edu/reset-password#${TOKEN}`,
	);
	// A trailing slash or a path on PUBLIC_URL does not change where the link goes.
	expect(setPasswordLink(`${PUBLIC_URL}/`, TOKEN)).toBe(
		`https://portikus.school.edu/reset-password#${TOKEN}`,
	);
	const url = new URL(setPasswordLink(PUBLIC_URL, TOKEN));
	expect(url.search).toBe("");
	expect(url.pathname).not.toContain(TOKEN);
});

test("the reset and invitation messages carry the link and how long it lasts", () => {
	const reset = resetMessage(PUBLIC_URL, TOKEN);
	expect(reset.subject).toBe("Reset your Portikus password");
	expect(reset.text).toContain(`${PUBLIC_URL}/reset-password#${TOKEN}`);
	expect(reset.text).toContain("lasts 30 minutes");
	expect(reset.text).toContain("portikus.school.edu");

	const invite = inviteMessage(PUBLIC_URL, TOKEN);
	expect(invite.subject).toBe("Your Portikus account");
	expect(invite.text).toContain(`${PUBLIC_URL}/reset-password#${TOKEN}`);
	expect(invite.text).toContain("lasts 7 days");
});

test("the confirmation and email-changed notices carry no link", () => {
	for (const message of [
		resetConfirmationMessage(PUBLIC_URL),
		emailChangedMessage(PUBLIC_URL),
	]) {
		expect(message.text).not.toContain("http");
		expect(message.text).toContain("portikus.school.edu");
		expect(message.text).toContain("tell your administrator");
	}
});
