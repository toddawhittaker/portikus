import { z } from "zod";

/**
 * A path inside one project, relative to the project directory (SPEC.md
 * §10). It is attacker-controlled text, so it may not escape the project:
 * no NUL, no absolute path, no backslash, and no "." or ".." segment.
 */
export const ProjectPath = z
	.string()
	.min(1)
	.max(1024)
	.refine((value) => !value.includes("\0"), "a path may not contain NUL")
	.refine((value) => !value.startsWith("/"), "a path must be relative")
	.refine((value) => !value.includes("\\"), "a path may not contain a backslash")
	.refine(
		(value) => value.split("/").every((part) => part !== "." && part !== ".."),
		'a path may not contain a "." or ".." segment',
	);
export type ProjectPath = z.infer<typeof ProjectPath>;
