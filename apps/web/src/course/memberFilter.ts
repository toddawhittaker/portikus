import type { CourseMember } from "@portikus/contracts";

/**
 * The roster filters above the Members table. All is everyone on the roster;
 * the state filters count students only, so they agree with Class now, and
 * instructors have their own filter.
 */
export const MEMBER_FILTERS = [
	"all",
	"attention",
	"running",
	"stopped",
	"instructors",
] as const;
export type MemberFilter = (typeof MEMBER_FILTERS)[number];

export const MEMBER_FILTER_LABEL: Record<MemberFilter, string> = {
	all: "All",
	attention: "Needs attention",
	running: "Running",
	stopped: "Stopped",
	instructors: "Instructors",
};

/**
 * Whether an instructor should look at this member now: their workspace
 * failed, or they are waiting in live help.
 */
export function needsAttention(
	member: CourseMember,
	waiting: ReadonlySet<string>,
): boolean {
	return (
		member.workspaceState === "error" ||
		(member.userId !== null && waiting.has(member.userId))
	);
}

/** The members a filter and a name search leave, in their order. */
export function filterMembers(
	members: readonly CourseMember[],
	filter: MemberFilter,
	query: string,
	waiting: ReadonlySet<string>,
): CourseMember[] {
	const needle = query.trim().toLocaleLowerCase();
	return members.filter((member) => {
		if (needle && !member.displayName.toLocaleLowerCase().includes(needle))
			return false;
		const student = member.role === "student";
		switch (filter) {
			case "attention":
				return student && needsAttention(member, waiting);
			case "running":
				return student && member.workspaceState === "running";
			case "stopped":
				return student && member.workspaceState === "stopped";
			case "instructors":
				return !student;
			default:
				return true;
		}
	});
}

/**
 * The members with those waiting in live help first, longest wait first,
 * then any failed workspace, then everyone else in their given order.
 * `waitingSince` maps a user id to when their request started.
 */
export function attentionFirst(
	members: readonly CourseMember[],
	waitingSince: ReadonlyMap<string, string>,
): CourseMember[] {
	const rank = (member: CourseMember) => {
		if (member.userId !== null && waitingSince.has(member.userId)) return 0;
		return member.workspaceState === "error" ? 1 : 2;
	};
	const since = (member: CourseMember) =>
		(member.userId !== null && waitingSince.get(member.userId)) || "";
	// Array.prototype.sort is stable, so equal ranks keep the roster's order.
	return [...members].sort(
		(a, b) => rank(a) - rank(b) || since(a).localeCompare(since(b)),
	);
}

/** "Waiting 12 min", "Waiting 1 h 5 min"; under a minute, "Waiting for help". */
export function waitingText(startedAt: string, now: number): string {
	const minutes = Math.floor((now - Date.parse(startedAt)) / 60_000);
	if (!(minutes >= 1)) return "Waiting for help";
	if (minutes < 60) return `Waiting ${minutes} min`;
	const rest = minutes % 60;
	return `Waiting ${Math.floor(minutes / 60)} h${rest ? ` ${rest} min` : ""}`;
}
