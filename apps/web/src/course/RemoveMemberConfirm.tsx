import type { CourseMember } from "@portikus/contracts";
import { ConfirmDialog, ConfirmDialogRoot } from "@portikus/ui";
import { useRemoveMember } from "./queries.js";

/** Removing a member deletes only their place in this course, never their account. */
export function RemoveMemberConfirm({
	courseId,
	courseTitle,
	member,
	onClose,
	onRemoved,
}: {
	courseId: string;
	courseTitle: string;
	member: CourseMember;
	onClose: () => void;
	/** Called after a removal succeeds, instead of onClose. */
	onRemoved: () => void;
}) {
	const remove = useRemoveMember(courseId);

	return (
		<ConfirmDialogRoot open onOpenChange={(open) => !open && onClose()}>
			<ConfirmDialog
				testId="dialog-remove-member"
				title={`Remove ${member.displayName} from ${courseTitle}?`}
				description={
					<>
						They reappear if they open Portikus from the course again.
						{remove.isError ? (
							<span
								className="mt-2 block text-status-error"
								role="alert"
								data-testid="remove-member-error"
							>
								Portikus could not remove them. Try again.
							</span>
						) : null}
					</>
				}
				lost={["their row on this Course page"]}
				survives={["their account", "their workspace and files", "their other courses"]}
				confirmLabel="Remove from course"
				pending={remove.isPending}
				onCancel={onClose}
				onConfirm={() => {
					if (remove.isPending) return;
					remove.mutate(member.userId, { onSuccess: onRemoved });
				}}
			/>
		</ConfirmDialogRoot>
	);
}
