/**
 * A file tab's content (SPEC.md §8.3). The editor itself arrives in a later
 * task; this keeps the tab, the saved layout and the path visible until then.
 */
import { EmptyState } from "@portikus/ui";

export function FileLeaf({ path }: { path: string }) {
	return (
		<div className="pk-doc-leaf" data-testid={`file-pane-${path}`}>
			<EmptyState icon="file" title={path}>
				Editor arrives in a later task.
			</EmptyState>
		</div>
	);
}
