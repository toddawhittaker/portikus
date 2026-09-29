/**
 * Which files the file tab shows as a picture or a PDF rather than as text
 * or a download (#816). The API serves these same extensions inline, and
 * nothing else.
 */
import { parentOf } from "./paths.js";

export type ViewerKind = "image" | "svg" | "pdf";

const KINDS: Record<string, ViewerKind> = {
	png: "image",
	jpg: "image",
	jpeg: "image",
	gif: "image",
	webp: "image",
	svg: "svg",
	pdf: "pdf",
};

/** How `path` is shown in a viewer, or null for text and other files. */
export function viewerKind(path: string): ViewerKind | null {
	const name = path.slice(path.lastIndexOf("/") + 1);
	const dot = name.lastIndexOf(".");
	if (dot <= 0) return null;
	return KINDS[name.slice(dot + 1).toLowerCase()] ?? null;
}

/**
 * The project path an image address in the Markdown file at `from` points
 * at, or null when it is not a path inside the project: an address with a
 * scheme, a protocol-relative one, a fragment, or one that climbs above the
 * project root. A leading slash means the project root, as on a code host.
 */
export function projectImagePath(address: string, from: string): string | null {
	if (address === "" || address.startsWith("#") || address.startsWith("//"))
		return null;
	if (/^[a-z][a-z0-9+.-]*:/i.test(address)) return null;
	const bare = address.replace(/[?#].*$/, "");
	let decoded: string;
	try {
		decoded = decodeURIComponent(bare);
	} catch {
		return null;
	}
	if (decoded.includes("\\") || decoded.includes("\0")) return null;
	const rooted = decoded.startsWith("/");
	const parts = rooted ? [] : parentOf(from).split("/").filter(Boolean);
	for (const segment of decoded.split("/")) {
		if (segment === "" || segment === ".") continue;
		if (segment === "..") {
			if (parts.length === 0) return null;
			parts.pop();
			continue;
		}
		parts.push(segment);
	}
	return parts.length === 0 ? null : parts.join("/");
}
