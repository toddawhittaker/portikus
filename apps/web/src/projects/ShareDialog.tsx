import type { Project } from "@portikus/contracts";
import { SHARE_DURATION_HOURS } from "@portikus/contracts";
import { Button, Dialog, DialogRoot, Skeleton } from "@portikus/ui";
import { useEffect, useState } from "react";
import { DialogError } from "../common/DialogError.js";
import { timeAgo, timeLeft } from "../text.js";
import { useChangeProjectShare, useProjectShare } from "./queries.js";

/** True while the share is open: the server drops an ended one at the next read. */
export function isOpenShare(endsAt: string | undefined, now: number): boolean {
	return endsAt !== undefined && Date.parse(endsAt) > now;
}

/**
 * Share one project, read-only, with the instructors of the student's courses
 * (SPEC.md §5.2). The dialog says who sees what and for how long before
 * anything starts, and lists who has looked while it runs.
 */
export function ShareDialog({
	workspaceId,
	project,
	onClose,
}: {
	workspaceId: string;
	project: Project;
	onClose: () => void;
}) {
	const status = useProjectShare(workspaceId, project.id, { poll: true });
	const change = useChangeProjectShare(workspaceId, project.id);
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 30_000);
		return () => clearInterval(timer);
	}, []);

	const share = status.data?.share ?? null;
	const sharing = isOpenShare(share?.endsAt, now);
	const viewers = status.data?.viewers ?? [];

	return (
		<DialogRoot open onOpenChange={(open) => !open && onClose()}>
			<Dialog
				testId="dialog-share-project"
				title={`Share ${project.name} with my instructors`}
				description="Instructors can look at this project, read-only, only while you share it."
				onClose={onClose}
				footer={
					<>
						<Button variant="secondary" onClick={onClose}>
							Close
						</Button>
						{status.data &&
							(sharing ? (
								<Button
									data-testid="share-stop"
									variant="secondary"
									loading={change.isPending}
									disabled={change.isPending}
									onClick={() => change.mutate("stop")}
								>
									Stop sharing
								</Button>
							) : (
								<Button
									data-testid="share-start"
									variant="primary"
									loading={change.isPending}
									disabled={change.isPending}
									onClick={() => change.mutate("start")}
								>
									Start sharing
								</Button>
							))}
					</>
				}
			>
				{status.isPending ? (
					<Skeleton />
				) : status.isError ? (
					<DialogError error={status.error} />
				) : (
					<>
						<dl className="pk-dl" data-testid="share-terms">
							<dt>Who can see it</dt>
							<dd>The instructors of the courses you belong to.</dd>
							<dt>What they see</dt>
							<dd>
								The project's files, its Git status and changes, and the latest check
								results.
							</dd>
							<dt>Never</dt>
							<dd>
								Your terminals, previews, or secret files such as{" "}
								<code className="pk-mono-small">.env</code>.
							</dd>
							<dt>How long</dt>
							<dd data-testid="share-time">
								{sharing && share
									? `${timeLeft(share.endsAt, now)}. It ends by itself after ${SHARE_DURATION_HOURS} hours, or when you stop it.`
									: `${SHARE_DURATION_HOURS} hours, or until you stop it.`}
							</dd>
						</dl>
						{sharing ? (
							<section aria-labelledby="share-viewers-heading" className="mt-4">
								<h3 id="share-viewers-heading" className="pk-text-label m-0">
									Who has looked
								</h3>
								{viewers.length === 0 ? (
									<p className="pk-list-meta mt-1" data-testid="share-no-viewers">
										No instructor has looked yet. You get a notification when one does.
									</p>
								) : (
									<ul className="m-0 mt-1 pl-0 list-none" data-testid="share-viewers">
										{viewers.map((viewer) => (
											<li key={`${viewer.displayName}-${viewer.firstViewedAt}`}>
												{viewer.displayName}, last looked{" "}
												{timeAgo(viewer.lastViewedAt, now).toLowerCase()}
											</li>
										))}
									</ul>
								)}
							</section>
						) : null}
						<DialogError error={change.error} />
					</>
				)}
			</Dialog>
		</DialogRoot>
	);
}
