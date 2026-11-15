/**
 * The confirmation before a model or version change in a chat with history
 * (SPEC.md §10.2): the prompt cache belongs to one model, so the new model
 * reads the whole conversation again at the cache-write price. A fresh chat
 * from a handoff note is the cheaper way to switch.
 */
import { Button, ConfirmDialog, ConfirmDialogRoot } from "@portikus/ui";

const CHANGE_MODEL = "Change model";
const MODEL_CHANGE_HANDOFF = "Start fresh chat with handoff";

/** The warning's words; the size clause is left out until the meter has a figure. */
function modelChangeText(usedTokens: number | null): string {
	const thousands = usedTokens === null ? 0 : Math.round(usedTokens / 1000);
	const size = thousands > 0 ? `, about ${thousands}k tokens` : "";
	return `The new model reads this whole conversation again at full price${size}. Starting a fresh chat with a handoff is cheaper.`;
}

export function ModelChangeConfirm({
	usedTokens,
	onChange,
	onHandoff,
	onCancel,
	returnFocusTo,
}: {
	/** The context meter's current figure; null before it has one. */
	usedTokens: number | null;
	onChange: () => void;
	onHandoff: () => void;
	onCancel: () => void;
	/** The picker the choice came from, which the dialog hands focus back to. */
	returnFocusTo: () => HTMLElement | null;
}) {
	return (
		<ConfirmDialogRoot open={true} onOpenChange={(open) => !open && onCancel()}>
			<ConfirmDialog
				id="pk-model-change"
				testId="dialog-model-change"
				title="Change the model in this chat?"
				description={modelChangeText(usedTokens)}
				confirmLabel={CHANGE_MODEL}
				destructive={false}
				onConfirm={onChange}
				onCancel={onCancel}
				returnFocusTo={returnFocusTo}
			>
				<Button
					variant="secondary"
					data-testid="dialog-model-change-handoff"
					onClick={onHandoff}
				>
					{MODEL_CHANGE_HANDOFF}
				</Button>
			</ConfirmDialog>
		</ConfirmDialogRoot>
	);
}
