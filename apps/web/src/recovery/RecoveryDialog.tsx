import type { Project, RecoveryPoint, RecoveryReason } from "@portikus/contracts";
import { Button, Dialog, DialogRoot } from "@portikus/ui";
import { useState } from "react";
import { formatBytes } from "../monitor/format.js";
import { DialogError } from "../projects/DialogError.js";
import { useCreateRecoveryPoint, useRecoveryPoints } from "./queries.js";
import { pointTime, RestoreConfirm } from "./RestoreConfirm.js";

export const REASON_LABEL: Record<RecoveryReason, string> = {
	periodic: "Every 15 minutes",
	manual: "Made by you",
	"before-archive": "Before archive",
	"before-restore": "Before restore",
	"before-rebuild": "Before rebuild",
	"agent-session": "Before Claude Code or Codex session",
};

/**
 * The project's recovery points (SPEC.md §15): when, why and how big each
 * one is, how much of the allowance is used, and a way to make or restore one.
 */
export function RecoveryDialog({
	workspaceId,
	project,
	onClose,
}: {
	workspaceId: string;
	project: Project;
	onClose: () => void;
}) {
	const list = useRecoveryPoints(workspaceId, project.id);
	const create = useCreateRecoveryPoint(workspaceId, project.id);
	const [restoring, setRestoring] = useState<RecoveryPoint | null>(null);
	const [announce, setAnnounce] = useState("");
	const points = list.data?.points ?? [];
	const usage = list.data?.usage;

	return (
		<DialogRoot
			open
			// Escape in the restore confirmation can reach this dialog as well; it
			// closes only the confirmation.
			onOpenChange={(open) => {
				if (open) return;
				if (restoring) setRestoring(null);
				else onClose();
			}}
		>
			<Dialog
				testId="dialog-recovery-points"
				size="lg"
				title={`Recovery points for ${project.name}`}
				description="Copies of this project that Portikus keeps outside the folder. Git is never touched."
				onClose={onClose}
			>
				<div className="flex flex-wrap items-center gap-3">
					<Button
						variant="primary"
						loading={create.isPending}
						data-testid="recovery-create"
						onClick={() => {
							if (create.isPending) return;
							setAnnounce("");
							create.mutate(undefined, {
								onSuccess: () => setAnnounce("Recovery point created."),
							});
						}}
					>
						Create recovery point now
					</Button>
					{usage ? (
						<span className="pk-text-small text-ink-muted" data-testid="recovery-usage">
							{formatBytes(usage.usedBytes)} of {formatBytes(usage.quotaBytes)} recovery
							storage used
						</span>
					) : null}
				</div>
				<p
					className="pk-text-small m-0 mt-2"
					role="status"
					data-testid="recovery-status"
				>
					{announce}
				</p>
				<DialogError error={create.error ?? list.error} />
				{list.isSuccess && points.length === 0 ? (
					<p className="pk-text-body mt-4 text-ink-muted" data-testid="recovery-empty">
						No recovery points yet.
					</p>
				) : null}
				{points.length > 0 ? (
					<table className="mt-4 w-full text-[13px]" data-testid="recovery-list">
						<thead>
							<tr className="text-left text-ink-muted">
								<th className="py-1 font-normal">Time</th>
								<th className="py-1 font-normal">Reason</th>
								<th className="py-1 font-normal">Size</th>
								<th className="py-1">
									<span className="sr-only">Actions</span>
								</th>
							</tr>
						</thead>
						<tbody>
							{points.map((point) => {
								const when = pointTime(point.createdAt);
								return (
									<tr key={point.id} data-testid={`recovery-row-${point.id}`}>
										<td className="py-1">{when}</td>
										<td className="py-1">{REASON_LABEL[point.reason]}</td>
										<td className="py-1">{formatBytes(point.sizeBytes)}</td>
										<td className="py-1 text-right">
											<Button
												size="sm"
												aria-label={`Restore to ${when}, ${REASON_LABEL[point.reason]}`}
												data-testid={`recovery-restore-${point.id}`}
												onClick={() => setRestoring(point)}
											>
												Restore…
											</Button>
										</td>
									</tr>
								);
							})}
						</tbody>
					</table>
				) : null}
			</Dialog>
			{restoring ? (
				<RestoreConfirm
					workspaceId={workspaceId}
					project={project}
					point={restoring}
					onClose={() => setRestoring(null)}
					onRestored={onClose}
				/>
			) : null}
		</DialogRoot>
	);
}
