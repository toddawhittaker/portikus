/**
 * The diff view of a file tab: that file's changes, HEAD against the working
 * tree (SPEC.md §8.3, §12.6), or against a Git ref the student names. Staged
 * and unstaged changes are one picture, so there is no staging state to
 * choose here. The tab above owns the toggle between this view and the
 * editor.
 */
import { type GitDiff, GitRef } from "@portikus/contracts";
import { Button, CONTROL_CLASS, EmptyState, LABEL_CLASS } from "@portikus/ui";
import {
	type FormEvent,
	lazy,
	type ReactNode,
	Suspense,
	useEffect,
	useState,
} from "react";
import { errorText } from "../api/request.js";
import { DownloadFileButton } from "../files/DownloadFileButton.js";
import { DIFF_KIND, WORD } from "../files/gitStatus.js";
import { type DiffBase, useGitDiff } from "../files/useGitDiff.js";

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

/**
 * What the "Compare with" control offers. Each choice is local to this view
 * and never saved in the layout: reopening a file compares with HEAD again.
 */
type CompareChoice = "head" | "ref";

const COMPARE_LABELS: Record<CompareChoice, string> = {
	head: "Last commit",
	ref: "A Git ref…",
};

/** The note under the header; under a base it is that base, not Git HEAD. */
function statusNote(
	status: GitDiff["status"],
	base: DiffBase | undefined,
): string | null {
	if (status === "A" && base?.kind === "baseline")
		return "New since this session started";
	if (status === "A" && base?.kind === "ref") return `New file (not in ${base.ref})`;
	return STATUS_NOTE[status] ?? null;
}

function diffTitle(
	path: string,
	base: DiffBase | undefined,
	data: GitDiff | undefined,
) {
	if (base?.kind === "baseline") return `Diff since session baseline · ${path}`;
	if (base?.kind === "ref") return `Diff with ${base.ref} · ${path}`;
	if (data?.status === "R" && data.oldPath) return `Diff · ${data.oldPath} → ${path}`;
	return `Diff · ${path}`;
}

/**
 * The "Compare with" control. A ref is only asked for once it is submitted,
 * so typing does not send a request per keystroke.
 */
function CompareWith({
	path,
	onCompare,
}: {
	path: string;
	onCompare: (base: DiffBase | undefined) => void;
}) {
	const [choice, setChoice] = useState<CompareChoice>("head");
	const [draftRef, setDraftRef] = useState("");
	const [problem, setProblem] = useState<string | null>(null);

	function choose(next: CompareChoice) {
		setChoice(next);
		setProblem(null);
		if (next === "head") onCompare(undefined);
	}

	function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const typed = draftRef.trim();
		if (!GitRef.safeParse(typed).success) {
			setProblem("Type a branch, tag, or commit id.");
			return;
		}
		setProblem(null);
		onCompare({ kind: "ref", ref: typed });
	}

	const errorId = `diff-ref-${path}-err`;
	return (
		<form
			className="flex shrink-0 flex-wrap items-end gap-2 px-3 py-2"
			onSubmit={submit}
			data-testid="diff-compare"
		>
			<div className="grid gap-1">
				<label className={LABEL_CLASS} htmlFor={`diff-compare-${path}`}>
					Compare with
				</label>
				<select
					id={`diff-compare-${path}`}
					className={`${CONTROL_CLASS} w-40 cursor-pointer`}
					data-testid="diff-compare-choice"
					value={choice}
					onChange={(event) => choose(event.target.value as CompareChoice)}
				>
					{(Object.keys(COMPARE_LABELS) as CompareChoice[]).map((value) => (
						<option key={value} value={value}>
							{COMPARE_LABELS[value]}
						</option>
					))}
				</select>
			</div>
			{choice === "ref" ? (
				<>
					<div className="grid gap-1">
						<label className={LABEL_CLASS} htmlFor={`diff-ref-${path}`}>
							Branch, tag, or commit
						</label>
						<input
							id={`diff-ref-${path}`}
							className={`${CONTROL_CLASS} w-48 font-mono`}
							data-testid="diff-ref"
							value={draftRef}
							maxLength={256}
							spellCheck={false}
							autoComplete="off"
							aria-invalid={problem !== null || undefined}
							aria-describedby={problem ? errorId : undefined}
							onChange={(event) => setDraftRef(event.target.value)}
						/>
					</div>
					<Button type="submit" data-testid="diff-ref-go">
						Compare
					</Button>
				</>
			) : null}
			{problem ? (
				<p
					className="pk-error m-0 basis-full text-[12px] text-status-error"
					id={errorId}
					role="alert"
				>
					{problem}
				</p>
			) : null}
		</form>
	);
}

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
	// What the student chose to compare with; HEAD when nothing is chosen.
	const [chosen, setChosen] = useState<DiffBase | undefined>(undefined);
	const base: DiffBase | undefined = baseline
		? { kind: "baseline", object: baseline }
		: chosen;
	const diff = useGitDiff(workspaceId, projectId, path, base);
	const refBase = base?.kind === "ref" ? base.ref : null;

	// Coming back to a diff that was in the background shows what is on disk
	// now, not what it was when the tab was last looked at (SPEC.md §12.6).
	const refetch = diff.refetch;
	useEffect(() => {
		if (visible) void refetch();
	}, [visible, refetch]);

	const data = diff.data;

	function body() {
		// A failed refresh of a diff already on screen is a banner, not a
		// replacement: the last good diff is still worth reading.
		if (diff.error && !data) {
			return (
				<EmptyState icon="file" title="This diff could not be shown">
					{/* A ref the student typed can name nothing; say so out loud. */}
					<span role={refBase !== null ? "alert" : undefined} data-testid="diff-failed">
						{errorText(diff.error, "The changes could not be loaded. Try again.")}
					</span>
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
							<DownloadFileButton
								workspaceId={workspaceId}
								projectId={projectId}
								path={path}
								testId={`diff-download-${path}`}
							/>
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
						<DownloadFileButton
							workspaceId={workspaceId}
							projectId={projectId}
							path={path}
							testId={`diff-download-${path}`}
						/>
					}
				>
					{path} has more changes than the diff view can hold. Switch to Edit above to
					open it, or download it.
				</EmptyState>
			);
		}
		return (
			<>
				{/* Monaco's two columns carry no names, so say which side is which. */}
				<div className="pk-diff-sides" data-testid="diff-sides">
					<span>{baseline ? "Session start" : (refBase ?? "Last commit")}</span>
					<span>Your changes</span>
				</div>
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
			</>
		);
	}

	const status = data?.status;
	const note = status === undefined ? null : statusNote(status, base);
	// The badge comes from the same table the tree and the Changes list use,
	// so one file never wears two letters (SPEC.md §12.6).
	const kind = status === undefined ? null : DIFF_KIND[status];

	return (
		<div className="pk-doc-leaf pk-file-leaf" data-testid={`diff-pane-${path}`}>
			<div className="pk-file-header">
				<span className="pk-diff-title">
					<span className="pk-file-path">{diffTitle(path, base, data)}</span>
					{kind !== null ? (
						<span
							className="pk-diff-status"
							data-testid={`diff-status-${path}`}
							data-git={kind}
						>
							{WORD[kind]}
						</span>
					) : null}
				</span>
				{toolbar}
			</div>
			{/* Session review always compares with its baseline (SPEC.md §12.7). */}
			{baseline ? null : <CompareWith path={path} onCompare={setChosen} />}
			{diff.error && data ? (
				<div className="pk-file-banner" role="status" data-testid="diff-error">
					This diff could not be refreshed:{" "}
					{errorText(diff.error, "the workspace did not answer.")}
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
