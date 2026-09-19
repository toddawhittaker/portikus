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

const PREVIEW_HOSTS = new Set(["localhost", "127.0.0.1"]);

/**
 * Whether a dotted-quad address is loopback, unspecified, private, or
 * link-local. The WHATWG URL parser has already normalised short forms such
 * as `127.1` to four octets by the time this sees them.
 */
function isPrivateIpv4(host: string): boolean {
	const parts = host.split(".");
	if (parts.length !== 4) return false;
	const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : -1));
	if (octets.some((octet) => octet < 0 || octet > 255)) return false;
	const [a, b] = octets as [number, number, number, number];
	if (a === 127) return true; // 127.0.0.0/8 loopback
	if (a === 0) return true; // 0.0.0.0/8, the unspecified address
	if (a === 10) return true; // 10.0.0.0/8
	if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
	// 100.64.0.0/10, the range carriers and some cloud networks use between
	// their own machines. It is not reachable from the public internet.
	if (a === 100 && b >= 64 && b <= 127) return true;
	if (a === 192 && b === 168) return true; // 192.168.0.0/16
	if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
	return false;
}

/**
 * An IPv6 address as eight 16-bit groups, or null if it is not one. Accepts
 * the `::` shorthand and a trailing dotted-quad, which is how IPv4-mapped
 * addresses are sometimes written.
 */
function parseIpv6(host: string): number[] | null {
	let text = host;
	const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
	if (dotted?.[1]) {
		const octets = dotted[1].split(".").map(Number);
		if (octets.some((octet) => octet > 255)) return null;
		const [a, b, c, d] = octets as [number, number, number, number];
		text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
	}
	const halves = text.split("::");
	if (halves.length > 2) return null;
	const toGroups = (part: string): number[] | null => {
		if (part === "") return [];
		const groups: number[] = [];
		for (const piece of part.split(":")) {
			if (!/^[0-9a-f]{1,4}$/i.test(piece)) return null;
			groups.push(Number.parseInt(piece, 16));
		}
		return groups;
	};
	const head = toGroups(halves[0] ?? "");
	const tail = halves.length === 2 ? toGroups(halves[1] ?? "") : [];
	if (head === null || tail === null) return null;
	if (halves.length === 1) return head.length === 8 ? head : null;
	const gap = 8 - head.length - tail.length;
	if (gap < 1) return null;
	return [...head, ...Array<number>(gap).fill(0), ...tail];
}

/** Whether an IPv6 address means this machine or a private network. */
function isPrivateIpv6(host: string): boolean {
	const groups = parseIpv6(host);
	if (groups === null) return false;
	const [first] = groups as [number, ...number[]];
	const isZero = groups.slice(0, 5).every((group) => group === 0);
	// ::1 loopback and :: unspecified.
	if (isZero && groups[5] === 0 && groups[6] === 0 && (groups[7] ?? 0) <= 1)
		return true;
	// ::ffff:a.b.c.d, the IPv4-mapped form: judge it as the IPv4 address.
	if (isZero && groups[5] === 0xffff) {
		const high = groups[6] ?? 0;
		const low = groups[7] ?? 0;
		const quad = `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
		return isPrivateIpv4(quad);
	}
	if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
	if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
	return false;
}

/**
 * Whether a hostname means this machine or a private network, and so must
 * never be opened in a new tab (SPEC.md §24.2, §24.7). Checked by range
 * rather than by a list of literals, because `127.0.0.2` and `127.1` reach
 * the same loopback interface that `127.0.0.1` does.
 */
function isLocalOrPrivateHost(host: string): boolean {
	if (host === "localhost" || host.endsWith(".localhost")) return true;
	if (host.startsWith("[") && host.endsWith("]")) {
		return isPrivateIpv6(host.slice(1, -1));
	}
	if (isPrivateIpv4(host)) return true;
	// A bare IPv6 address, in case the parser ever hands one over unbracketed.
	return host.includes(":") && isPrivateIpv6(host);
}

/** `([A-Za-z0-9_./-]+\.[A-Za-z0-9]+):(\d+)`, for example `src/auth.ts:73`. */
export const FILE_LINE_PATTERN = /([A-Za-z0-9_./-]+\.[A-Za-z0-9]+):(\d+)/;

/**
 * A local development URL such as `http://localhost:3000` becomes the
 * authenticated preview route for that port. Anything else is not ours.
 */
export function previewRouteFor(
	url: string,
	workspaceId: string,
	projectId: string,
): TerminalLink | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
	if (!PREVIEW_HOSTS.has(parsed.hostname)) return null;
	// A URL with no port means the scheme's default port.
	const port = parsed.port
		? Number(parsed.port)
		: parsed.protocol === "https:"
			? 443
			: 80;
	if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
	return {
		kind: "preview",
		to: "/workspaces/$id/projects/$projectId/preview/$port",
		params: { id: workspaceId, projectId, port: String(port) },
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
