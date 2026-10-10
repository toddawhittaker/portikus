import { Button } from "@portikus/ui";

/**
 * A row action that is off for a reason of its own, shown under it, or off
 * while a job runs, pointing at the one busy note above the list.
 */
export function RowAction({
	label,
	ariaLabel,
	testId,
	primary,
	reason,
	busy,
	onPress,
}: {
	label: string;
	ariaLabel: string;
	testId: string;
	primary?: boolean;
	reason: string | null;
	busy: boolean;
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
				aria-describedby={reason ? noteId : busy ? "image-busy-note" : undefined}
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
