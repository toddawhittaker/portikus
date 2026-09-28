import type { HelpPart } from "./part.js";

/** For instructors, and for administrators, who can teach too. */
export const INSTRUCTOR_HELP: HelpPart = {
	id: "instructor",
	title: "For instructors",
	topics: [
		{
			id: "instructor-course",
			title: "The Course page",
			body: (
				<p>
					Once you open Portikus from a course you teach in your learning system, a{" "}
					<strong>Course</strong> link appears in the header of your workspace. It opens
					the course's page in a new tab. The page lists everyone who has opened
					Portikus from the course, with their role, last launch and workspace state.{" "}
					<strong>Remove</strong> takes a student off the page. Their account, workspace
					and files stay, and they come back if they open Portikus from the course
					again. Only students can be removed; instructors are changed in your learning
					system.
				</p>
			),
		},
	],
};
