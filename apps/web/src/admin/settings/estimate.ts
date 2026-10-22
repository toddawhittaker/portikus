import type { CodeHelpLanguage, CourseProfile } from "@portikus/contracts";

/*
 * The memory figures behind the code-help estimate, in MiB. Each comes from
 * the 25-student load test; docs/CAPACITY.md, "Estimate on the Settings
 * page", shows how, and a unit test keeps the two the same.
 */

/** What one student's language servers for each language hold. */
export const LANGUAGE_MIB: Record<CodeHelpLanguage, number> = {
	python: 185,
	typescript: 57,
};

/** One workspace without code help, by course profile (SPEC.md section 8.7). */
export const BASE_MIB: Record<CourseProfile, number> = {
	traditional: 160,
	agentic: 310,
};

/** What the platform itself uses on the server. */
export const PLATFORM_MIB = 1434;

/** Memory kept free (SPEC.md section 25.2). */
export const RESERVE_MIB = 2048;

const MIB = 1024 * 1024;

interface ProfileEstimate {
	perStudentMiB: number;
	/** Students the server's memory holds; null when its memory is not known. */
	students: number | null;
}

export interface Estimate {
	/** What the ticked languages add per student. */
	addedMiB: number;
	traditional: ProfileEstimate;
	agentic: ProfileEstimate;
}

/**
 * Memory per student and students per server with these languages ticked.
 * A worst case: every ticked language open at once, memory only.
 */
export function estimate(
	totalBytes: number | null,
	ticked: Iterable<CodeHelpLanguage>,
): Estimate {
	let addedMiB = 0;
	for (const language of new Set(ticked)) addedMiB += LANGUAGE_MIB[language];
	const free =
		totalBytes === null ? null : totalBytes / MIB - PLATFORM_MIB - RESERVE_MIB;
	const profile = (base: number): ProfileEstimate => {
		const perStudentMiB = base + addedMiB;
		return {
			perStudentMiB,
			students: free === null ? null : Math.max(0, Math.floor(free / perStudentMiB)),
		};
	};
	return {
		addedMiB,
		traditional: profile(BASE_MIB.traditional),
		agentic: profile(BASE_MIB.agentic),
	};
}
