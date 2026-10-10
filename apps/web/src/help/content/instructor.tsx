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
				<>
					<p>
						Once you open Portikus from a course you teach in your learning system, a{" "}
						<strong>Course</strong> link appears in the header of your workspace. It
						opens the course's page in a new tab. The page lists the course's people
						with their role, last launch and workspace state.
					</p>
					<ul>
						<li>
							The list comes from your learning system's roster. People on the roster
							who have never opened Portikus show as <strong>Not started</strong>.
						</li>
						<li>
							Portikus refreshes the roster when you open the page, at most once an
							hour. <strong>Sync roster</strong> refreshes it at once. Someone who has
							left the course in your learning system leaves the page too; their
							account, workspace and files stay.
						</li>
						<li>
							If your learning system is not set up for roster sync, the page says so
							and lists only the people who have opened Portikus from the course.
						</li>
						<li>
							<strong>Remove</strong> takes a student off the page. Their account,
							workspace and files stay, and they come back if they open Portikus from
							the course again. Only students can be removed; instructors are changed in
							your learning system.
						</li>
					</ul>
				</>
			),
		},
		{
			id: "instructor-agent-usage",
			title: "Coding-agent use in your course",
			body: (
				<p>
					The Course page shows how much each person in the course used Claude Code and
					Codex over the last 7, 30 or 90 days: sessions, tokens, the estimated cost and
					lines added and removed. These are counts only. You never see anyone's
					prompts, the agents' answers or their code. Students are told that instructors
					see these counts.
				</p>
			),
		},
		{
			id: "instructor-shares",
			title: "Projects students share with you",
			body: (
				<>
					<p>
						You see a student's project only when the student shares it with you. You
						cannot open it on your own. A shared project is listed on the Course page,
						and opening it shows its files, Git status and changes, and the latest check
						results.
					</p>
					<ul>
						<li>
							The view is read-only. You cannot change files, run anything, or see the
							student's terminals, previews or secret files such as <code>.env</code>.
						</li>
						<li>
							The share ends after 24 hours or when the student stops it. The student
							sees who looked, and gets a notification the first time you open it.
						</li>
						<li>
							If the student's workspace is stopped, the view says so. Opening it never
							starts the workspace.
						</li>
					</ul>
				</>
			),
		},
	],
};
