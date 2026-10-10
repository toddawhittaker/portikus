import { Button } from "@portikus/ui";

/** What the busy note above a section's list says while an image job is active. */
export const IMAGE_BUSY_REASON =
	"An image job is waiting or running. Wait until it finishes.";

/**
 * A row action that is off for a reason of its own, shown under it, or off
 * while a job runs, pointing at the busy note above its list.
 */
export function RowAction({
	label,
	ariaLabel,
	testId,
	primary,
	reason,
	busy,
	busyNoteId = "image-busy-note",
	onPress,
}: {
	label: string;
	ariaLabel: string;
	testId: string;
	primary?: boolean;
	reason: string | null;
	busy: boolean;
	busyNoteId?: string;
	onPress: () => void;
}) {
	const noteId = `${testId}-note`;
	const off = reason !== null || busy;
	return (
		<span className="inline-flex flex-col items-start gap-1">
			<Button
				variant={primary ? "primary" : "secondary"}
				data-testid={testId}
				aria-label={ariaLabel}
				aria-disabled={off ? true : undefined}
				aria-describedby={reason ? noteId : busy ? busyNoteId : undefined}
				onClick={() => (off ? undefined : onPress())}
			>
				{label}
			</Button>
			{reason ? (
				<span id={noteId} className="pk-muted text-[12px]">
					{reason}
				</span>
			) : null}
		</span>
	);
}
