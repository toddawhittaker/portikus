import { Link, Navigate, useParams } from "@tanstack/react-router";
import type * as React from "react";
import { WorkspaceStateBadge } from "../admin/WorkspacesTab.js";
import { ApiError } from "../api/request.js";
import { usePageTitle } from "../pageTitle.js";
import { AppHeader } from "../shell/AppHeader.js";
import { useMe } from "../useMe.js";
import { useCourseMembers, useCourses } from "./queries.js";
import type { CourseMember } from "./types.js";

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

function Message({ testId, children }: { testId: string; children: React.ReactNode }) {
	return (
		<p className="pk-text-body pk-muted mt-4" data-testid={testId} role="status">
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
			{courses.isError ? (
				<Message testId="course-error">
					Portikus could not load your courses. Reload the page to try again.
				</Message>
			) : !list ? (
				<div aria-busy="true" />
			) : list.length === 0 ? (
				<Message testId="course-empty">
					You have no courses here yet. A course appears after you open Portikus from it
					in your learning management system as an instructor.
				</Message>
			) : (
				<ul className="mt-4 flex flex-col gap-2" data-testid="course-list">
					{list.map((course) => (
						<li key={course.id}>
							<Link
								to="/course/$courseId"
								params={{ courseId: course.id }}
								className="pk-focus-ring rounded-sm font-semibold text-ink"
							>
								{course.title}
							</Link>{" "}
							<span className="pk-muted text-[13px]">{course.platformName}</span>
						</li>
					))}
				</ul>
			)}
		</>
	);
}

/** "23 Sep 2026, 14:05" in the browser's own locale and zone. */
function launchText(iso: string): string {
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "—";
	return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** `/course/:courseId`: who has opened Portikus from this course. Read-only. */
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
	const data = members.data;
	const notFound = members.error instanceof ApiError && members.error.status === 404;
	usePageTitle(data?.course.title ?? "Course");

	return (
		<>
			<h1 className="pk-text-title" id="course-title">
				{data?.course.title ?? "Course"}
			</h1>
			{data ? (
				<p className="pk-muted mt-1 text-[13px]">{data.course.platformName}</p>
			) : null}
			{members.isError ? (
				<Message testId="course-error">
					{notFound
						? "This course was not found, or you are not an instructor in it."
						: "Portikus could not load this course. Reload the page to try again."}
				</Message>
			) : !data ? (
				<div aria-busy="true" />
			) : data.members.length === 0 ? (
				<Message testId="course-members-empty">
					Nobody has opened Portikus from this course yet.
				</Message>
			) : (
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
							<th scope="col" className="py-2 font-medium">
								Workspace
							</th>
						</tr>
					</thead>
					<tbody>
						{data.members.map((member, index) => (
							// Members carry no id; the API's order is stable.
							// biome-ignore lint/suspicious/noArrayIndexKey: see above
							<tr key={index} className="border-line border-t">
								<th scope="row" className="py-2 pr-4 font-normal">
									{member.displayName}
								</th>
								<td className="py-2 pr-4">{ROLE_LABEL[member.role]}</td>
								<td className="py-2 pr-4">{launchText(member.lastLaunchAt)}</td>
								<td className="py-2">
									{member.workspaceState ? (
										<WorkspaceStateBadge
											state={member.workspaceState}
											desiredState=""
										/>
									) : (
										"No workspace"
									)}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			)}
		</>
	);
}
