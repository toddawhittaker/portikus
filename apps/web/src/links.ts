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
			to: "/workspaces/$id/preview/$port";
			params: { id: string; port: string };
	  }
	| {
			kind: "file";
			to: "/workspaces/$id/files";
			params: { id: string };
			search: { path: string; line: number };
	  };

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1"]);

/** `([A-Za-z0-9_./-]+\.[A-Za-z0-9]+):(\d+)`, for example `src/auth.ts:73`. */
export const FILE_LINE_PATTERN = /([A-Za-z0-9_./-]+\.[A-Za-z0-9]+):(\d+)/;

/**
 * A local development URL such as `http://localhost:3000` becomes the
 * authenticated preview route for that port. Anything else is not ours.
 */
export function previewRouteFor(url: string, workspaceId: string): TerminalLink | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return null;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
	if (!LOCAL_HOSTS.has(parsed.hostname)) return null;
	const port = Number(parsed.port);
	if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
	return {
		kind: "preview",
		to: "/workspaces/$id/preview/$port",
		params: { id: workspaceId, port: String(port) },
	};
}

/**
 * A `path:line` reference becomes the file route. The path must be relative
 * and must not climb out of the workspace with `..` (SPEC.md §14.9).
 */
export function fileRouteFor(match: string, workspaceId: string): TerminalLink | null {
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
		to: "/workspaces/$id/files",
		params: { id: workspaceId },
		search: { path, line },
	};
}
