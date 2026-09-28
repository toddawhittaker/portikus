import { Navigate } from "@tanstack/react-router";
import { useEffect } from "react";
import { useCourses } from "../course/queries.js";
import { usePageTitle } from "../pageTitle.js";
import { AppHeader } from "../shell/AppHeader.js";
import { type MeUser, useMe } from "../useMe.js";
import { ADMIN_HELP } from "./content/admin.js";
import { INSTRUCTOR_HELP } from "./content/instructor.js";
import type { HelpPart } from "./content/part.js";
import { STUDENT_HELP } from "./content/student.js";

/**
 * Which parts a person sees. Presentation only: the text holds nothing
 * secret, it is just not useful to everyone. A course account that teaches
 * has the student role but a Course page, so it gets the instructor part too.
 */
export function helpParts(role: MeUser["role"], teaches: boolean): HelpPart[] {
	const parts = [STUDENT_HELP];
	if (role === "administrator") parts.push(ADMIN_HELP);
	if (role !== "student" || teaches) parts.push(INSTRUCTOR_HELP);
	return parts;
}

/** `/help`: one page of plain help, opened in its own tab from the account menu. */
export function HelpPage() {
	const me = useMe();
	usePageTitle("Help");
	if (me.status === "loading") return <div className="pk-root" aria-busy="true" />;
	if (me.status === "anonymous") return <Navigate to="/" />;
	if (me.status === "forbidden") return <Navigate to="/not-authorized" />;
	return <HelpBody user={me.user} />;
}

function HelpBody({ user }: { user: MeUser }) {
	const courses = useCourses();
	const parts = helpParts(user.role, (courses.data?.length ?? 0) > 0);
	const shownIds = parts.map((part) => part.id).join(" ");

	// The page arrives after the browser looked for the #anchor, so go there once it exists.
	useEffect(() => {
		const id = decodeURIComponent(window.location.hash.slice(1));
		if (!id || !shownIds) return;
		document.getElementById(id)?.scrollIntoView();
	}, [shownIds]);

	return (
		<div className="pk-root">
			<AppHeader user={user} workspace={null} project={undefined} context="Help" />
			<main
				className="flex-1 overflow-auto p-8"
				data-testid="page-help"
				data-density="comfortable"
				aria-labelledby="help-title"
			>
				<div className="pk-help mx-auto w-full max-w-[1440px]">
					<h1 className="pk-text-title" id="help-title">
						Help
					</h1>
					<div className="pk-help-layout">
						<nav aria-label="Help contents" className="pk-help-nav">
							<ol className="pk-help-toc">
								{parts.map((part) => (
									<li key={part.id} className="pk-help-toc-part">
										<a href={`#${part.id}`}>{part.title}</a>
										<ol className="pk-help-toc-sub">
											{part.topics.map((topic) => (
												<li key={topic.id}>
													<a href={`#${topic.id}`}>{topic.title}</a>
												</li>
											))}
										</ol>
									</li>
								))}
							</ol>
						</nav>
						<article className="pk-help-article">
							{parts.map((part) => (
								<section key={part.id} aria-labelledby={part.id}>
									<h2 className="pk-text-heading" id={part.id}>
										{part.title}
									</h2>
									{part.topics.map((topic) => (
										<section key={topic.id}>
											<h3 id={topic.id}>{topic.title}</h3>
											{topic.body}
										</section>
									))}
								</section>
							))}
						</article>
					</div>
				</div>
			</main>
		</div>
	);
}
