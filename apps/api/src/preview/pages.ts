/**
 * Portikus-owned explanation pages for the preview host. A stopped workspace
 * or an inactive service must never show a raw proxy error
 * (BROWSER-HANDLING.md §25.1), and nothing here echoes any request text: a
 * ticket, cookie, or host in the page would leak straight back to student
 * code.
 */

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/** A minimal self-contained page; previews load no Portikus subresources. */
export function previewPage(title: string, body: string): string {
	return [
		"<!doctype html>",
		'<html lang="en"><head><meta charset="utf-8">',
		'<meta name="viewport" content="width=device-width, initial-scale=1">',
		`<title>${escapeHtml(title)}</title>`,
		"<style>body{font:16px/1.5 system-ui,sans-serif;margin:3rem auto;max-width:34rem;",
		"padding:0 1rem;color:#1f2933}h1{font-size:1.25rem}</style>",
		"</head><body>",
		`<h1>${escapeHtml(title)}</h1>`,
		`<p>${escapeHtml(body)}</p>`,
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

export function refusedPage(): string {
	return previewPage(
		"Preview not available",
		"Portikus will not show this preview. Open the preview again from " +
			"Portikus, or pick a different port.",
	);
}

export function resetPage(): string {
	return previewPage(
		"Preview data cleared",
		"This preview's cookies and stored data have been cleared. " +
			"Open the preview again from Portikus to start a fresh session.",
	);
}
