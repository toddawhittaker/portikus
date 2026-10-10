import { usePageTitle } from "../pageTitle.js";

/**
 * `/course/:courseId/shares/:projectId`: an instructor's read-only view of a
 * project a student shared (SPEC.md §5.2, ADR 0057). A placeholder until the
 * viewer is built; nothing links here yet.
 */
export function SharedProjectPage() {
	usePageTitle("Shared project");
	return (
		<main className="pk-root p-8" data-testid="page-shared-project">
			<h1 className="pk-text-title">Shared project</h1>
		</main>
	);
}
