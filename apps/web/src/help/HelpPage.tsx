import { Link, Navigate } from "@tanstack/react-router";
import { ADMIN_HELP_TAB } from "../admin/tabs.js";
import { useCourses } from "../course/queries.js";
import { usePageTitle } from "../pageTitle.js";
import { AppHeader } from "../shell/AppHeader.js";
import { type MeUser, useMe } from "../useMe.js";
import { INSTRUCTOR_HELP } from "./content/instructor.js";
import type { HelpPart } from "./content/part.js";
import { STUDENT_HELP } from "./content/student.js";
import { HelpDocument } from "./HelpDocument.js";
import { ADMIN_HELP_TITLE, WORKSPACE_HELP_TITLE } from "./titles.js";

/**
 * The parts of the workspace help a person sees. Presentation only: the text
 * holds nothing secret, it is just not useful to everyone. Anyone who is not
 * a plain student, or who teaches a course, gets the instructor part too.
 * The administrator part lives on its own page inside Administration.
 */
export function helpParts(role: MeUser["role"], teaches: boolean): HelpPart[] {
	const parts = [STUDENT_HELP];
	if (role !== "student" || teaches) parts.push(INSTRUCTOR_HELP);
	return parts;
}

/** `/help`: the workspace help, opened in its own tab from the account menu. */
export function HelpPage() {
	const me = useMe();
	usePageTitle(`${WORKSPACE_HELP_TITLE}, Help`);
	if (me.status === "loading") return <div className="pk-root" aria-busy="true" />;
	if (me.status === "anonymous") return <Navigate to="/" />;
	if (me.status === "forbidden") return <Navigate to="/not-authorized" />;
	return <HelpBody user={me.user} />;
}

function HelpBody({ user }: { user: MeUser }) {
	const courses = useCourses();
	const parts = helpParts(user.role, (courses.data?.length ?? 0) > 0);
	return (
		<div className="pk-root">
			<AppHeader user={user} workspace={null} project={undefined} context="Help" />
			<main
				className="flex-1 overflow-auto p-8"
				data-testid="page-help"
				data-density="comfortable"
				aria-labelledby="help-title"
			>
				<HelpDocument
					title={WORKSPACE_HELP_TITLE}
					titleId="help-title"
					parts={parts}
					elsewhere={
						user.role === "administrator" ? (
							<>
								For running the site, read{" "}
								<Link
									className="pk-link"
									to="/admin/$tab"
									params={{ tab: ADMIN_HELP_TAB }}
								>
									{ADMIN_HELP_TITLE}
								</Link>
								.
							</>
						) : undefined
					}
				/>
			</main>
		</div>
	);
}
