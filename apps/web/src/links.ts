import { isLocalOrPrivateHost } from "@portikus/contracts";

/**
 * Turning text printed by a terminal into navigation (SPEC.md §14.9).
 *
 * Terminal output is untrusted: it is written by student and agent code.
 * These two functions are the only place a route is built from that text,
 * and they return null for anything outside the policy, so printed text can
 * never construct an arbitrary control-plane URL (SPEC.md §14.9, §24.2).
 */

/** A route inside the signed-in user's own workspace. */
export type TerminalLink =
	| {
			kind: "preview";
			to: "/workspaces/$id/projects/$projectId/preview/$port";
			params: { id: string; projectId: string; port: string };
	  }
	| {
			kind: "file";
			to: "/workspaces/$id/projects/$projectId/files";
			params: { id: string; projectId: string };
			search: { path: string; line: number };
	  };

/**
 * The only hosts a printed URL may name for a preview
 * (BROWSER-HANDLING.md §15). They are compared exactly: `localhost.evil.example`
 * and `evil.localhost` are other people's machines, not this workspace.
 */
const PREVIEW_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** A UUID as the admin links carry it; the router and the audit tab share it. */
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ports below this are reserved and are never previewed (SPEC.md §14.7). */
export const MIN_PREVIEW_PORT = 1024;

/** `([A-Za-z0-9_./-]+\.[A-Za-z0-9]+):(\d+)`, for example `src/auth.ts:73`. */
export const FILE_LINE_PATTERN = /([A-Za-z0-9_./-]+\.[A-Za-z0-9]+):(\d+)/;

/**
 * What a URL printed by a terminal points at, when it points at a service
 * inside this workspace (SPEC.md §14.9, BROWSER-HANDLING.md §15).
 *
 * Null for anything else: another host, a scheme we do not open, or a URL
 * carrying a user name, which is how `localhost@evil.example` is written.
 * `allowed` is false for a port policy reserves, so the caller can say why
 * nothing opened instead of opening the wrong thing.
 */
export function localPreviewTarget(
	url: string,
): { port: number; allowed: boolean } | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
	if (parsed.username !== "" || parsed.password !== "") return null;
	// `hostname` keeps the brackets of an IPv6 literal, which is how [::1] is
	// written in a URL.
	if (!PREVIEW_HOSTS.has(parsed.hostname.toLowerCase())) return null;
	// A URL with no port means the scheme's default port.
	const port = parsed.port
		? Number(parsed.port)
		: parsed.protocol === "https:"
			? 443
			: 80;
	if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
	return { port, allowed: port >= MIN_PREVIEW_PORT };
}

/**
 * A local development URL such as `http://localhost:3000` becomes the
 * authenticated preview route for that port. Anything else, and any port
 * policy reserves, is not ours.
 */
export function previewRouteFor(
	url: string,
	workspaceId: string,
	projectId: string,
): TerminalLink | null {
	const target = localPreviewTarget(url);
	if (!target?.allowed) return null;
	return {
		kind: "preview",
		to: "/workspaces/$id/projects/$projectId/preview/$port",
		params: { id: workspaceId, projectId, port: String(target.port) },
	};
}

/**
 * A `path:line` reference becomes the file route. The path must be relative
 * and must not climb out of the workspace with `..` (SPEC.md §14.9).
 */
export function fileRouteFor(
	match: string,
	workspaceId: string,
	projectId: string,
): TerminalLink | null {
	const found = FILE_LINE_PATTERN.exec(match);
	if (!found || found[0] !== match) return null;
	const path = found[1];
	const line = Number(found[2]);
	if (path === undefined) return null;
	if (path.startsWith("/")) return null;
	if (path.split("/").includes("..")) return null;
	if (!Number.isInteger(line) || line < 1) return null;
	return {
		kind: "file",
		to: "/workspaces/$id/projects/$projectId/files",
		params: { id: workspaceId, projectId },
		search: { path, line },
	};
}

/**
 * Whether a URL printed by a terminal may be opened in a new browser tab.
 * Local addresses are refused: in the browser they would mean the student's
 * own machine, not the workspace, and only the preview route reaches a
 * workspace port (SPEC.md §14.9, §24.2). Non-http(s) schemes are refused too.
 */
export function canOpenInNewTab(url: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
	// `https://github.com@evil.example/` reads as GitHub but goes to evil.example,
	// so a URL that carries credentials is refused outright (SPEC.md §24.2).
	if (parsed.username !== "" || parsed.password !== "") return false;
	return !isLocalOrPrivateHost(parsed.hostname.toLowerCase());
}

/**
 * How many rows one wrapped URL may span before the search gives up. A
 * 200-character URL in an 80-column pane takes three; the cap keeps a screen
 * full of long lines from being joined into one string on every hover.
 */
const MAX_WRAPPED_ROWS = 20;

/** URLs as a terminal prints them: no spaces, no quotes, no angle brackets. */
const URL_IN_TEXT = /https?:\/\/[^\s"'`<>]+/g;

/** Punctuation that ends a sentence rather than the URL inside it. */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/;

/** A link over a range of terminal cells, in xterm.js coordinates. */
export interface WrappedLink {
	text: string;
	range: {
		start: { x: number; y: number };
		end: { x: number; y: number };
	};
}

/**
 * URLs on the given row that the terminal wrapped across rows (SPEC.md §14.9).
 *
 * tmux repaints a wrapped line as separate rows without the marker that says
 * they belong together, so xterm.js sees two fragments and underlines neither.
 * A row that fills the whole width is taken to continue on the next one, which
 * is how the rows got there in the first place, and the joined text is
 * searched for URLs. Only links that really do span more than one row are
 * returned; single-row URLs are left to the web-links addon.
 *
 * `row` returns a row's text with trailing blanks removed, or null when there
 * is no such row. Rows are numbered from 1, as xterm.js numbers them.
 */
export function wrappedUrlsOnRow(
	lineNumber: number,
	row: (y: number) => string | null,
	cols: number,
): WrappedLink[] {
	if (cols <= 0) return [];
	const isFull = (y: number): boolean => (row(y)?.length ?? 0) >= cols;

	// Walk back to the first row of the wrapped line, then forward over it.
	let first = lineNumber;
	while (first > 1 && isFull(first - 1) && lineNumber - first < MAX_WRAPPED_ROWS) {
		first -= 1;
	}
	const rows: { y: number; start: number; length: number }[] = [];
	let text = "";
	for (let y = first; y - first < MAX_WRAPPED_ROWS; y += 1) {
		const line = row(y);
		if (line === null) break;
		rows.push({ y, start: text.length, length: line.length });
		text += line;
		if (!isFull(y)) break;
	}
	if (rows.length < 2) return [];

	/** The cell an offset into the joined text sits in. */
	const cellAt = (offset: number): { x: number; y: number } => {
		const place =
			rows.find((r) => offset >= r.start && offset < r.start + r.length) ??
			rows[rows.length - 1];
		if (!place) return { x: 1, y: lineNumber };
		return { x: offset - place.start + 1, y: place.y };
	};

	const links: WrappedLink[] = [];
	const pattern = new RegExp(URL_IN_TEXT.source, "g");
	let found = pattern.exec(text);
	while (found !== null) {
		const url = found[0].replace(TRAILING_PUNCTUATION, "");
		const start = cellAt(found.index);
		const end = cellAt(found.index + url.length - 1);
		// A URL that fits on one row is the web-links addon's job, and one that
		// does not reach this row is another row's link.
		if (end.y > start.y && lineNumber >= start.y && lineNumber <= end.y) {
			links.push({ text: url, range: { start, end } });
		}
		found = pattern.exec(text);
	}
	return links;
}
