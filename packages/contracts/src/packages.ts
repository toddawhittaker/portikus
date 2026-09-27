import { z } from "zod";
import { DebianPackageName } from "./controller.js";

/** How long the package survey keeps its daily counts (ADR 0042). */
export const PACKAGE_SURVEY_KEEP_DAYS = 90;

/**
 * The fewest workspaces a day's survey must hold before its counts are
 * shown, so a count can never point at one student (ADR 0042).
 */
export const PACKAGE_SURVEY_MIN_SURVEYED = 3;

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
 * `GET /admin/packages`: the site-wide counts of the latest day that
 * surveyed at least PACKAGE_SURVEY_MIN_SURVEYED workspaces (SPEC.md §20.1).
 * When no day has that many, `packages` is empty and `day` and `surveyed`
 * describe the latest day, so the page can say why. `day` is null before
 * the first survey.
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

const IMAGE_HEADER = /^# portikus-image: ([0-9A-Za-z.+~-]{1,64})$/;

/** The image's apt hook list, `~/.portikus/apt-packages.txt` (ADR 0042). */
export interface AptList {
	/** The image named in the header, or null when there is none or it is `unknown`. */
	image: string | null;
	packages: string[];
	/** The lines after the header, kept as written for a dismiss. */
	body: string[];
}

/**
 * Parse the apt hook's list: an optional `# portikus-image: <version>` first
 * line, then one package name per line. Anything that is not a package name
 * is dropped.
 */
export function parseAptList(text: string): AptList {
	const lines = text.split("\n");
	const version = IMAGE_HEADER.exec((lines[0] ?? "").trim())?.[1];
	const body = version === undefined ? lines : lines.slice(1);
	const packages = new Set<string>();
	for (const line of body) {
		const name = line.trim();
		if (DebianPackageName.safeParse(name).success) packages.add(name);
	}
	return {
		image: version === undefined || version === "unknown" ? null : version,
		packages: [...packages],
		body,
	};
}
