import { AdminGroup } from "../AdminSection.js";

/** LMS platforms for LTI launches: the operator's, read-only, and the page's own (ADR 0059). */
export function LmsGroup() {
	return (
		<AdminGroup
			id="admin-signin-lms"
			title="Learning management systems"
			testId="admin-signin-lms"
		>
			{null}
		</AdminGroup>
	);
}
