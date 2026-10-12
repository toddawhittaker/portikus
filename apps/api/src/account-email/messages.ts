/**
 * The fixed text of every account email (SPEC.md section 5.3). Nothing a
 * person typed goes into a message, so an email cannot be turned into a
 * vehicle for someone else's words. Links come from PUBLIC_URL only, never
 * from a request's Host, and carry the token in the fragment so no server,
 * log or Referer header ever sees it.
 */

import { TOKEN_LIFETIME_MS } from "./tokens.js";

export interface AccountMessage {
	subject: string;
	text: string;
}

/** The page that takes a reset or invitation token from its fragment. */
const SET_PASSWORD_PATH = "/reset-password";

export function setPasswordLink(publicUrl: string, token: string): string {
	const url = new URL(SET_PASSWORD_PATH, publicUrl);
	url.hash = token;
	return url.toString();
}

function siteName(publicUrl: string): string {
	return new URL(publicUrl).host;
}

const IGNORE =
	"If you did not expect this email, you can ignore it; nothing changes until the link is used.";

export function resetMessage(publicUrl: string, token: string): AccountMessage {
	const minutes = TOKEN_LIFETIME_MS.reset / 60_000;
	return {
		subject: "Reset your Portikus password",
		text: [
			`Someone asked to reset the password of your Portikus account at ${siteName(publicUrl)}.`,
			"",
			"To choose a new password, open this link:",
			setPasswordLink(publicUrl, token),
			"",
			`The link works once and lasts ${minutes} minutes.`,
			IGNORE,
		].join("\n"),
	};
}

export function inviteMessage(publicUrl: string, token: string): AccountMessage {
	const days = TOKEN_LIFETIME_MS.invite / (24 * 60 * 60_000);
	return {
		subject: "Your Portikus account",
		text: [
			`An administrator made you a Portikus account at ${siteName(publicUrl)}.`,
			"",
			"To choose your password, open this link:",
			setPasswordLink(publicUrl, token),
			"",
			`The link works once and lasts ${days} days.`,
			IGNORE,
		].join("\n"),
	};
}

export function resetConfirmationMessage(publicUrl: string): AccountMessage {
	return {
		subject: "Your Portikus password was changed",
		text: [
			`The password of your Portikus account at ${siteName(publicUrl)} was just changed with an emailed link, and every session was signed out.`,
			"",
			"If you did not do this, tell your administrator now.",
		].join("\n"),
	};
}

/** Sent to the old address, so a takeover through an email change cannot pass unnoticed. */
export function emailChangedMessage(publicUrl: string): AccountMessage {
	return {
		subject: "Your Portikus email address was changed",
		text: [
			`An administrator changed the email address of your Portikus account at ${siteName(publicUrl)}. Mail for the account now goes to the new address.`,
			"",
			"If you did not ask for this, tell your administrator now.",
		].join("\n"),
	};
}
