import { z } from "zod";

/**
 * A path inside a project, relative to the project directory. It must not
 * escape that directory, so absolute paths, backslashes, NUL bytes and `.`
 * or `..` segments are all refused here as well as in the agent
 * (SPEC.md §11.1, §24.6).
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

/** One entry of a directory listing (SPEC.md §11.2). */
export const TreeEntry = z.object({
	name: z.string().min(1),
	type: z.enum(["file", "dir", "symlink", "other"]),
	size: z.number().nonnegative(),
	mtimeMs: z.number().nonnegative(),
});
export type TreeEntry = z.infer<typeof TreeEntry>;

/** Response body for a directory listing; `truncated` means the cap was hit. */
export const TreeResponse = z.object({
	entries: z.array(TreeEntry),
	truncated: z.boolean(),
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

/** Request body for a move or rename inside one project (SPEC.md §11.2). */
export const MoveRequest = z.object({ from: ProjectPath, to: ProjectPath }).strict();
export type MoveRequest = z.infer<typeof MoveRequest>;

/** Most entries one directory listing returns before it is truncated. */
export const MAX_TREE_ENTRIES = 2000;

/** Largest file the editor will open or save (SPEC.md §13.5). */
export const MAX_EDITOR_FILE_BYTES = 2 * 1024 * 1024;

/** Largest upload the agent accepts (SPEC.md §11.2). */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

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
