import { z } from "zod";
import { DebianPackageName } from "./controller.js";

/** How long the package survey keeps its daily counts (ADR 0042). */
export const PACKAGE_SURVEY_KEEP_DAYS = 90;

/** The most rows `GET /admin/packages` returns, most-added first. */
export const ADMIN_PACKAGES_LIMIT = 200;

/**
 * A package is worth adding to the base image when at least 2 workspaces and
 * at least a third of those surveyed added it (ADR 0042).
 */
export function isBaseImageCandidate(workspaces: number, surveyed: number): boolean {
	return workspaces >= 2 && surveyed > 0 && workspaces * 3 >= surveyed;
}

const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** One package in the latest day's survey: a count, never a workspace. */
export const PackageSurveyRow = z.object({
	package: DebianPackageName,
	workspaces: z.number().int().nonnegative(),
	firstSeen: Day,
	lastSeen: Day,
	candidate: z.boolean(),
});
export type PackageSurveyRow = z.infer<typeof PackageSurveyRow>;

/**
 * `GET /admin/packages`: the latest surveyed day's site-wide counts
 * (SPEC.md §20.1). `day` is null before the first survey.
 */
export const AdminPackagesResponse = z.object({
	day: Day.nullable(),
	surveyed: z.number().int().nonnegative(),
	packages: z.array(PackageSurveyRow),
});
export type AdminPackagesResponse = z.infer<typeof AdminPackagesResponse>;

/**
 * `GET /workspaces/:id/reinstall-note`: packages the student had added with
 * apt that a rebuild removed. An empty list means there is nothing to show.
 */
export const ReinstallNote = z.object({
	packages: z.array(DebianPackageName),
});
export type ReinstallNote = z.infer<typeof ReinstallNote>;

/** The line a student copies to put the packages back; bad names are left out. */
export function reinstallCommand(packages: readonly string[]): string {
	const names = packages.filter((name) => DebianPackageName.safeParse(name).success);
	return `sudo apt install ${names.join(" ")}`;
}
