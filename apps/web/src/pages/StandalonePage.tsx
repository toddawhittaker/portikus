import { NameMark } from "@portikus/ui";
import type * as React from "react";

/** The frame the sign-in, session-ended and not-authorized pages share. */
export function StandalonePage({
	testId,
	children,
}: {
	testId?: string;
	children: React.ReactNode;
}) {
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
