import type { ActiveCourseMember, CourseMember } from "@portikus/contracts";
import { Button, PageIntro, StateBadge, Toggletip } from "@portikus/ui";
import { Link, Navigate, useParams } from "@tanstack/react-router";
import * as React from "react";
import { ApiError } from "../api/request.js";
import { usePageTitle } from "../pageTitle.js";
import { useMe } from "../useMe.js";
import { CourseFrame } from "./CourseFrame.js";
import { useCourseMembers, useCourses } from "./queries.js";
import { RemoveMemberConfirm } from "./RemoveMemberConfirm.js";

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
			<h1 className="pk-text-title" id="course-title">
				Courses
			</h1>
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
				<ul className="mt-4 flex flex-col gap-2" data-testid="course-list">
					{list.map((course) => (
						<li key={course.id}>
							<Link
								to="/course/$courseId"
								params={{ courseId: course.id }}
								className="pk-focus-ring rounded-sm font-semibold text-accent-text"
							>
								{course.title}
							</Link>{" "}
							<span className="pk-muted text-[13px]">{course.platformName}</span>
						</li>
					))}
				</ul>
			) : null}
		</>
	);
}

/**
 * Below this container width the Role and Last launch columns fold into the
 * Name cell; at a 768 px window all five columns still fit.
 */
const WIDE_ONLY = "@max-2xl:hidden";
const NARROW_ONLY = "hidden @max-2xl:block";

/** "23 Sep 2026, 14:05" in the browser's own locale and zone. */
function launchText(iso: string | null): string {
	if (iso === null) return "—";
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "—";
	return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

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
	const me = useMe();
	const myId = me.status === "authenticated" ? me.user.id : null;
	const [removing, setRemoving] = React.useState<ActiveCourseMember | null>(null);
	const [removedText, setRemovedText] = React.useState("");
	const headingRef = React.useRef<HTMLHeadingElement>(null);
	// Set by a successful removal so the closing dialog focuses what is left.
	const removedNext = React.useRef<{ next: string | null } | null>(null);
	const data = members.data;
	const notFound = members.error instanceof ApiError && members.error.status === 404;
	usePageTitle(data?.course.title ?? "Course");

	return (
		<>
			<h1 className="pk-text-title" id="course-title" ref={headingRef} tabIndex={-1}>
				{data?.course.title ?? "Course"}
			</h1>
			{data ? (
				<p className="pk-muted mt-1 text-[13px]">{data.course.platformName}</p>
			) : null}
			<div className="mt-4">
				<PageIntro
					id="course"
					summary="About the Course page"
					helpHref="/help#instructor-course"
				>
					Everyone who has opened Portikus from this course. Remove takes a student off
					this page. Their account, workspace and files stay, and they come back if they
					open Portikus from the course again.
				</PageIntro>
			</div>
			<Status>
				{members.isError ? (
					<span data-testid="course-error">
						{notFound
							? "This course was not found, or you are not an instructor in it."
							: "Portikus could not load this course. Reload the page to try again."}
					</span>
				) : !data ? (
					"Loading this course…"
				) : data.members.length === 0 ? (
					<span data-testid="course-members-empty">
						Nobody has opened Portikus from this course yet.
					</span>
				) : null}
			</Status>
			<span className="sr-only" role="status" data-testid="course-removed">
				{removedText}
			</span>
			{data && data.members.length > 0 ? (
				// overflow-clip, not the wrap's overflow auto, so the header sticks to the scrolling <main>.
				// A narrow wrap folds Role and Last launch under the name, so nothing scrolls sideways.
				<div className="pk-table-wrap @container mt-4 overflow-clip">
					<table className="pk-table pk-table--page" data-testid="course-members">
						<caption className="sr-only">
							People who have opened Portikus from this course
						</caption>
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
							{data.members.map((member) => (
								<tr key={member.userId}>
									{/* Named by the name alone, so the other cells' row header is not
									    read with the role and launch folded under it. */}
									<th
										scope="row"
										className="whitespace-normal py-2 font-semibold [overflow-wrap:anywhere]"
										aria-labelledby={`member-name-${member.userId}`}
									>
										<span id={`member-name-${member.userId}`}>
											{member.displayName}
										</span>
										<span
											className={`${NARROW_ONLY} pk-cell-muted text-[12px] font-normal`}
										>
											{ROLE_LABEL[member.role]}
											<span aria-hidden="true"> · </span>
											<span className="sr-only">, </span>
											Last launch{" "}
											<time dateTime={member.lastLaunchAt ?? undefined}>
												{launchText(member.lastLaunchAt)}
											</time>
										</span>
									</th>
									<td className={WIDE_ONLY}>{ROLE_LABEL[member.role]}</td>
									<td className={WIDE_ONLY}>
										<time dateTime={member.lastLaunchAt ?? undefined}>
											{launchText(member.lastLaunchAt)}
										</time>
									</td>
									<td>
										{member.workspaceState ? (
											<StateBadge state={member.workspaceState} statusRole={false} />
										) : (
											<span className="pk-cell-muted">No workspace</span>
										)}
									</td>
									<td className="pk-cell-actions">
										{!canRemove(member, myId) ? null : (
											<Button
												size="sm"
												data-remove-id={member.userId}
												onClick={() => {
													removedNext.current = null;
													setRemoving(member);
												}}
											>
												Remove{" "}
												<span className="sr-only">
													{member.displayName} from course
												</span>
											</Button>
										)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			) : null}
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
