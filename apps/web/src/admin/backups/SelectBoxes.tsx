import { Button, Checkbox } from "@portikus/ui";
import {
	allBoxState,
	type DeleteKind,
	deleteSelectedText,
	type Pickable,
} from "./selection.js";

/** The tab's one selection across its four lists, as each list sees it. */
export interface ListSelection {
	/** Every listed item, in page order. */
	items: Pickable[];
	selected: ReadonlySet<string>;
	/** Ticked items across the whole tab that can still be deleted. */
	count: number;
	onPick: (keys: string[], on: boolean) => void;
	/** Opens the confirm for every ticked item; `listId` is the list's heading. */
	onDeleteSelected: (listId: string) => void;
}

function itemsOf(selection: ListSelection, kind: DeleteKind): Pickable[] {
	return selection.items.filter((item) => item.target.kind === kind);
}

/** The id of a list's Delete selected button, where focus goes back after the confirm. */
export function deleteSelectedId(listId: string): string {
	return `${listId}-delete-selected`;
}

/** The head cell's box: ticks every row of this list that can be deleted. */
export function SelectAllBox({
	kind,
	noun,
	selection,
}: {
	kind: DeleteKind;
	/** Plural, as in "Select all {noun}". */
	noun: string;
	selection: ListSelection;
}) {
	const items = itemsOf(selection, kind);
	const state = allBoxState(items, selection.selected);
	return (
		<Checkbox
			label={<span className="sr-only">Select all {noun}</span>}
			checked={state.checked}
			indeterminate={state.indeterminate}
			ariaDisabled={state.unavailable}
			description={
				state.unavailable ? (
					<span className="sr-only">None of these can be deleted now</span>
				) : undefined
			}
			onChange={(event) => {
				if (state.unavailable) return;
				selection.onPick(
					items.filter((item) => item.blocked === null).map((item) => item.key),
					event.target.checked,
				);
			}}
		/>
	);
}

/** One row's box; a row that cannot be deleted keeps a muted box that says why. */
export function SelectBox({
	itemKey,
	label,
	selection,
}: {
	itemKey: string;
	/** The accessible name, such as "Select portikus-pre-upgrade.dump". */
	label: string;
	selection: ListSelection;
}) {
	const blocked = selection.items.find((item) => item.key === itemKey)?.blocked ?? null;
	return (
		<Checkbox
			label={<span className="sr-only">{label}</span>}
			checked={blocked === null && selection.selected.has(itemKey)}
			ariaDisabled={blocked !== null}
			description={blocked ? <span className="sr-only">{blocked}</span> : undefined}
			onChange={(event) => {
				if (blocked === null) selection.onPick([itemKey], event.target.checked);
			}}
		/>
	);
}

/** Beside a list's heading while any of its rows is ticked; deletes every ticked item on the tab. */
export function DeleteSelectedButton({
	kind,
	listId,
	selection,
}: {
	kind: DeleteKind;
	listId: string;
	selection: ListSelection;
}) {
	const here = itemsOf(selection, kind).filter(
		(item) => item.blocked === null && selection.selected.has(item.key),
	).length;
	if (here === 0) return null;
	return (
		<Button
			size="sm"
			// Taller than the heading row, so it overhangs instead of pushing the table down when it appears;
			// in a narrow card it takes its own row rather than squeezing the heading.
			className="-my-1 @max-lg:basis-full"
			id={deleteSelectedId(listId)}
			data-testid={deleteSelectedId(listId)}
			onClick={() => selection.onDeleteSelected(listId)}
		>
			{deleteSelectedText(selection.count, here)}
		</Button>
	);
}
