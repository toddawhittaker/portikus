import type { AdminModelPrice } from "@portikus/contracts";
import {
	Button,
	ConfirmDialog,
	ConfirmDialogRoot,
	EmptyState,
	IconButton,
	useToast,
} from "@portikus/ui";
import { useRef, useState } from "react";
import { errorText } from "../../api/request.js";
import { AdminGroup } from "../AdminSection.js";
import { TableBox } from "../TableBox.js";
import { useDeleteRow } from "./queries.js";
import { RowDialog } from "./RowDialog.js";
import {
	day,
	dollars,
	hostOf,
	lifetime,
	PROVIDER_LABEL,
	ratio,
	surcharge,
} from "./text.js";

type Editing = { row: AdminModelPrice | null } | null;

/** The price table the student restart estimate reads (SPEC.md section 10.8). */
export function PriceTableGroup({ prices }: { prices: AdminModelPrice[] }) {
	const [editing, setEditing] = useState<Editing>(null);
	const [deleting, setDeleting] = useState<AdminModelPrice | null>(null);
	const opener = useRef<HTMLElement | null>(null);
	const addButton = useRef<HTMLButtonElement>(null);
	const remove = useDeleteRow();
	const toast = useToast();

	function open(row: AdminModelPrice | null, from: HTMLElement) {
		opener.current = from;
		setEditing({ row });
	}

	function confirmDelete(row: AdminModelPrice) {
		remove.mutate(row.id, {
			onSuccess: () => {
				setDeleting(null);
				toast.show({ tone: "success", title: `${row.model} deleted` });
			},
		});
	}

	return (
		<AdminGroup
			id="pricing-table-title"
			title="Prices"
			testId="pricing-table"
			description="What each model costs on its provider's API. A model with no row here uses the built-in figures."
			actions={
				<Button
					ref={addButton}
					size="sm"
					data-testid="price-row-add"
					onClick={(e) => open(null, e.currentTarget)}
				>
					Add row
				</Button>
			}
		>
			{prices.length === 0 ? (
				<EmptyState title="No prices yet">
					Check prices now, or add a row by hand. Until then the student estimate uses
					the built-in figures.
				</EmptyState>
			) : (
				<TableBox label="Prices">
					<table className="pk-table" data-testid="price-rows">
						<thead>
							<tr>
								<th scope="col">Model</th>
								<th scope="col">Input per million</th>
								<th scope="col">Cache read</th>
								<th scope="col">Cache write</th>
								<th scope="col">Lifetime</th>
								<th scope="col">Surcharge</th>
								<th scope="col">Source</th>
								<th scope="col">Checked</th>
								<th scope="col">
									<span className="sr-only">Actions</span>
								</th>
							</tr>
						</thead>
						<tbody>
							{prices.map((row) => (
								<tr key={row.id} data-testid={`price-row-${row.model}`}>
									<th scope="row" className="font-normal">
										<span className="block pk-mono-body [overflow-wrap:anywhere]">
											{row.model}
										</span>
										<span className="block text-[12px] text-ink-muted">
											{PROVIDER_LABEL[row.provider]}
										</span>
									</th>
									<td className="tabular-nums">{dollars(row.inputPricePerMillion)}</td>
									<td className="tabular-nums">{ratio(row.cacheReadRatio)}</td>
									<td className="tabular-nums">
										{ratio(row.cacheWriteRatio)}
										{row.cacheWriteOneHourRatio !== null ? (
											<span className="block text-[12px] text-ink-muted">
												{ratio(row.cacheWriteOneHourRatio)} for one hour
											</span>
										) : null}
									</td>
									<td className="tabular-nums">{lifetime(row.cacheTtlSeconds)}</td>
									<td>{surcharge(row)}</td>
									<td>
										<SourceCell url={row.sourceUrl} quote={row.sourceQuote} />
									</td>
									<td>
										<time dateTime={row.checkedAt}>{day(row.checkedAt)}</time>
									</td>
									<td>
										<div className="flex gap-1">
											<IconButton
												icon="pencil"
												label={`Edit ${row.model}`}
												size="sm"
												data-testid="price-row-edit"
												onClick={(e) => open(row, e.currentTarget)}
											/>
											<IconButton
												icon="trash"
												label={`Delete ${row.model}`}
												size="sm"
												data-testid="price-row-delete"
												onClick={(e) => {
													opener.current = e.currentTarget;
													remove.reset();
													setDeleting(row);
												}}
											/>
										</div>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</TableBox>
			)}
			{editing ? (
				<RowDialog
					row={editing.row}
					onClose={() => setEditing(null)}
					returnFocusTo={() =>
						opener.current?.isConnected ? opener.current : addButton.current
					}
				/>
			) : null}
			{deleting ? (
				<ConfirmDialogRoot open onOpenChange={(o) => !o && setDeleting(null)}>
					<ConfirmDialog
						testId="price-row-delete-dialog"
						title={`Delete the price row for ${deleting.model}?`}
						description={
							remove.isError
								? errorText(remove.error)
								: "The student estimate goes back to the built-in figures for this model, until a check proposes a new row."
						}
						confirmLabel="Delete row"
						pending={remove.isPending}
						returnFocusTo={() => addButton.current}
						onCancel={() => setDeleting(null)}
						onConfirm={() => confirmDelete(deleting)}
					/>
				</ConfirmDialogRoot>
			) : null}
		</AdminGroup>
	);
}

/** The source page, with the quote the figures were read from behind a disclosure. */
export function SourceCell({ url, quote }: { url: string; quote: string }) {
	return (
		<div className="grid min-w-[10rem] gap-1">
			<a
				className="pk-link [overflow-wrap:anywhere]"
				href={url}
				target="_blank"
				rel="noreferrer noopener"
			>
				{hostOf(url)}
			</a>
			<details className="text-[12px]">
				<summary className="pk-link w-fit cursor-pointer">Quote</summary>
				<q className="mt-1 block text-ink-muted [overflow-wrap:anywhere]">{quote}</q>
			</details>
		</div>
	);
}
