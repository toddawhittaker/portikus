/**
 * The center pane: terminals, editors and previews for one project
 * (SPEC.md §8, §9.3). A stub for now so the shell and the project pane can
 * be built against its interface; the real work area lands with the
 * terminal splits.
 */
export interface WorkAreaProps {
	workspaceId: string;
	projectId: string;
	projectPath: string;
	running: boolean;
	onSessionEnded: () => void;
}

export function WorkArea(_props: WorkAreaProps) {
	return <div data-testid="work-area">Work area</div>;
}
