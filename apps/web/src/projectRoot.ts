/** Where a project lives in the workspace: Claude Code and the shell start here (SPEC.md §4.4). */
export function projectRoot(slug: string): string {
	return `/home/student/projects/${slug}`;
}
