/**
 * The diff view of a file tab: that file's changes, HEAD against the working
 * tree (SPEC.md §8.3, §12.6), or against a Git ref the student names or a
 * recovery point the student picks (SPEC.md §15.8). Staged
 * and unstaged changes are one picture, so there is no staging state to
 * choose here. The tab above owns the toggle between this view and the
 * editor.
 */
import { type GitDiff, GitRef, type RecoveryPoint } from "@portikus/contracts";
import {
	Button,
	CONTROL_CLASS,
	Dialog,
	DialogRoot,
	EmptyState,
	FIELD_CLASS,
	Icon,
	LABEL_CLASS,
	Menu,
	MenuItem,
	MenuRoot,
	MenuTrigger,
} from "@portikus/ui";
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
import { FileHeader } from "./FilePane.js";

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

/** The note under the header; under a base it is that base, not Git HEAD. */
function statusNote(data: GitDiff, base: DiffBase | undefined): string | null {
	const { status } = data;
	if (status === "A" && base?.kind === "baseline")
		return "New since this session started";
	if (status === "A" && base?.kind === "ref") return `New file (not in ${base.ref})`;
	if (status === "A" && base?.kind === "point")
		return "New file (not in this recovery point)";
	if (status === "R" && data.oldPath)
		return `Renamed from ${displayName(data.oldPath)}`;
	return STATUS_NOTE[status] ?? null;
}

/** A point as the picker and the diff's left side name it: time and trigger. */
function pointLabel(point: RecoveryPoint): string {
	return `${pointTime(point.createdAt)}, ${REASON_LABEL[point.reason]}`;
}

const POINTS_LOADING = "Loading recovery points…";
const POINTS_NONE = "This project has no recovery points yet.";
const POINT_READING =
	"Reading this file from the recovery point. This can take up to a minute…";

/**
 * Asks for a branch, tag or commit. The ref is only sent once it is
 * submitted, so typing does not send a request per keystroke.
 */
function RefDialog({
	initial,
	onCompare,
	onClose,
}: {
	initial: string;
	onCompare: (base: DiffBase) => void;
	onClose: () => void;
}) {
	const id = useId();
	const [draft, setDraft] = useState(initial);
	const [problem, setProblem] = useState<string | null>(null);

	function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		const typed = draft.trim();
		if (!GitRef.safeParse(typed).success) {
			setProblem("Type a branch, tag, or commit id.");
			return;
		}
		onCompare({ kind: "ref", ref: typed });
		onClose();
	}

	const errorId = `${id}-ref-err`;
	return (
		<DialogRoot open={true} onOpenChange={(open) => !open && onClose()}>
			<Dialog
				testId="diff-ref-dialog"
				title="Compare with a Git ref"
				description="The left side shows this file as it is at that branch, tag, or commit."
				footer={
					<>
						<Button variant="secondary" onClick={onClose}>
							Cancel
						</Button>
						<Button
							variant="primary"
							type="submit"
							form={`${id}-form`}
							data-testid="diff-ref-go"
						>
							Compare
						</Button>
					</>
				}
			>
				<form id={`${id}-form`} className={FIELD_CLASS} onSubmit={submit}>
					<label className={LABEL_CLASS} htmlFor={`${id}-ref`}>
						Branch, tag, or commit
					</label>
					<input
						id={`${id}-ref`}
						className={`${CONTROL_CLASS} font-mono`}
						data-testid="diff-ref"
						value={draft}
						maxLength={256}
						spellCheck={false}
						autoComplete="off"
						autoFocus={true}
						aria-invalid={problem !== null || undefined}
						aria-describedby={problem ? errorId : undefined}
						onChange={(event) => setDraft(event.target.value)}
					/>
					{problem ? (
						<p
							className="pk-error m-0 text-[12px] text-status-error"
							id={errorId}
							role="alert"
						>
							{problem}
						</p>
					) : null}
				</form>
			</Dialog>
		</DialogRoot>
	);
}

/**
 * The project's recovery points, newest first, and a Compare button. The
 * list loads only once this opens, and arrowing through it does not start
 * a slow archive read per point: only Compare does.
 */
function PointDialog({
	workspaceId,
	projectId,
	initial,
	onCompare,
	onClose,
}: {
	workspaceId: string;
	projectId: string;
	/** The point compared with now, picked again when the dialog opens. */
	initial: string | null;
	onCompare: (base: DiffBase) => void;
	onClose: () => void;
}) {
	const id = useId();
	const list = useRecoveryPoints(workspaceId, projectId, true);
	const points = list.data?.points ?? [];
	const [picked, setPicked] = useState(initial ?? "");
	const point = points.find((each) => each.id === picked) ?? points[0];

	let wait = "";
	if (!list.error) {
		if (!list.data) wait = POINTS_LOADING;
		else if (points.length === 0) wait = POINTS_NONE;
	}

	function submit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!point) return;
		onCompare({ kind: "point", pointId: point.id, label: pointLabel(point) });
		onClose();
	}

	return (
		<DialogRoot open={true} onOpenChange={(open) => !open && onClose()}>
			<Dialog
				testId="diff-point-dialog"
				title="Compare with a recovery point"
				description="Reading a file from a recovery point can take up to a minute."
				footer={
					<>
						<Button variant="secondary" onClick={onClose}>
							Cancel
						</Button>
						{point ? (
							<Button
								variant="primary"
								type="submit"
								form={`${id}-form`}
								data-testid="diff-point-go"
							>
								Compare
							</Button>
						) : null}
					</>
				}
			>
				<form id={`${id}-form`} className="grid gap-2" onSubmit={submit}>
					{point ? (
						<div className={FIELD_CLASS}>
							<label className={LABEL_CLASS} htmlFor={`${id}-point`}>
								Recovery point
							</label>
							<select
								id={`${id}-point`}
								className={`${CONTROL_CLASS} cursor-pointer`}
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
					) : null}
					{list.error ? (
						<p className="pk-error m-0 text-[12px] text-status-error" role="alert">
							{errorText(list.error, "The recovery points could not be loaded.")}
						</p>
					) : null}
					{/* The page behind a dialog is hidden from screen readers, so the
					    list's wait has its own region here, mounted with the dialog. */}
					<p
						className={wait ? "m-0 text-ink-muted" : "pk-visually-hidden"}
						role="status"
						aria-live="polite"
						data-testid="diff-point-status"
					>
						{wait}
					</p>
				</form>
			</Dialog>
		</DialogRoot>
	);
}

/**
 * The "Compare with" control: a small button in the diff's header that
 * opens a menu of what to compare with. The choice is local to this view and
 * never saved in the layout: reopening a file compares with HEAD again.
 */
function CompareWith({
	workspaceId,
	projectId,
	base,
	onCompare,
}: {
	workspaceId: string;
	projectId: string;
	/** What the diff compares with now; the last commit when undefined. */
	base: DiffBase | undefined;
	onCompare: (base: DiffBase | undefined) => void;
}) {
	const [asking, setAsking] = useState<"ref" | "point" | null>(null);
	const close = () => setAsking(null);
	return (
		<>
			<MenuRoot>
				<MenuTrigger asChild={true}>
					<button type="button" className="pk-diff-compare" data-testid="diff-compare">
						Compare with
						<Icon name="chevron-down" size="sm" />
					</button>
				</MenuTrigger>
				<Menu label="Compare with">
					<MenuItem testId="diff-compare-head" onSelect={() => onCompare(undefined)}>
						Last commit
					</MenuItem>
					<MenuItem testId="diff-compare-ref" onSelect={() => setAsking("ref")}>
						A Git ref…
					</MenuItem>
					<MenuItem testId="diff-compare-point" onSelect={() => setAsking("point")}>
						A recovery point…
					</MenuItem>
				</Menu>
			</MenuRoot>
			{asking === "ref" ? (
				<RefDialog
					initial={base?.kind === "ref" ? base.ref : ""}
					onCompare={onCompare}
					onClose={close}
				/>
			) : null}
			{asking === "point" ? (
				<PointDialog
					workspaceId={workspaceId}
					projectId={projectId}
					initial={base?.kind === "point" ? base.pointId : null}
					onCompare={onCompare}
					onClose={close}
				/>
			) : null}
		</>
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
			// The status line above explains a point's long read.
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

	const note = data === undefined ? null : statusNote(data, base);
	// The badge comes from the same table the tree and the Changes list use,
	// so one file never wears two letters (SPEC.md §12.6).
	const kind = data === undefined ? null : DIFF_KIND[data.status];

	return (
		<div className="pk-doc-leaf pk-file-leaf" data-testid={`diff-pane-${path}`}>
			<FileHeader path={path}>
				{kind !== null ? (
					<span
						className="pk-diff-status"
						data-testid={`diff-status-${path}`}
						data-git={kind}
					>
						{WORD[kind]}
					</span>
				) : null}
				{/* Session review always compares with its baseline (SPEC.md §12.7). */}
				{baseline ? null : (
					<CompareWith
						workspaceId={workspaceId}
						projectId={projectId}
						base={chosen}
						onCompare={compare}
					/>
				)}
				{toolbar}
			</FileHeader>
			{/* Always mounted, so each change of text is announced, not missed. */}
			<p
				className={reading ? "pk-file-banner" : "pk-visually-hidden"}
				role="status"
				aria-live="polite"
				data-testid="diff-compare-status"
			>
				{reading ? POINT_READING : ""}
			</p>
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
