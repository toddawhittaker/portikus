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

/** Hostnames that mean "this machine" and so must never open in a new tab. */
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

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
	const host = parsed.hostname.toLowerCase();
	if (LOCAL_HOSTS.has(host)) return false;
	if (host.endsWith(".localhost")) return false;
	return true;
}
