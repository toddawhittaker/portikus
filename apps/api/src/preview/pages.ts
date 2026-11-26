/**
 * Portikus-owned explanation pages for the preview host. A stopped workspace
 * or an inactive service must never show a raw proxy error
 * (BROWSER-HANDLING.md §25.1), and nothing here echoes any request text: a
 * ticket, cookie, or host in the page would leak straight back to student
 * code.
 */

import { escapeHtml } from "../http.js";

/** A minimal self-contained page; previews load no Portikus subresources. */
function previewPage(title: string, body: string, head = "", link = ""): string {
	return [
		"<!doctype html>",
		'<html lang="en"><head><meta charset="utf-8">',
		head,
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		`<title>${escapeHtml(title)}</title>`,
		"<style>body{font:16px/1.5 system-ui,sans-serif;margin:3rem auto;max-width:34rem;",
		"padding:0 1rem;color:#1f2933;background:#fff}h1{font-size:1.25rem}a{color:#1d4ed8}",
		"@media (prefers-color-scheme:dark){body{color:#e5e7eb;background:#111827}a{color:#93c5fd}}",
		":root{color-scheme:light dark}</style>",
		"</head><body>",
		`<h1>${escapeHtml(title)}</h1>`,
		`<p>${escapeHtml(body)}</p>`,
		link,
		"</body></html>",
	].join("");
}

/** The copy SPEC.md §14.8 and BROWSER-HANDLING.md §25.1 ask for. */
export function inactiveServicePage(port: number): string {
	return previewPage(
		"Nothing is listening yet",
		`Nothing is currently listening on port ${port}. ` +
			"Start your application to reconnect this preview.",
	);
}

export function stoppedWorkspacePage(): string {
	return previewPage(
		"Workspace stopped",
		"This workspace is not running. Open it in Portikus to start it, " +
			"then reload this preview.",
	);
}

export function signInPage(): string {
	return previewPage(
		"Preview session ended",
		"This preview session has ended. Open the preview again from Portikus.",
	);
}

/**
 * A framed preview whose cookie the browser would not keep, as Safari does
 * with a partitioned cookie across sites (BROWSER-HANDLING.md §7.2). The
 * session is fine; only this frame cannot use it, so the way out is the same
 * preview in its own tab, opened from Portikus.
 */
export function cookieBlockedPage(openUrl: string | null): string {
	const action = openUrl
		? `<p><a href="${escapeHtml(openUrl)}" target="_blank" rel="noopener">Open in new tab</a></p>`
		: "<p>Use the Open in new tab button above the preview instead.</p>";
	return previewPage(
		"Preview blocked by your browser",
		"Your browser blocked this preview from opening inside Portikus. " +
			"You can still open it in its own tab.",
		"",
		action,
	);
}

export function refusedPage(): string {
	return previewPage(
		"Preview not available",
		"Portikus will not show this preview. Open the preview again from " +
			"Portikus, or pick a different port.",
	);
}

/**
 * The bootstrap's answer: a page that sends the browser on to `target`
 * itself. A redirect would not do when previews are on another site: the
 * navigation began on the Portikus page, so the whole redirect chain counts
 * as cross-site and the new `SameSite=Strict` cookie would be held back from
 * the first load (BROWSER-HANDLING.md §7.2). A meta refresh starts a new
 * navigation from the preview's own page, and needs no script under the
 * page policy. The link is for a browser that ignores the refresh.
 */
export function bootstrapPage(target: string): string {
	const href = escapeHtml(target);
	return previewPage(
		"Opening preview",
		"Opening the preview.",
		`<meta http-equiv="refresh" content="0; url=${href}">`,
		`<p><a href="${href}">Continue to the preview</a></p>`,
	);
}

export function resetPage(): string {
	return previewPage(
		"Preview data cleared",
		"This preview's cookies and stored data have been cleared. " +
			"Open the preview again from Portikus to start a fresh session.",
	);
}

/** One network sent too many made-up preview cookies (SPEC.md section 24.13). */
export function missLimitPage(): string {
	return previewPage(
		"Too many preview requests",
		"Too many preview requests came from your network just now. Wait a " +
			"minute, then reload this preview.",
	);
}

/** One preview session asked too often (ADR 0034 ruling 12). */
export function tooManyRequestsPage(): string {
	return previewPage(
		"Too many requests",
		"This preview made too many requests in a short time. Wait a few " +
			"seconds, then reload it.",
	);
}
