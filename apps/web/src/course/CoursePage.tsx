import type {
	ActiveCourseMember,
	CourseListItem,
	CourseMember,
} from "@portikus/contracts";
import {
	Badge,
	Icon,
	IconButton,
	Menu,
	MenuItem,
	MenuRoot,
	MenuTrigger,
	PageIntro,
	StateBadge,
	Toggletip,
} from "@portikus/ui";
import { Link, Navigate, useParams } from "@tanstack/react-router";
import * as React from "react";
import { ApiError } from "../api/request.js";
import { PorticoMark } from "../common/PorticoMark.js";
import { QuietState } from "../common/QuietState.js";
import { usePageTitle } from "../pageTitle.js";
import { useMe } from "../useMe.js";
import { ClassDots, plural } from "./ClassDots.js";
import { CourseFrame } from "./CourseFrame.js";
import { LiveHelpCard, MemberCounts } from "./CourseGlance.js";
import { CourseEyebrow } from "./CourseHead.js";
import { CourseProfile } from "./CourseProfile.js";
import { CourseUsage } from "./CourseUsage.js";
import { useLiveSessions } from "./live/queries.js";
import {
	attentionFirst,
	filterMembers,
	MEMBER_FILTER_LABEL,
	MEMBER_FILTERS,
	type MemberFilter,
	waitingText,
} from "./memberFilter.js";
import { profileLabel } from "./profileText.js";
import { useCourseMembers, useCourses } from "./queries.js";
import { RemoveMemberConfirm } from "./RemoveMemberConfirm.js";
import { RosterStatus } from "./RosterStatus.js";
import { useCourseShares } from "./shared/queries.js";
import { dateTimeText } from "./time.js";
import "./course.css";
import "./glance.css";

const ROLE_LABEL: Record<CourseMember["role"], string> = {
	student: "Student",
	instructor: "Instructor",
};

/**
 * One live region that stays mounted under the heading, so a screen reader
 * hears the loading text change to the error or empty text.
 */
function Status({ children }: { children: React.ReactNode }) {
	return (
		<p className="pk-text-body pk-muted mt-4" role="status">
			{children}
		</p>
	);
}

/** `/course`: the courses the caller teaches, or straight into the only one. */
export function CourseListPage() {
	return (
		<CourseFrame testId="page-course" labelledBy="course-title">
			<CourseList />
		</CourseFrame>
	);
}

/** The course's code for its tile: "1210" from "CS 1210: Programming", or the title's initials. */
export function courseMonogram(title: string): string {
	const code = title.split(":")[0]?.match(/\d{3,5}/)?.[0];
	if (code) return code;
	const letters = title
		.split(/\s+/)
		.filter(Boolean)
		.slice(0, 2)
		.map((word) => word[0]?.toUpperCase() ?? "")
		.join("");
	return letters || "?";
}

function CourseList() {
	const courses = useCourses();
	const list = courses.data;
	usePageTitle("Courses");
	if (list?.length === 1 && list[0]) {
		return (
			<Navigate to="/course/$courseId" params={{ courseId: list[0].id }} replace />
		);
	}
	return (
		<>
			<div className="pk-admin-head">
				<p className="pk-eyebrow" aria-hidden={true}>
					<PorticoMark />
					<span>Teaching</span>
				</p>
				<h1 className="pk-text-display pk-admin-title" id="course-title">
					Courses
				</h1>
				<p className="pk-intro-lead pk-muted m-0">
					The courses you teach here. Open one for its students, their workspaces and
					live help.
				</p>
			</div>
			<Status>
				{courses.isError ? (
					<span data-testid="course-error">
						Portikus could not load your courses. Reload the page to try again.
					</span>
				) : !list ? (
					"Loading courses…"
				) : list.length === 0 ? (
					<span data-testid="course-empty">
						You have no courses here yet. A course appears after you open Portikus from
						it in your learning management system as an instructor.
					</span>
				) : null}
			</Status>
			{list && list.length > 0 ? (
				<div className="grid gap-4">
					<ul className="pk-course-cards" data-testid="course-list">
						{list.map((course) => (
							<CourseCard key={course.id} course={course} />
						))}
					</ul>
					<QuietState
						variant="empty"
						title="Teaching another course?"
						detail="Open Portikus from it in your learning system as its instructor, and it appears here."
					/>
				</div>
			) : null}
		</>
	);
}

/** A course on the list: its code, title and source, a dot per student, and who is waiting. */
function CourseCard({ course }: { course: CourseListItem }) {
	const members = useCourseMembers(course.id).data?.members;
	const sessions = useLiveSessions(course.id).data?.sessions;
	const waiting = new Set(sessions?.map((session) => session.userId));
	const students = members?.filter((member) => member.role === "student");
	const running = students?.filter((m) => m.workspaceState === "running").length ?? 0;
	return (
		<li className="pk-course-card">
			<div className="pk-course-card-top">
				<span className="pk-course-mono" aria-hidden="true">
					{courseMonogram(course.title)}
				</span>
				<span className="grid min-w-0 flex-1 gap-0.5">
					{/* The whole card is the link's target; its name stays the title alone. */}
					<Link
						to="/course/$courseId"
						params={{ courseId: course.id }}
						className="pk-course-card-link pk-focus-ring rounded-sm [overflow-wrap:anywhere] after:absolute after:inset-0"
					>
						{course.title}
					</Link>
					<span className="pk-muted text-[13px]">
						{course.platformName}
						<span aria-hidden="true"> · </span>
						<span className="sr-only">, </span>
						{profileLabel(course.profile)} interface
					</span>
				</span>
				<Icon name="chevron-right" className="pk-course-card-chevron" />
			</div>
			{students && students.length > 0 ? (
				<ClassDots students={students} waiting={waiting} />
			) : (
				<span className="pk-class-dots" aria-hidden="true" />
			)}
			<p className="pk-course-card-foot">
				<span className="pk-num">
					{students
						? students.length === 0
							? "No students yet"
							: `${running} of ${plural(students.length, "student", "students")} running`
						: "\u00a0"}
				</span>
				{waiting.size > 0 ? (
					<Badge tone="warning">
						<Icon name="help" size="sm" />
						{waiting.size} waiting for help
					</Badge>
				) : null}
			</p>
		</li>
	);
}

/**
 * Below this container width the Role and Last launch columns fold into the
 * Name cell; at a 768 px window all five columns still fit.
 */
const WIDE_ONLY = "@max-2xl:hidden";
const NARROW_ONLY = "hidden @max-2xl:block";

/**
 * Only students who launched can be removed; instructors are the learning
 * system's to change, and a roster-only person has no membership yet.
 */
function canRemove(
	member: CourseMember,
	myId: string | null,
): member is ActiveCourseMember {
	return (
		member.status === "active" && member.role === "student" && member.userId !== myId
	);
}

/** The member whose Remove button takes focus after one is removed: the next, else the previous. */
export function nextRemovable(
	members: CourseMember[],
	removedId: string,
	myId: string | null,
): string | null {
	const index = members.findIndex((member) => member.userId === removedId);
	const others = (list: CourseMember[]) =>
		list.find((member) => canRemove(member, myId))?.userId ?? null;
	return (
		others(members.slice(index + 1)) ??
		others(members.slice(0, index).reverse()) ??
		null
	);
}

/** When a member last launched; someone on the roster who never has reads "Never". */
function LastLaunch({ at }: { at: string | null }) {
	if (at === null) return <>Never</>;
	return <time dateTime={at}>{dateTimeText(at)}</time>;
}

/** The name search and the filter chips above the Members table, each chip with its count. */
function MemberTools({
	members,
	query,
	onQuery,
	filter,
	onFilter,
	waiting,
}: {
	members: CourseMember[];
	query: string;
	onQuery: (query: string) => void;
	filter: MemberFilter;
	onFilter: (filter: MemberFilter) => void;
	waiting: ReadonlySet<string>;
}) {
	return (
		<div className="pk-members-tools">
			<label className="pk-members-search">
				<span className="sr-only">Search members by name</span>
				<Icon name="search" size="sm" className="pk-members-search-icon" />
				<input
					type="search"
					className="pk-focus-ring"
					placeholder="Search by name"
					value={query}
					onChange={(event) => onQuery(event.target.value)}
					data-testid="course-members-search"
				/>
			</label>
			<fieldset className="pk-chips" data-testid="course-members-filter">
				<legend className="sr-only">Show members</legend>
				{MEMBER_FILTERS.map((option) => {
					const count = filterMembers(members, option, query, waiting).length;
					// A course nobody teaches from Portikus yet has no instructor rows to show.
					if (option === "instructors" && count === 0 && filter !== option) return null;
					return (
						<button
							key={option}
							type="button"
							className="pk-chip pk-focus-ring"
							aria-pressed={filter === option}
							onClick={() => onFilter(option)}
						>
							{MEMBER_FILTER_LABEL[option]}
							<span className="pk-chip-count pk-num">{count}</span>
						</button>
					);
				})}
			</fieldset>
		</div>
	);
}

/** The Members live region: loading, failure, an empty course, or a search with no matches. */
function MembersStatus({
	failed,
	notFound,
	total,
	shown,
}: {
	failed: boolean;
	notFound: boolean;
	total: number | undefined;
	shown: number;
}) {
	return (
		<Status>
			{failed ? (
				<span data-testid="course-error">
					{notFound
						? "This course was not found, or you are not an instructor in it."
						: "Portikus could not load this course. Reload the page to try again."}
				</span>
			) : total === undefined ? (
				"Loading this course…"
			) : total === 0 ? (
				<span data-testid="course-members-empty">
					Nobody has opened Portikus from this course yet.
				</span>
			) : shown === 0 ? (
				<span data-testid="course-members-none-match">
					No members match. Clear the search or choose All.
				</span>
			) : null}
		</Status>
	);
}

/** One member's row: name, role, last launch, workspace with any warning, and the row actions. */
function MemberRow({
	rowId,
	member,
	courseId,
	shares,
	waitingLabel,
	removable,
	onRemove,
}: {
	rowId: string;
	member: CourseMember;
	courseId: string;
	shares: { projectId: string; projectName: string }[];
	/** "Waiting 12 min" while they wait in live help, else null. */
	waitingLabel: string | null;
	removable: boolean;
	onRemove: (member: ActiveCourseMember) => void;
}) {
	return (
		<tr data-waiting={waitingLabel ? "" : undefined}>
			{/* Named by the name alone, so the other cells' row header is not
		    read with the role and launch folded under it. */}
			<th
				scope="row"
				className="whitespace-normal py-2 font-semibold [overflow-wrap:anywhere]"
				aria-labelledby={`member-name-${rowId}`}
			>
				<span id={`member-name-${rowId}`}>{member.displayName}</span>
				<span className={`${NARROW_ONLY} pk-cell-muted text-[12px] font-normal`}>
					{ROLE_LABEL[member.role]}
					<span aria-hidden="true"> · </span>
					<span className="sr-only">, </span>
					Last launch <LastLaunch at={member.lastLaunchAt} />
				</span>
			</th>
			<td className={`${WIDE_ONLY} pk-cell-muted`}>{ROLE_LABEL[member.role]}</td>
			<td className={WIDE_ONLY}>
				<LastLaunch at={member.lastLaunchAt} />
			</td>
			<td>
				<span className="pk-members-state">
					{member.workspaceState ? (
						<StateBadge
							state={member.workspaceState}
							statusRole={false}
							plain={member.workspaceState !== "error"}
						/>
					) : (
						<span className="pk-cell-muted">
							{member.status === "not_started" ? "Not started" : "No workspace"}
						</span>
					)}
					{waitingLabel ? (
						<Badge tone="warning">
							<Icon name="help" size="sm" />
							{waitingLabel}
						</Badge>
					) : null}
				</span>
			</td>
			<td className="pk-cell-actions">
				{/* Wraps in a narrow table, so the link and menu are never clipped. */}
				<div className="pk-row-actions">
					{shares.map((share) => (
						<Link
							key={share.projectId}
							to="/course/$courseId/shares/$projectId"
							params={{ courseId, projectId: share.projectId }}
							className="pk-row-link pk-focus-ring"
						>
							<Icon name="folder" size="sm" />
							Shared project
							<span className="sr-only">
								: {share.projectName} by {member.displayName}
							</span>
						</Link>
					))}
					{!removable || member.status !== "active" ? null : (
						<MenuRoot>
							<MenuTrigger asChild>
								<IconButton
									icon="more"
									size="sm"
									label={`Actions for ${member.displayName}`}
									data-remove-id={member.userId}
								/>
							</MenuTrigger>
							<Menu label={`Actions for ${member.displayName}`} align="end">
								<MenuItem
									icon="trash"
									danger
									testId="course-member-remove"
									onSelect={() => onRemove(member)}
								>
									Remove from course
								</MenuItem>
							</Menu>
						</MenuRoot>
					)}
				</div>
			</td>
		</tr>
	);
}

/** `/course/:courseId`: who has opened Portikus from this course, and removing them. */
export function CourseMembersPage() {
	return (
		<CourseFrame testId="page-course" labelledBy="course-title">
			<CourseMembers />
		</CourseFrame>
	);
}

function CourseMembers() {
	const { courseId } = useParams({ from: "/course/$courseId" });
	const members = useCourseMembers(courseId);
	const shares = useCourseShares(courseId);
	const me = useMe();
	const myId = me.status === "authenticated" ? me.user.id : null;
	const [removing, setRemoving] = React.useState<ActiveCourseMember | null>(null);
	const [removedText, setRemovedText] = React.useState("");
	const headingRef = React.useRef<HTMLHeadingElement>(null);
	// Set by a successful removal so the closing dialog focuses what is left.
	const removedNext = React.useRef<{ next: string | null } | null>(null);
	const data = members.data;
	// An instructor sees each member's open shares; a failed shares read just shows no links.
	const openShares = shares.data?.shares ?? [];
	const notFound = members.error instanceof ApiError && members.error.status === 404;
	usePageTitle(data?.course.title ?? "Course");
	const [query, setQuery] = React.useState("");
	const [filter, setFilter] = React.useState<MemberFilter>("all");
	const sessions = useLiveSessions(courseId).data?.sessions;
	const waitingSince = React.useMemo(() => {
		const since = new Map<string, string>();
		for (const session of sessions ?? []) {
			const was = since.get(session.userId);
			if (!was || session.startedAt < was) since.set(session.userId, session.startedAt);
		}
		return since;
	}, [sessions]);
	const waiting = React.useMemo(() => new Set(waitingSince.keys()), [waitingSince]);
	const shown = data
		? attentionFirst(filterMembers(data.members, filter, query, waiting), waitingSince)
		: [];
	const now = Date.now();

	return (
		<>
			<div className="pk-admin-head">
				<CourseEyebrow title={data?.course.title} courseId={courseId} />
				<div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
					<h1
						className="pk-text-display pk-admin-title"
						id="course-title"
						ref={headingRef}
						tabIndex={-1}
					>
						{data?.course.title ?? "Course"}
					</h1>
					{data ? (
						<p className="pk-course-source m-0">{data.course.platformName}</p>
					) : null}
				</div>
				<PageIntro
					id="course"
					summary="About the Course page"
					lead="Who has opened Portikus from this course, and how their workspaces are doing."
					helpHref="/help#instructor-course"
				>
					People who have opened Portikus from this course, and, when roster sync is on,
					people on the course roster who have not yet. Remove takes a student off this
					page. Their account, workspace and files stay, and they come back if they open
					Portikus from the course again. You can also choose the interface your
					students see.
				</PageIntro>
			</div>
			<div className="pk-course-glance mt-4">
				{data && data.members.length > 0 ? (
					<MemberCounts members={data.members} waiting={waiting} />
				) : null}
				<LiveHelpCard courseId={courseId} sessions={sessions} />
			</div>
			<section
				className="mt-6 grid grid-cols-[minmax(0,1fr)] gap-3"
				aria-labelledby="members-title"
			>
				<div className="pk-members-head">
					<h2 className="pk-text-heading m-0" id="members-title">
						Members
						{data && data.members.length > 0 ? (
							<span className="pk-members-count pk-num">
								{shown.length === data.members.length
									? data.members.length
									: `${shown.length} of ${data.members.length}`}
							</span>
						) : null}
					</h2>
					{data && data.members.length > 0 ? (
						<MemberTools
							members={data.members}
							query={query}
							onQuery={setQuery}
							filter={filter}
							onFilter={setFilter}
							waiting={waiting}
						/>
					) : null}
				</div>
			</section>
			<MembersStatus
				failed={members.isError}
				notFound={notFound}
				total={data?.members.length}
				shown={shown.length}
			/>
			<span className="sr-only" role="status" data-testid="course-removed">
				{removedText}
			</span>
			{data && shown.length > 0 ? (
				// overflow-clip, not the wrap's overflow auto, so the header sticks to the scrolling <main>.
				// A narrow wrap folds Role and Last launch under the name, so nothing scrolls sideways.
				<div className="pk-table-wrap @container mt-3 overflow-clip">
					<table
						className="pk-table pk-table--page pk-members-table"
						data-testid="course-members"
					>
						<caption className="sr-only">People in this course</caption>
						<thead>
							<tr>
								<th scope="col">Name</th>
								<th scope="col" className={WIDE_ONLY}>
									Role
								</th>
								<th scope="col" className={WIDE_ONLY}>
									<span className="inline-flex items-center gap-1">
										Last launch
										<Toggletip label="Last launch">
											When they last opened Portikus from this course in your learning
											system.
										</Toggletip>
									</span>
								</th>
								<th scope="col">Workspace</th>
								<th scope="col" className="pk-cell-actions">
									<span className="sr-only">Actions</span>
								</th>
							</tr>
						</thead>
						<tbody>
							{shown.map((member, index) => (
								<MemberRow
									// A roster-only person has no account id yet; the list is replaced on each sync.
									key={member.userId ?? `roster-${index}`}
									rowId={member.userId ?? `roster-${index}`}
									member={member}
									courseId={courseId}
									shares={openShares.filter((share) => share.userId === member.userId)}
									waitingLabel={
										member.userId !== null && waitingSince.has(member.userId)
											? waitingText(waitingSince.get(member.userId) ?? "", now)
											: null
									}
									removable={canRemove(member, myId)}
									onRemove={(who) => {
										removedNext.current = null;
										setRemoving(who);
									}}
								/>
							))}
						</tbody>
					</table>
				</div>
			) : null}
			<section className="mt-10 grid gap-4" aria-labelledby="course-settings-title">
				<h2 className="pk-text-heading m-0" id="course-settings-title">
					Course settings
				</h2>
				<div className="grid items-start gap-4 @container lg:grid-cols-2">
					{data ? (
						<div className="pk-card p-5">
							<RosterStatus courseId={courseId} roster={data.roster} />
						</div>
					) : null}
					<div className="pk-card p-5">
						<CourseProfile courseId={courseId} />
					</div>
				</div>
			</section>
			<div className="mt-10">
				<CourseUsage courseId={courseId} />
			</div>
			{data && removing ? (
				<RemoveMemberConfirm
					courseId={courseId}
					courseTitle={data.course.title}
					member={removing}
					onClose={() => setRemoving(null)}
					onRemoved={() => {
						removedNext.current = {
							next: nextRemovable(data.members, removing.userId, myId),
						};
						setRemoving(null);
						setRemovedText(`Removed ${removing.displayName} from ${data.course.title}`);
					}}
					returnFocusTo={() => {
						const removed = removedNext.current;
						removedNext.current = null;
						if (!removed) return null;
						const button = removed.next
							? document.querySelector<HTMLElement>(
									`[data-remove-id="${removed.next}"]`,
								)
							: null;
						// With only yourself left, the heading, not the hidden caption.
						return button ?? headingRef.current;
					}}
				/>
			) : null}
		</>
	);
}
