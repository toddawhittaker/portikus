import { NameMark } from "@portikus/ui";
import type * as React from "react";
import { usePageTitle } from "../pageTitle.js";

/** The frame the sign-in, session-ended and not-authorized pages share. */
export function StandalonePage({
	title,
	testId,
	children,
}: {
	/** The browser tab's name for this page. */
	title: string;
	testId?: string;
	children: React.ReactNode;
}) {
	usePageTitle(title);
	return (
		<div className="pk-root">
			<main className="pk-standalone" data-testid={testId}>
				<section className="pk-standalone-panel" aria-labelledby="page-title">
					<NameMark size={28} />
					{children}
				</section>
				<p className="pk-standalone-foot">
					Portikus keeps your workspace, not your prompts or command history.
				</p>
			</main>
		</div>
	);
}
