import type { CourseMember } from "@portikus/contracts";
import { Button, StateBadge } from "@portikus/ui";
import { Link, Navigate, useParams } from "@tanstack/react-router";
import * as React from "react";
import { ApiError } from "../api/request.js";
import { usePageTitle } from "../pageTitle.js";
import { AppHeader } from "../shell/AppHeader.js";
import { useMe } from "../useMe.js";
import { useCourseMembers, useCourses } from "./queries.js";
import { RemoveMemberConfirm } from "./RemoveMemberConfirm.js";

const ROLE_LABEL: Record<CourseMember["role"], string> = {
	student: "Student",
	instructor: "Instructor",
};

/**
 * Checks the session, draws the header, and puts the page body in a labelled
 * main. The body mounts only once signed in, so it fetches nothing before.
 */
function CourseFrame({ children }: { children: React.ReactNode }) {
	const me = useMe();
	if (me.status === "loading") return <div className="pk-root" aria-busy="true" />;
	if (me.status === "anonymous") return <Navigate to="/" />;
	if (me.status === "forbidden") return <Navigate to="/not-authorized" />;
	return (
		<div className="pk-root">
			<AppHeader user={me.user} workspace={null} project={undefined} context="Course" />
			<main
				className="flex-1 overflow-auto p-8"
				data-testid="page-course"
				aria-labelledby="course-title"
			>
				{children}
			</main>
		</div>
	);
}

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
		<CourseFrame>
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

/** "23 Sep 2026, 14:05" in the browser's own locale and zone. */
function launchText(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "—";
	return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** The member whose Remove button takes focus after one is removed: the next, else the previous. */
export function nextRemovable(
	members: CourseMember[],
	removedId: string,
	myId: string | null,
): string | null {
	const index = members.findIndex((member) => member.userId === removedId);
	const others = (list: CourseMember[]) =>
		list.find((member) => member.userId !== myId)?.userId ?? null;
	return (
		others(members.slice(index + 1)) ??
		others(members.slice(0, index).reverse()) ??
		null
	);
}

/** `/course/:courseId`: who has opened Portikus from this course, and removing them. */
export function CourseMembersPage() {
	return (
		<CourseFrame>
			<CourseMembers />
		</CourseFrame>
	);
}

function CourseMembers() {
	const { courseId } = useParams({ from: "/course/$courseId" });
	const members = useCourseMembers(courseId);
	const me = useMe();
	const myId = me.status === "authenticated" ? me.user.id : null;
	const [removing, setRemoving] = React.useState<CourseMember | null>(null);
	const [removedText, setRemovedText] = React.useState("");
	const headingRef = React.useRef<HTMLHeadingElement>(null);
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
				<table
					className="mt-4 w-full text-left text-[13px]"
					data-testid="course-members"
				>
					<caption className="sr-only">
						People who have opened Portikus from this course
					</caption>
					<thead>
						<tr className="pk-text-label text-ink-muted">
							<th scope="col" className="py-2 pr-4 font-medium">
								Name
							</th>
							<th scope="col" className="py-2 pr-4 font-medium">
								Role
							</th>
							<th scope="col" className="py-2 pr-4 font-medium">
								Last launch
							</th>
							<th scope="col" className="py-2 pr-4 font-medium">
								Workspace
							</th>
							<th scope="col" className="py-2 font-medium">
								<span className="sr-only">Actions</span>
							</th>
						</tr>
					</thead>
					<tbody>
						{data.members.map((member) => (
							<tr key={member.userId} className="border-line border-t">
								<th scope="row" className="py-2 pr-4 font-normal">
									{member.displayName}
								</th>
								<td className="py-2 pr-4">{ROLE_LABEL[member.role]}</td>
								<td className="py-2 pr-4">{launchText(member.lastLaunchAt)}</td>
								<td className="py-2 pr-4">
									{member.workspaceState ? (
										<StateBadge state={member.workspaceState} statusRole={false} />
									) : (
										"No workspace"
									)}
								</td>
								<td className="py-2">
									{member.userId === myId ? null : (
										<Button
											size="sm"
											data-remove-id={member.userId}
											onClick={() => setRemoving(member)}
										>
											Remove{" "}
											<span className="sr-only">{member.displayName} from course</span>
										</Button>
									)}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			) : null}
			{data && removing ? (
				<RemoveMemberConfirm
					courseId={courseId}
					courseTitle={data.course.title}
					member={removing}
					onClose={() => setRemoving(null)}
					onRemoved={() => {
						const next = nextRemovable(data.members, removing.userId, myId);
						setRemoving(null);
						setRemovedText(`Removed ${removing.displayName} from ${data.course.title}`);
						// Wait for the row and the dialog to unmount, then land on what is left.
						requestAnimationFrame(() => {
							const button = next
								? document.querySelector<HTMLElement>(`[data-remove-id="${next}"]`)
								: null;
							// With only yourself left, the heading, not the hidden caption (review A3).
							(button ?? headingRef.current)?.focus();
						});
					}}
				/>
			) : null}
		</>
	);
}
