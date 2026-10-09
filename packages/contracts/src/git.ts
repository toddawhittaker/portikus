import { z } from "zod";
import { isControlCharacter } from "./search.js";

/**
 * One changed path as Git reports it (SPEC.md §12.1). `x` is the staged
 * state and `y` the working-tree state, each a single porcelain character:
 * "M", "A", "D", "R", "?" for untracked, "." for unchanged.
 */
export const GitEntry = z.object({
	path: z.string().min(1),
	x: z.string().length(1),
	y: z.string().length(1),
	/** True when the path has an unresolved merge conflict (SPEC.md §12.8). */
	unmerged: z.boolean(),
	/** The path the file had before Git detected a rename. */
	origPath: z.string().min(1).optional(),
});
export type GitEntry = z.infer<typeof GitEntry>;

/**
 * Repository state for one project: the compact branch line of SPEC.md §12.8
 * plus the per-path decorations of §12.1. `repo` is false when the project
 * is not a Git repository at all.
 */
export const GitStatus = z.object({
	repo: z.boolean(),
	branch: z.string().nullable(),
	detached: z.boolean(),
	/**
	 * The full id of the checked-out commit, so a detached HEAD can be named
	 * (SPEC.md §12.8). Null before the first commit and for baseline status.
	 * Optional so an agent from an older package still answers.
	 */
	oid: z.string().nullable().optional(),
	upstream: z.string().nullable(),
	ahead: z.number().int().nonnegative(),
	behind: z.number().int().nonnegative(),
	conflicts: z.number().int().nonnegative(),
	entries: z.array(GitEntry),
	/**
	 * Ignored paths, sent only when hidden files are shown. A path ending in
	 * `/` means the whole subtree below it is ignored, not only that directory.
	 */
	ignored: z.array(z.string()),
	truncated: z.boolean(),
});
export type GitStatus = z.infer<typeof GitStatus>;

/**
 * One file's diff, HEAD version against the working tree (SPEC.md §12.6).
 * Both sides are null when the content is binary or too large; the flags say
 * which, so the UI can explain it.
 */
export const GitDiff = z.object({
	status: z.enum(["M", "A", "D", "R", "U"]),
	oldPath: z.string().min(1).optional(),
	before: z.string().nullable(),
	after: z.string().nullable(),
	binary: z.boolean(),
	tooLarge: z.boolean(),
});
export type GitDiff = z.infer<typeof GitDiff>;

/**
 * A Git ref the student types to compare one file against (SPEC.md §12.6):
 * a branch, tag, or commit id. The agent still resolves it with
 * `rev-parse --verify --end-of-options`; these rules keep it from ever
 * reading as an option or a range.
 */
export const GitRef = z
	.string()
	.min(1)
	.max(256)
	.refine((value) => !value.startsWith("-"), { message: "ref starts with -" })
	.refine((value) => ![...value].some(isControlCharacter), {
		message: "ref contains a control character",
	})
	// Git forbids ".." anywhere in a ref name, and it is how a range is written.
	.refine((value) => !value.includes(".."), { message: "ref contains .." });
export type GitRef = z.infer<typeof GitRef>;

/** Query for the status route: ignored files only when hidden files show. */
export const GitStatusQuery = z.object({
	hidden: z
		.enum(["true", "false"])
		.default("false")
		.transform((value) => value === "true"),
});
export type GitStatusQuery = z.infer<typeof GitStatusQuery>;

/** Most changed paths one status response carries before it is truncated. */
export const MAX_GIT_ENTRIES = 5000;

/** Largest side of a diff the agent will send (SPEC.md §12.6). */
export const MAX_DIFF_SIDE_BYTES = 1024 * 1024;

/**
 * How long one git command may run in the agent (SPEC.md §12.1). The control
 * plane budgets its own waits from this, so the two never disagree.
 */
export const GIT_TIMEOUT_MS = 10_000;
