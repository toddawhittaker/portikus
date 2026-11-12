import type { CourseListItem } from "@portikus/contracts";
import { Badge, Icon } from "@portikus/ui";
import { Link, Navigate } from "@tanstack/react-router";
import { PorticoMark } from "../common/PorticoMark.js";
import { QuietState } from "../common/QuietState.js";
import { usePageTitle } from "../pageTitle.js";
import { ClassDots, plural } from "./ClassDots.js";
import { CourseFrame } from "./CourseFrame.js";
import { CourseStatus } from "./CourseStatus.js";
import { useLiveSessions } from "./live/queries.js";
import { profileLabel } from "./profileText.js";
import { useCourseMembers, useCourses } from "./queries.js";
import "./course.css";
import "./glance.css";

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
			<CourseStatus>
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
			</CourseStatus>
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
	const sessions = useLiveSessions(course.id, { poll: false }).data?.sessions;
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
