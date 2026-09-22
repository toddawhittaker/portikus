/**
 * The diff view of a file tab: that file's changes, HEAD against the working
 * tree (SPEC.md §8.3, §12.6). Staged and unstaged changes are one picture, so
 * there is no staging state to choose here. The tab above owns the toggle
 * between this view and the editor (issue #160).
 */
import { EmptyState } from "@portikus/ui";
import { lazy, type ReactNode, Suspense, useEffect } from "react";
import { DIFF_KIND, LETTER, WORD } from "../files/gitStatus.js";
import { fileDownloadUrl } from "../files/queries.js";
import { useGitDiff } from "../files/useGitDiff.js";

// Monaco is large, so it is its own chunk and is only fetched when a diff tab
// is actually opened (STACK.md §3).
const DiffViewer = lazy(() =>
	import("../editor/DiffViewer.js").then((module) => ({ default: module.DiffViewer })),
);

/** The one line under the header that explains an unusual status. */
const STATUS_NOTE: Record<string, string> = {
	A: "New file (not in HEAD)",
	D: "Deleted from the working tree",
	U: "Unresolved merge conflict; the working-tree side shows the conflict markers",
};

export interface DiffLeafProps {
	path: string;
	workspaceId: string;
	projectId: string;
	/** False while this tab is in the background. */
	visible?: boolean;
	/** The tab's own controls, drawn in this view's header. */
	toolbar?: ReactNode;
	/** Compare with this object id instead of Git HEAD (SPEC.md §12.7). */
	baseline?: string;
}

export function DiffLeaf({
	path,
	workspaceId,
	projectId,
	visible = true,
	toolbar,
	baseline,
}: DiffLeafProps) {
	const diff = useGitDiff(workspaceId, projectId, path, baseline);

	// Coming back to a diff that was in the background shows what is on disk
	// now, not what it was when the tab was last looked at (SPEC.md §12.6).
	const refetch = diff.refetch;
	useEffect(() => {
		if (visible) void refetch();
	}, [visible, refetch]);

	const data = diff.data;
	const download = fileDownloadUrl(workspaceId, projectId, path);

	function body() {
		// A failed refresh of a diff already on screen is a banner, not a
		// replacement: the last good diff is still worth reading.
		if (diff.error && !data) {
			return (
				<EmptyState icon="file" title="This diff could not be shown">
					{diff.error.message}
				</EmptyState>
			);
		}
		if (!data) return <p className="pk-file-note">Loading…</p>;
		if (data.binary) {
			// A deleted binary has nothing left on disk to download.
			const deleted = data.status === "D";
			return (
				<EmptyState
					icon="file"
					title={deleted ? "Binary file deleted" : "Binary file changed"}
					actions={
						deleted ? undefined : (
							<a
								className="pk-file-download"
								href={download}
								data-testid={`diff-download-${path}`}
							>
								Download
							</a>
						)
					}
				>
					{deleted
						? `${path} is not text, and it was deleted from the working tree, so there is nothing to show or download.`
						: `${path} is not text, so its changes cannot be shown side by side.`}
				</EmptyState>
			);
		}
		if (data.tooLarge) {
			return (
				<EmptyState
					icon="file"
					title="This diff is too large to show here"
					actions={
						<a
							className="pk-file-download"
							href={download}
							data-testid={`diff-download-${path}`}
						>
							Download
						</a>
					}
				>
					{path} has more changes than the diff view can hold. Switch to Edit above to
					open it, or download it.
				</EmptyState>
			);
		}
		return (
			<Suspense fallback={<p className="pk-file-note">Loading diff…</p>}>
				<DiffViewer
					path={path}
					original={data.before ?? ""}
					modified={data.after ?? ""}
					// Every answer from the server is a new version, so a refresh
					// replaces the text and a re-render does not.
					version={String(diff.dataUpdatedAt)}
				/>
			</Suspense>
		);
	}

	const status = data?.status;
	const note = status === undefined ? null : (STATUS_NOTE[status] ?? null);
	// The badge comes from the same table the tree and the Changes list use,
	// so one file never wears two letters (SPEC.md §12.6).
	const kind = status === undefined ? null : DIFF_KIND[status];

	return (
		<div className="pk-doc-leaf pk-file-leaf" data-testid={`diff-pane-${path}`}>
			<div className="pk-file-header">
				<span className="pk-file-path">
					{baseline
						? `Diff since session baseline · ${path}`
						: data?.status === "R" && data.oldPath
							? `Diff · ${data.oldPath} → ${path}`
							: `Diff · ${path}`}
				</span>
				{kind !== null ? (
					<span
						className="pk-diff-status"
						data-testid={`diff-status-${path}`}
						data-git={kind}
						title={WORD[kind]}
					>
						{LETTER[kind]}
					</span>
				) : null}
				{toolbar}
			</div>
			{diff.error && data ? (
				<div className="pk-file-banner" role="status" data-testid="diff-error">
					This diff could not be refreshed: {diff.error.message}
				</div>
			) : null}
			{note !== null ? (
				<div className="pk-file-banner" role="status" data-testid="diff-note">
					{note}
				</div>
			) : null}
			{body()}
		</div>
	);
}
