import { Navigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { AppHeader } from "../shell/AppHeader.js";
import { useMe } from "../useMe.js";

/**
 * Checks the session, draws the header, and puts the page body in a labelled
 * main, for the Course pages. The body mounts only once signed in, so it
 * fetches nothing before.
 */
export function CourseFrame({
	testId,
	labelledBy,
	children,
}: {
	/** The test id of the main. */
	testId: string;
	/** The id of the page's h1. */
	labelledBy: string;
	children: ReactNode;
}) {
	const me = useMe();
	if (me.status === "loading") return <div className="pk-root" aria-busy="true" />;
	if (me.status === "anonymous") return <Navigate to="/" />;
	if (me.status === "forbidden") return <Navigate to="/not-authorized" />;
	return (
		// Unlike the workspace and admin pages, the Course pages work in a narrow
		// window beside the learning system, so they drop the shell's 1024 px floor.
		<div className="pk-root min-w-0!">
			<AppHeader user={me.user} workspace={null} project={undefined} context="Course" />
			{/* The admin page's frame (SPEC.md section 20.1): <main> scrolls, content
			    at most 1440 px wide, compact density. scroll-pt-16 keeps a focused
			    control clear of a sticky table header. A phone-width window
			    gives the content the padding's room back. */}
			<main
				className="flex-1 scroll-pt-16 overflow-auto p-4 sm:p-8"
				data-testid={testId}
				data-density="compact"
				aria-labelledby={labelledBy}
			>
				<div className="mx-auto w-full max-w-[1440px]">{children}</div>
			</main>
		</div>
	);
}
