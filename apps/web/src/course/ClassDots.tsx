import type { CourseMember } from "@portikus/contracts";

/** "1 student", "9 students". */
export function plural(count: number, one: string, many: string): string {
	return `${count} ${count === 1 ? one : many}`;
}

/** The order a class's dots read in: who needs you, who is working, then the rest. */
const DOT_ORDER = ["waiting", "error", "running", "moving", "stopped", "none"] as const;
type DotKind = (typeof DOT_ORDER)[number];

function dotKind(member: CourseMember, waiting: ReadonlySet<string>): DotKind {
	if (member.userId !== null && waiting.has(member.userId)) return "waiting";
	const state = member.workspaceState;
	if (state === "error") return "error";
	if (state === "running") return "running";
	if (state === "stopped") return "stopped";
	if (state) return "moving";
	return "none";
}

/**
 * One small dot per student, so the class reads at a glance: filled green
 * running, amber waiting for help, red failed, a hollow ring stopped. The
 * words beside it say the same, so the dots are decorative.
 */
export function ClassDots({
	students,
	waiting,
}: {
	students: CourseMember[];
	waiting: ReadonlySet<string>;
}) {
	const kinds = students
		.map((member) => dotKind(member, waiting))
		.sort((a, b) => DOT_ORDER.indexOf(a) - DOT_ORDER.indexOf(b));
	return (
		<span className="pk-class-dots" aria-hidden="true">
			{kinds.map((kind, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: the dots are a sorted tally with no identity
				<span key={index} className="pk-class-dot" data-kind={kind} />
			))}
		</span>
	);
}
