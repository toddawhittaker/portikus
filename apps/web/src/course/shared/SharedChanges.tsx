/**
 * The shared project's Git changes (SPEC.md §12.6): a list of changed paths,
 * and one file's diff against the last commit. Read only, with no other base
 * to compare against (ADR 0057).
 */
import type { GitStatus } from "@portikus/contracts";
import { EmptyState, Icon } from "@portikus/ui";
import { lazy, Suspense } from "react";
import { errorText } from "../../api/request.js";
import { changeRows, DIFF_KIND, WORD } from "../../files/gitStatus.js";
import { displayName } from "../../files/paths.js";
import "../../files/files.css";
import "../../work/work.css";
import { type ShareRef, useSharedGitDiff } from "./queries.js";

const DiffViewer = lazy(() =>
	import("../../editor/DiffViewer.js").then((module) => ({
		default: module.DiffViewer,
	})),
);

export function SharedChangesList({
	status,
	error,
	current,
	onOpen,
}: {
	status: GitStatus | undefined;
	error: boolean;
	/** The path whose diff is on show, if any. */
	current: string | null;
	onOpen: (path: string) => void;
}) {
	if (!status) {
		return (
			<p className="pk-changes-empty">
				{error ? "Could not read Git status." : "Loading…"}
			</p>
		);
	}
	if (!status.repo) {
		return <p className="pk-changes-empty">This project is not a Git repository.</p>;
	}
	const rows = changeRows(status);
	if (rows.length === 0) {
		return (
			<p className="pk-changes-empty" data-testid="shared-changes-empty">
				No changes since the last commit.
			</p>
		);
	}
	return (
		<ul
			className="pk-changes-list"
			aria-label="Changed files"
			data-testid="shared-changes"
		>
			{rows.map((row) => {
				const isCurrent = current === row.path;
				return (
					<li key={row.path}>
						<button
							type="button"
							className={`pk-changes-row${isCurrent ? " is-current" : ""}`}
							aria-current={isCurrent ? "true" : undefined}
							data-testid={`shared-change-${row.path}`}
							data-git={row.decoration.kind}
							title={row.decoration.title}
							onClick={() => onOpen(row.path)}
						>
							<span className="pk-git-letter" aria-hidden="true">
								{row.decoration.letter}
							</span>
							{row.decoration.kind === "conflict" ? (
								<Icon name="alert" size="sm" />
							) : null}
							<span className="pk-changes-path">{row.label}</span>
							<span className="pk-visually-hidden">, {row.decoration.title}</span>
						</button>
					</li>
				);
			})}
		</ul>
	);
}

/** One file's diff, HEAD against the working tree. */
export function SharedDiffView({ share, path }: { share: ShareRef; path: string }) {
	const diff = useSharedGitDiff(share, path);
	const data = diff.data;
	const name = displayName(path);
	if (!data) {
		if (diff.error) {
			return (
				<EmptyState icon="file" title="This diff could not be shown">
					<span data-testid="shared-diff-error">
						{errorText(
							diff.error,
							"The workspace did not answer. It is asked again shortly.",
						)}
					</span>
				</EmptyState>
			);
		}
		return <p className="pk-file-note">Loading…</p>;
	}
	const kind = DIFF_KIND[data.status];
	return (
		<>
			<p className="pk-file-note" data-testid="shared-diff-status">
				<span className="pk-diff-status" data-git={kind}>
					{WORD[kind]}
				</span>
				{data.status === "R" && data.oldPath
					? ` Renamed from ${displayName(data.oldPath)}`
					: null}
			</p>
			{data.binary ? (
				<EmptyState icon="file" title="Binary file changed">
					{name} is not text, so its changes cannot be shown side by side.
				</EmptyState>
			) : data.tooLarge ? (
				<EmptyState icon="file" title="This diff is too large to show here">
					{name} has more changes than the diff view can hold.
				</EmptyState>
			) : (
				<>
					{/* Monaco's two columns carry no names, so say which side is which. */}
					<div className="pk-diff-sides" data-testid="shared-diff-sides">
						<span>Last commit</span>
						<span>Working copy</span>
					</div>
					<Suspense fallback={<p className="pk-file-note">Loading diff…</p>}>
						<DiffViewer
							path={path}
							original={data.before ?? ""}
							modified={data.after ?? ""}
							version={String(diff.dataUpdatedAt)}
							testId={`shared-diff-${path}`}
						/>
					</Suspense>
				</>
			)}
		</>
	);
}
