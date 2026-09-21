import { z } from "zod";

/**
 * Project checks: the commands a student can run against one project and see
 * a running/passed/failed answer for (SPEC.md §18.1). The definitions live in
 * the project itself, in `.portikus/checks.json`, so they travel with the
 * code and a template can ship them.
 */

/** Where the definitions live, relative to the project directory. */
export const CHECKS_FILE_PATH = ".portikus/checks.json";

/** The directory part of that path, which may have to be created first. */
export const CHECKS_FILE_DIR = ".portikus";

/** Check ids are slugs, so they are safe in a URL without escaping. */
export const CHECK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const CheckId = z.string().regex(CHECK_ID_PATTERN);
export type CheckId = z.infer<typeof CheckId>;

/** Longest command a check may carry. Long enough for a real test invocation. */
export const MAX_CHECK_COMMAND_LENGTH = 1024;

/** Most checks one project may define. */
export const MAX_CHECKS_PER_PROJECT = 32;

/** One configured check (SPEC.md §18.1). */
export const CheckDefinition = z
	.object({
		id: CheckId,
		name: z.string().min(1).max(80),
		command: z.string().min(1).max(MAX_CHECK_COMMAND_LENGTH),
	})
	.strict();
export type CheckDefinition = z.infer<typeof CheckDefinition>;

/** The contents of `.portikus/checks.json`. */
export const ChecksFile = z
	.object({
		checks: z.array(CheckDefinition).max(MAX_CHECKS_PER_PROJECT),
	})
	.strict();
export type ChecksFile = z.infer<typeof ChecksFile>;

/**
 * What a check is doing. "failed" is a command that ran and gave a non-zero
 * exit code; "error" is a command that could not be started at all, which is
 * a different thing to tell the student (SPEC.md §18.1, §28).
 */
export const CheckState = z.enum(["running", "passed", "failed", "error"]);
export type CheckState = z.infer<typeof CheckState>;

/** One execution of one check ("Check result metadata", SPEC.md §25). */
export const CheckRun = z.object({
	id: z.string().min(1),
	checkId: CheckId,
	state: CheckState,
	startedAt: z.string(),
	endedAt: z.string().optional(),
	exitCode: z.number().int().optional(),
});
export type CheckRun = z.infer<typeof CheckRun>;

/**
 * `GET /projects/:slug/checks`. A project with no file, or with a file we
 * cannot read, still answers: `error` carries the reason in the student's
 * terms and `checks` is empty (SPEC.md §18.1 "projects without configured
 * checks must remain usable").
 */
export const ChecksResponse = z.object({
	checks: z.array(CheckDefinition),
	/** Why the file could not be used, or null when there was nothing wrong. */
	error: z.string().nullable(),
	/** The last run of each check this agent still remembers. */
	runs: z.array(CheckRun),
});
export type ChecksResponse = z.infer<typeof ChecksResponse>;

/** Most output one run keeps for replay; the oldest bytes are dropped first. */
export const MAX_CHECK_OUTPUT_BYTES = 1024 * 1024;

/**
 * The frames a check output socket carries. Output is base64 so that any byte
 * a command writes survives the trip, escape sequences included.
 */
export const CheckOutputFrame = z.discriminatedUnion("type", [
	z.object({ type: z.literal("output"), data: z.string() }),
	z.object({ type: z.literal("exit"), exitCode: z.number().int() }),
	z.object({ type: z.literal("error"), code: z.string() }),
]);
export type CheckOutputFrame = z.infer<typeof CheckOutputFrame>;
