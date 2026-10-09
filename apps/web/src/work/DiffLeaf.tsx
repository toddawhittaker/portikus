/**
 * The diff view of a file tab: that file's changes, HEAD against the working
 * tree (SPEC.md §8.3, §12.6), or against a Git ref the student names or a
 * recovery point the student picks (SPEC.md §15.8). Staged
 * and unstaged changes are one picture, so there is no staging state to
 * choose here. The tab above owns the toggle between this view and the
 * editor.
 */
import { type GitDiff, GitRef, type RecoveryPoint } from "@portikus/contracts";
import { Button, CONTROL_CLASS, EmptyState, LABEL_CLASS } from "@portikus/ui";
import {
	type FormEvent,
	lazy,
	type ReactNode,
	Suspense,
	useEffect,
	useId,
	useState,
} from "react";
import { errorText } from "../api/request.js";
import { DownloadFileButton } from "../files/DownloadFileButton.js";
import { DIFF_KIND, WORD } from "../files/gitStatus.js";
import { displayName } from "../files/paths.js";
import { type DiffBase, useGitDiff } from "../files/useGitDiff.js";
import { pointTime, REASON_LABEL } from "../recovery/labels.js";
import { useRecoveryPoints } from "../recovery/queries.js";

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
type CompareChoice = "head" | "ref" | "point";

const COMPARE_LABELS: Record<CompareChoice, string> = {
	head: "Last commit",
	ref: "A Git ref…",
	point: "A recovery point…",
};

/** The note under the header; under a base it is that base, not Git HEAD. */
function statusNote(
	status: GitDiff["status"],
	base: DiffBase | undefined,
): string | null {
	if (status === "A" && base?.kind === "baseline")
		return "New since this session started";
	if (status === "A" && base?.kind === "ref") return `New file (not in ${base.ref})`;
	if (status === "A" && base?.kind === "point")
		return "New file (not in this recovery point)";
	return STATUS_NOTE[status] ?? null;
}

function diffTitle(
	path: string,
	base: DiffBase | undefined,
	data: GitDiff | undefined,
) {
	const shown = displayName(path);
	if (base?.kind === "baseline") return `Diff since session baseline · ${shown}`;
	if (base?.kind === "ref") return `Diff with ${base.ref} · ${shown}`;
	if (base?.kind === "point")
		return `Diff with recovery point ${base.label} · ${shown}`;
	if (data?.status === "R" && data.oldPath)
		return `Diff · ${displayName(data.oldPath)} → ${shown}`;
	return `Diff · ${shown}`;
}

/** A point as the picker and the diff header name it: time and trigger. */
function pointLabel(point: RecoveryPoint): string {
	return `${pointTime(point.createdAt)}, ${REASON_LABEL[point.reason]}`;
}

/** The wait or the empty list, said in the compare control's one live region. */
const POINTS_LOADING = "Loading recovery points…";
const POINTS_NONE = "This project has no recovery points yet.";
const POINT_READING =
	"Reading this file from the recovery point. This can take up to a minute…";

/**
 * The project's recovery points, newest first, and a Compare button.
 * Arrowing through the list does not start a slow archive read per point:
 * only Compare does. The control above loads the list and says when it is
 * loading or empty.
 */
function PointPicker({
	points,
	onCompare,
}: {
	points: RecoveryPoint[];
	onCompare: (base: DiffBase) => void;
}) {
	const id = useId();
	const [picked, setPicked] = useState("");
	const point = points.find((p) => p.id === picked) ?? points[0];
	if (!point) return null;
	return (
		<>
			<div className="grid gap-1">
				<label className={LABEL_CLASS} htmlFor={id}>
					Recovery point
				</label>
				<select
					id={id}
					className={`${CONTROL_CLASS} w-72 cursor-pointer`}
					data-testid="diff-point"
					value={point.id}
					onChange={(event) => setPicked(event.target.value)}
				>
					{points.map((each) => (
						<option key={each.id} value={each.id}>
							{pointLabel(each)}
						</option>
					))}
				</select>
			</div>
			<Button
				type="button"
				data-testid="diff-point-go"
				onClick={() =>
					onCompare({ kind: "point", pointId: point.id, label: pointLabel(point) })
				}
			>
				Compare
			</Button>
		</>
	);
}

/**
 * The "Compare with" control. A ref is only asked for once it is submitted,
 * so typing does not send a request per keystroke. The points list loads only
 * once that choice is made.
 */
function CompareWith({
	workspaceId,
	projectId,
	reading,
	onCompare,
}: {
	workspaceId: string;
	projectId: string;
	/** A recovery point's file is being read. */
	reading: boolean;
	onCompare: (base: DiffBase | undefined) => void;
}) {
	const [choice, setChoice] = useState<CompareChoice>("head");
	const [draftRef, setDraftRef] = useState("");
	const [problem, setProblem] = useState<string | null>(null);
	const list = useRecoveryPoints(workspaceId, projectId, choice === "point");
	const id = useId();

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

	let wait = "";
	if (reading) wait = POINT_READING;
	else if (choice === "point" && !list.error) {
		if (!list.data) wait = POINTS_LOADING;
		else if (list.data.points.length === 0) wait = POINTS_NONE;
	}

	const errorId = `${id}-ref-err`;
	return (
		<form
			className="flex shrink-0 flex-wrap items-end gap-2 px-3 py-2"
			onSubmit={submit}
			data-testid="diff-compare"
		>
			<div className="grid gap-1">
				<label className={LABEL_CLASS} htmlFor={`${id}-choice`}>
					Compare with
				</label>
				<select
					id={`${id}-choice`}
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
						<label className={LABEL_CLASS} htmlFor={`${id}-ref`}>
							Branch, tag, or commit
						</label>
						<input
							id={`${id}-ref`}
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
			{choice === "point" && list.data ? (
				<PointPicker points={list.data.points} onCompare={onCompare} />
			) : null}
			{choice === "point" && list.error ? (
				<p
					className="pk-error m-0 basis-full text-[12px] text-status-error"
					role="alert"
				>
					{errorText(list.error, "The recovery points could not be loaded.")}
				</p>
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
			{/* Always mounted, so each change of text is announced, not missed. */}
			<p
				className={
					wait ? "m-0 basis-full text-[13px] text-ink-muted" : "pk-visually-hidden"
				}
				role="status"
				aria-live="polite"
				data-testid="diff-compare-status"
			>
				{wait}
			</p>
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
	const pointBase = base?.kind === "point" ? base.label : null;
	const reading = pointBase !== null && diff.isFetching;

	// Coming back to a diff that was in the background shows what is on disk
	// now, not what it was when the tab was last looked at (SPEC.md §12.6). A
	// recovery point is read again only by Compare (SPEC.md §15.8).
	const refetch = diff.refetch;
	const isPoint = pointBase !== null;
	useEffect(() => {
		if (visible && !isPoint) void refetch();
	}, [visible, refetch, isPoint]);

	/** Compare on the point already shown reads it again; the key alone would not. */
	function compare(next: DiffBase | undefined) {
		if (
			next?.kind === "point" &&
			chosen?.kind === "point" &&
			next.pointId === chosen.pointId
		) {
			void refetch();
		}
		setChosen(next);
	}

	const data = diff.data;

	function body() {
		// A failed refresh of a diff already on screen is a banner, not a
		// replacement: the last good diff is still worth reading.
		// A point read again after a failure says only that it is reading.
		if (diff.error && !data && !reading) {
			return (
				<EmptyState icon="file" title="This diff could not be shown">
					{/* A ref the student typed can name nothing; say so out loud. */}
					<span
						role={refBase !== null || pointBase !== null ? "alert" : undefined}
						data-testid="diff-failed"
					>
						{errorText(diff.error, "The changes could not be loaded. Try again.")}
					</span>
				</EmptyState>
			);
		}
		if (!data) {
			// The compare control's live region explains a point's long read.
			if (pointBase !== null) return null;
			return <p className="pk-file-note">Loading…</p>;
		}
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
						? `${displayName(path)} is not text, and it was deleted from the working tree, so there is nothing to show or download.`
						: `${displayName(path)} is not text, so its changes cannot be shown side by side.`}
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
					{displayName(path)} has more changes than the diff view can hold. Switch to
					Edit above to open it, or download it.
				</EmptyState>
			);
		}
		return (
			<>
				{/* Monaco's two columns carry no names, so say which side is which. */}
				<div className="pk-diff-sides" data-testid="diff-sides">
					<span>
						{baseline ? "Session start" : (refBase ?? pointBase ?? "Last commit")}
					</span>
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
			{baseline ? null : (
				<CompareWith
					workspaceId={workspaceId}
					projectId={projectId}
					reading={reading}
					onCompare={compare}
				/>
			)}
			{diff.error && data ? (
				// A point's failure, such as another read already running, is
				// something the student asked for and must hear.
				<div
					className="pk-file-banner"
					role={pointBase !== null ? "alert" : "status"}
					data-testid="diff-error"
				>
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
