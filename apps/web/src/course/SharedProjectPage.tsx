import { Checkbox, EmptyState } from "@portikus/ui";
import { Link, useParams } from "@tanstack/react-router";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import { decorations } from "../files/gitStatus.js";
import { usePageTitle } from "../pageTitle.js";
import { CourseFrame } from "./CourseFrame.js";
import {
	SHARE_POLL_MS,
	type ShareRef,
	shareProblem,
	useCourseShares,
	useSharedChecks,
	useSharedGitStatus,
	useSharedTree,
} from "./shared/queries.js";
import { SharedChangesList, SharedDiffView } from "./shared/SharedChanges.js";
import { SharedChecks } from "./shared/SharedChecks.js";
import { SharedFileView } from "./shared/SharedFileView.js";
import { SharedTree } from "./shared/SharedTree.js";
import { dateTimeText } from "./time.js";

/** What the right side shows: a file, or one file's changes. */
type Shown = { kind: "file" | "diff"; path: string } | null;

/** What the reader chose to look at, kept while a stopped workspace hides the body. */
interface ViewState {
	expanded: ReadonlySet<string>;
	onToggle: (dir: string) => void;
	showHidden: boolean;
	setShowHidden: (show: boolean) => void;
	shown: Shown;
	setShown: (shown: Shown) => void;
}

const NOTICE_TITLE = {
	stopped: "The workspace is stopped",
	gone: "This share is not available",
} as const;

/**
 * `/course/:courseId/shares/:projectId`: an instructor's read-only view of a
 * project a student shared (SPEC.md §5.2, ADR 0057). Files, Git changes and
 * check results, asked for again every 10 seconds. Nothing here writes,
 * downloads, or reaches a terminal or preview.
 */
export function SharedProjectPage() {
	return (
		<CourseFrame testId="page-shared-project" labelledBy="shared-title">
			<SharedProject />
		</CourseFrame>
	);
}

function SharedProject() {
	const { courseId, projectId } = useParams({
		from: "/course/$courseId/shares/$projectId",
	});
	const share: ShareRef = { courseId, projectId };
	const shares = useCourseShares(courseId);
	const listed = shares.data?.shares.find((item) => item.projectId === projectId);
	// The root listing is the gate: it says whether the share is open and the
	// workspace running, and keeps asking, so the view returns when it starts.
	const root = useSharedTree(share, "");
	const problem =
		shareProblem(root.error) ??
		shareProblem(shares.error) ??
		(shares.data && !listed ? "gone" : null);
	usePageTitle(listed ? `${listed.projectName}, shared` : "Shared project");

	// Lifted here so the open folders and file come back with the workspace.
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
	const [showHidden, setShowHidden] = useState(false);
	const [shown, setShown] = useState<Shown>(null);
	const view: ViewState = {
		expanded,
		onToggle: (dir) =>
			setExpanded((old) => {
				const next = new Set(old);
				if (next.has(dir)) next.delete(dir);
				else next.add(dir);
				return next;
			}),
		showHidden,
		setShowHidden,
		shown,
		setShown,
	};

	// When a poll swaps the body out from under the reader's focus, the
	// focus would fall to the page; the heading keeps their place instead.
	const heading = useRef<HTMLHeadingElement>(null);
	const content = useRef<HTMLDivElement>(null);
	const focusInside = useRef(false);
	const lastProblem = useRef(problem);
	useEffect(() => {
		const element = content.current;
		if (!element) return;
		const onFocusIn = () => {
			focusInside.current = true;
		};
		const onFocusOut = (event: FocusEvent) => {
			// A focusout with no new target may be the body being removed.
			const next = event.relatedTarget;
			if (next instanceof Node && !element.contains(next)) focusInside.current = false;
		};
		element.addEventListener("focusin", onFocusIn);
		element.addEventListener("focusout", onFocusOut);
		return () => {
			element.removeEventListener("focusin", onFocusIn);
			element.removeEventListener("focusout", onFocusOut);
		};
	}, []);
	useLayoutEffect(() => {
		if (lastProblem.current === problem) return;
		lastProblem.current = problem;
		const active = document.activeElement;
		const dropped = active === null || active === document.body;
		if (focusInside.current && dropped) heading.current?.focus();
		focusInside.current = false;
	}, [problem]);

	return (
		<>
			<Link
				to="/course/$courseId"
				params={{ courseId }}
				className="pk-focus-ring rounded-sm text-[13px] text-accent-text"
			>
				Back to the course
			</Link>
			<h1 className="pk-text-title mt-2" id="shared-title" ref={heading} tabIndex={-1}>
				{listed?.projectName ?? "Shared project"}
			</h1>
			{/* Always mounted, so a change of state is announced. */}
			<p className="pk-visually-hidden" role="status" data-testid="shared-status">
				{problem ? NOTICE_TITLE[problem] : ""}
			</p>
			{listed ? (
				<p className="pk-muted mt-1 text-[13px]" data-testid="shared-byline">
					Shared by {listed.displayName} until {dateTimeText(listed.endsAt)}. Read only;
					it refreshes every {SHARE_POLL_MS / 1000} seconds.
				</p>
			) : null}
			<div ref={content}>
				{problem === "stopped" ? (
					<Notice title={NOTICE_TITLE.stopped} testId="shared-stopped">
						The student's workspace is not running, so its files cannot be read. This
						page shows them again once the student starts it.
					</Notice>
				) : problem === "gone" ? (
					<Notice title={NOTICE_TITLE.gone} testId="shared-gone">
						The student stopped sharing this project, the share ended after its time ran
						out, or it was never shared with you.
					</Notice>
				) : (
					<SharedBody
						share={share}
						name={listed?.projectName ?? "the project"}
						view={view}
					/>
				)}
			</div>
		</>
	);
}

function Notice({
	title,
	testId,
	children,
}: {
	title: string;
	testId: string;
	children: ReactNode;
}) {
	return (
		<div className="mt-6" data-testid={testId}>
			<EmptyState icon="alert" title={title}>
				{children}
			</EmptyState>
		</div>
	);
}

function SharedBody({
	share,
	name,
	view,
}: {
	share: ShareRef;
	name: string;
	view: ViewState;
}) {
	const git = useSharedGitStatus(share);
	const checks = useSharedChecks(share);
	const { expanded, showHidden, setShowHidden, shown, setShown } = view;

	return (
		<div className="mt-6 grid gap-6 lg:grid-cols-[minmax(16rem,22rem)_minmax(0,1fr)]">
			<div className="flex min-w-0 flex-col gap-6">
				<section aria-labelledby="shared-files-title">
					<h2 className="pk-text-heading mb-2" id="shared-files-title">
						Files
					</h2>
					<Checkbox
						label="Show hidden and generated files"
						checked={showHidden}
						onChange={(event) => setShowHidden(event.target.checked)}
						className="mb-2 text-[13px]"
					/>
					<SharedTree
						share={share}
						git={decorations(git.data)}
						showHidden={showHidden}
						expanded={expanded}
						onToggle={view.onToggle}
						current={shown?.kind === "file" ? shown.path : null}
						onOpen={(path) => setShown({ kind: "file", path })}
						label={`Files in ${name}`}
					/>
				</section>
				<section aria-labelledby="shared-changes-title">
					<h2 className="pk-text-heading mb-2" id="shared-changes-title">
						Changes
					</h2>
					<SharedChangesList
						status={git.data}
						error={git.isError}
						current={shown?.kind === "diff" ? shown.path : null}
						onOpen={(path) => setShown({ kind: "diff", path })}
					/>
				</section>
				<section aria-labelledby="shared-checks-title">
					<h2 className="pk-text-heading mb-2" id="shared-checks-title">
						Checks
					</h2>
					<SharedChecks checks={checks.data} error={checks.isError} />
				</section>
			</div>
			<section
				className="flex h-[75vh] min-h-80 min-w-0 flex-col overflow-hidden rounded-md border border-line bg-surface"
				aria-labelledby="shared-view-title"
				data-testid="shared-view"
			>
				<h2
					className="pk-text-heading truncate border-b border-line px-3 py-2"
					id="shared-view-title"
				>
					{shown === null
						? "Nothing open"
						: shown.kind === "diff"
							? `Changes in ${shown.path}`
							: shown.path}
				</h2>
				{shown === null ? (
					<p className="pk-file-note">
						Choose a file to read it, or a change to see what differs from the last
						commit.
					</p>
				) : shown.kind === "file" ? (
					<SharedFileView key={shown.path} share={share} path={shown.path} />
				) : (
					<SharedDiffView key={shown.path} share={share} path={shown.path} />
				)}
			</section>
		</div>
	);
}
