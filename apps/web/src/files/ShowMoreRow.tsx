/**
 * The last row of a directory past the page size (SPEC.md §11.2). It is a
 * treeitem like the rows above it, so the arrow keys reach it and Enter or
 * Space loads the next page, as in VS Code's explorer (SPEC.md §25.8).
 */
import { MAX_TREE_ENTRIES } from "@portikus/contracts";
import { entryCount } from "./paths.js";

export function ShowMoreRow({
	path,
	level,
	shown,
	focused,
	loading,
	onFocus,
	onActivate,
}: {
	path: string;
	level: number;
	/** How many entries of this directory are on screen. */
	shown: number;
	focused: boolean;
	loading: boolean;
	onFocus: () => void;
	onActivate: () => void;
}) {
	return (
		// biome-ignore lint/a11y/useKeyWithClickEvents: the tree handles keys for every row
		<div
			role="treeitem"
			aria-level={level}
			aria-selected={false}
			// Stays focusable while loading, so the focus is not dropped.
			aria-disabled={loading ? true : undefined}
			tabIndex={focused ? 0 : -1}
			data-path={path}
			data-kind="more"
			data-testid="file-tree-show-more"
			className="pk-tree-item pk-tree-more"
			style={{ paddingLeft: `${level * 16 - 8}px` }}
			onFocus={onFocus}
			onClick={() => {
				if (!loading) onActivate();
			}}
		>
			<span className="pk-tree-more-label">Show {MAX_TREE_ENTRIES} more…</span>{" "}
			<span data-testid="file-tree-truncated">({entryCount(shown)} shown)</span>
		</div>
	);
}
