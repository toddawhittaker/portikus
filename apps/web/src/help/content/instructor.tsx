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
		{
			id: "instructor-live-help",
			title: "Live help in a student's terminal",
			body: (
				<>
					<p>
						A student can ask you for live help in one of their projects. Only the
						student can start it, and only for an instructor of one of their courses.
						You get a notification, and the session is listed under{" "}
						<strong>Live help</strong> on the Course page.
					</p>
					<ul>
						<li>
							Opening a session shows the student's terminals in that project as they
							are now, and what happens in them from then on. You do not see what
							scrolled past before you opened it.
						</li>
						<li>
							The page always says which mode you are in. <strong>Viewing only</strong>{" "}
							means nothing you type is sent. <strong>Typing allowed</strong> means what
							you type runs in the student's shell, as the student. Only the student can
							switch between the two, and the terminal reconnects when they do.
						</li>
						<li>
							The terminal keeps the size of the student's window and scrolls if yours
							is smaller. Press Alt+Shift+Q to move the keyboard out of it. While you
							can only view, Tab moves out of it too.
						</li>
						<li>
							<strong>Previews</strong> lists what the student's workspace is serving.
							Each opens in a new tab. It is the student's code running in your browser,
							so open only what you need.
						</li>
						<li>
							If you are also an administrator, help students from a separate account
							that is only an instructor. A preview runs the student's code in your
							browser on the same site as Portikus, so until previews move to a domain
							of their own, keep that code away from an administrator's sign-in.
						</li>
						<li>
							If the student closes their workspace in every browser, or it stops, the
							page says the student is away and reconnects when they return.
						</li>
						<li>
							A session ends when the student ends it, when you press{" "}
							<strong>Leave session</strong>, when the project is archived, or after an
							hour. Your view closes at once.
						</li>
					</ul>
				</>
			),
		},
	],
};
