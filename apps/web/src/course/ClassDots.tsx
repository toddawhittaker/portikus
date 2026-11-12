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

/** What each dot means, in the dots' own order. */
const DOT_LABEL: Record<DotKind, string> = {
	waiting: "Waiting for help",
	error: "Workspace error",
	running: "Running",
	moving: "Starting or stopping",
	stopped: "Stopped",
	none: "No workspace yet",
};

function sortedKinds(
	students: CourseMember[],
	waiting: ReadonlySet<string>,
): DotKind[] {
	return students
		.map((member) => dotKind(member, waiting))
		.sort((a, b) => DOT_ORDER.indexOf(a) - DOT_ORDER.indexOf(b));
}

/**
 * One small dot per student, so the class reads at a glance: amber waiting
 * for help, red failed, green running, blue starting or stopping, a hollow
 * ring stopped and a dashed one with no workspace. The words beside it say
 * the same, so the dots are decorative.
 */
export function ClassDots({
	students,
	waiting,
}: {
	students: CourseMember[];
	waiting: ReadonlySet<string>;
}) {
	const kinds = sortedKinds(students, waiting);
	return (
		<span className="pk-class-dots" aria-hidden="true">
			{kinds.map((kind, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: the dots are a sorted tally with no identity
				<span key={index} className="pk-class-dot" data-kind={kind} />
			))}
		</span>
	);
}

/**
 * The key to the dots: one entry per kind of dot shown. A student waiting
 * for help is amber whatever their workspace is doing, so the key says so
 * rather than leaving the reader to count. The sentence above carries the
 * figures for screen readers, so the key is decorative too.
 */
export function ClassDotsKey({
	students,
	waiting,
}: {
	students: CourseMember[];
	waiting: ReadonlySet<string>;
}) {
	const shown = new Set(sortedKinds(students, waiting));
	return (
		<ul className="pk-class-key" aria-hidden="true" data-testid="class-dots-key">
			{DOT_ORDER.filter((kind) => shown.has(kind)).map((kind) => (
				<li key={kind}>
					<span className="pk-class-dot" data-kind={kind} />
					{DOT_LABEL[kind]}
				</li>
			))}
		</ul>
	);
}
