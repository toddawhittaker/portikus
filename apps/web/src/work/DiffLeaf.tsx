/**
 * A diff tab's content (SPEC.md §8.3). Change review arrives in a later
 * task; this keeps the tab, the saved layout and the path visible until then.
 */
import { EmptyState } from "@portikus/ui";

export function DiffLeaf({ path }: { path: string }) {
	return (
		<div className="pk-doc-leaf" data-testid={`diff-pane-${path}`}>
			<EmptyState icon="file" title={path}>
				Editor arrives in a later task.
			</EmptyState>
		</div>
	);
}
