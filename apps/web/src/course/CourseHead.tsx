import { PorticoMark } from "../common/PorticoMark.js";
import { useCourses } from "./queries.js";

/** "CS 1210" from "CS 1210: Programming for the Web"; null when the title has no short code before a colon. */
export function courseCode(title: string): string | null {
	const [head, rest] = title.split(":");
	const code = head?.trim();
	if (rest === undefined || !code || code.length > 16) return null;
	return code;
}

/**
 * The eyebrow over a course page's title: the portico glyph, "Courses", then
 * the course's code, the way the student header sets a project's path beside
 * its name. Decorative; the title names the page.
 */
export function CourseEyebrow({
	courseId,
	title,
}: {
	/** Looks the title up in the course list when the page does not have it. */
	courseId?: string;
	title?: string;
}) {
	const courses = useCourses();
	const known =
		title ?? courses.data?.find((course) => course.id === courseId)?.title ?? null;
	const code = known ? (courseCode(known) ?? known) : null;
	return (
		<p className="pk-eyebrow pk-course-eyebrow" aria-hidden={true}>
			<PorticoMark />
			<span>Courses</span>
			{code ? (
				<>
					<span className="pk-eyebrow-sep">/</span>
					<span className="pk-eyebrow-code">{code}</span>
				</>
			) : null}
		</p>
	);
}
