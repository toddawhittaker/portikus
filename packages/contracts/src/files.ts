import { z } from "zod";

/**
 * A path relative to the project directory that cannot escape it. The agent
 * checks it again (SPEC.md §11.1, §24.6).
 */
export const ProjectPath = z
	.string()
	.min(1)
	.max(1024)
	.refine((value) => !value.includes("\0"), {
		message: "path must not contain a NUL byte",
	})
	.refine((value) => !value.startsWith("/"), {
		message: "path must be relative to the project",
	})
	.refine((value) => !value.includes("\\"), {
		message: "path must not contain a backslash",
	})
	.refine((value) => !value.split("/").some((part) => part === "." || part === ".."), {
		message: "path must not contain a . or .. segment",
	});
export type ProjectPath = z.infer<typeof ProjectPath>;

/**
 * One entry's name: a single path segment and nothing else, so a listing
 * cannot smuggle a separator or a traversal into the tree (SPEC.md §24.6).
 */
const EntryName = z
	.string()
	.min(1)
	.max(255)
	.refine(
		(value) =>
			!value.includes("/") &&
			!value.includes("\\") &&
			!value.includes("\0") &&
			value !== "." &&
			value !== "..",
		{ message: "a name must be one path segment" },
	);

/** One entry of a directory listing (SPEC.md §11.2). */
export const TreeEntry = z.object({
	name: EntryName,
	type: z.enum(["file", "dir", "symlink", "other"]),
	size: z.number().nonnegative(),
	mtimeMs: z.number().nonnegative(),
});
export type TreeEntry = z.infer<typeof TreeEntry>;

/**
 * Where the next page of a listing starts: the last entry sent, as "d/<name>"
 * for a directory or "f/<name>" for anything else. A name, not an offset,
 * so a file created or removed between pages does not shift the rest.
 */
export const TreeAfter = z
	.string()
	.max(257)
	.regex(/^[df]\/[^/]+$/);

/** The continuation token for a listing page that ended at this entry. */
export function treeAfter(isDir: boolean, name: string): string {
	return `${isDir ? "d" : "f"}/${name}`;
}

/** The entry a continuation token names. */
export function parseTreeAfter(token: string): { isDir: boolean; name: string } {
	return { isDir: token.startsWith("d/"), name: token.slice(2) };
}

/**
 * Response body for one page of a directory listing (SPEC.md §11.2).
 * `truncated` means more entries follow; `next` asks for them.
 */
export const TreeResponse = z.object({
	entries: z.array(TreeEntry),
	truncated: z.boolean(),
	next: TreeAfter.optional(),
});
export type TreeResponse = z.infer<typeof TreeResponse>;

/** Response body for a successful file write (SPEC.md §13.5). */
export const WriteFileResponse = z.object({
	etag: z.string().min(1),
	size: z.number().nonnegative(),
});
export type WriteFileResponse = z.infer<typeof WriteFileResponse>;

/** Request body for creating a directory (SPEC.md §11.2). */
export const MkdirRequest = z.object({ path: ProjectPath }).strict();
export type MkdirRequest = z.infer<typeof MkdirRequest>;

/**
 * Request body for a move or rename inside one project (SPEC.md §11.2).
 * `replace` lets a file overwrite an existing file; a directory is never replaced.
 */
export const MoveRequest = z
	.object({ from: ProjectPath, to: ProjectPath, replace: z.boolean().optional() })
	.strict();
export type MoveRequest = z.infer<typeof MoveRequest>;

/** Request body for "Extract here" on a zip file. */
export const ExtractRequest = z.object({ path: ProjectPath }).strict();
export type ExtractRequest = z.infer<typeof ExtractRequest>;

/** The folder a zip was extracted into, project-relative. */
export const ExtractResponse = z.object({ path: ProjectPath });
export type ExtractResponse = z.infer<typeof ExtractResponse>;

/** Most bytes a zip may unpack to, the same cap as a download. */
export const MAX_EXTRACT_BYTES = 1024 * 1024 * 1024;

/** Most entries a zip may hold and still be extracted. */
export const MAX_EXTRACT_ENTRIES = 10_000;

/** Most entries one page of a directory listing returns. */
export const MAX_TREE_ENTRIES = 2000;

/** Largest file the editor will open or save (SPEC.md §13.5). */
export const MAX_EDITOR_FILE_BYTES = 2 * 1024 * 1024;

/** Largest upload the agent accepts (SPEC.md §11.2). */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/**
 * Largest file, folder or project a download serves. A folder counts
 * the apparent size of its regular files. A tenth of the workspace root
 * disk, where the zip is staged.
 */
export const MAX_DOWNLOAD_BYTES = 1024 * 1024 * 1024;

/** What the API relays past MAX_DOWNLOAD_BYTES, for zip headers. */
export const ZIP_OVERHEAD_BYTES = 64 * 1024 * 1024;

/** Generated and dependency directories the tree hides by default (SPEC.md §11.3). */
export const GENERATED_NAMES = [
	".git",
	"node_modules",
	".venv",
	"dist",
	"build",
	"target",
	"__pycache__",
] as const;

/**
 * Folders the project watcher does not follow: the generated ones plus other
 * common caches and environments. The tree still shows these extra names
 * (SPEC.md §11.4).
 */
export const WATCH_SKIP_NAMES = [
	...GENERATED_NAMES,
	"venv",
	"env",
	".next",
	".cache",
	"vendor",
	"coverage",
	".gradle",
	".pytest_cache",
	".mypy_cache",
	".tox",
] as const;

/**
 * An attachment Content-Disposition for a name the student chose. Control
 * characters would let a name inject a header line, so they are dropped; the
 * quoted form is plain ASCII, and `filename*` carries the real name for
 * browsers that read RFC 5987. Used by both the API and the workspace agent
 * so one download has one name (SPEC.md §11.2).
 */
export function contentDisposition(name: string): string {
	const stripped = Array.from(name)
		.filter((char) => {
			const code = char.codePointAt(0) ?? 0;
			return code >= 0x20 && code !== 0x7f;
		})
		.join("");
	const ascii = stripped.replace(/[^\u0020-\u007e]/g, "_").replace(/["\\]/g, "");
	// A name with nothing ASCII left to show gets a plain fallback.
	const fallback = /[^_]/.test(ascii) ? ascii : "download";
	const encoded = encodeURIComponent(stripped).replace(
		/['()*]/g,
		(char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
	);
	return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
