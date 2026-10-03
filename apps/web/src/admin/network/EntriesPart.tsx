import {
	type AdminEgressView,
	EGRESS_LIMITS,
	type EgressEntry,
} from "@portikus/contracts";
import {
	Button,
	ConfirmDialog,
	ConfirmDialogRoot,
	Toggletip,
	useToast,
} from "@portikus/ui";
import { useRef, useState } from "react";
import { AdminGroup } from "../AdminSection.js";
import type { EntryDraft } from "./EntryDialog.js";
import { egressErrorText, useEgressWrite } from "./queries.js";

/** The administrator's own host names and address ranges, with labels. */
export function EntriesPart({
	view,
	onEdit,
}: {
	view: AdminEgressView;
	onEdit: (draft: EntryDraft) => void;
}) {
	const write = useEgressWrite();
	const toast = useToast();
	const [removing, setRemoving] = useState<EgressEntry | null>(null);
	const removed = useRef(false);
	const hosts = view.entries.filter((entry) => entry.kind === "host").length;
	const ranges = view.entries.length - hosts;

	function remove() {
		if (!removing) return;
		write.mutate(
			{ kind: "remove", version: view.version, id: removing.id },
			{
				onSuccess: () => {
					toast.show({ tone: "success", title: `${removing.value} removed` });
					// The row and its Remove button are gone, so focus the card heading.
					removed.current = true;
					setRemoving(null);
				},
			},
		);
	}

	return (
		<AdminGroup
			level={4}
			id="egress-entries-title"
			title="Your hosts and ranges"
			help={
				<Toggletip label="ranges">
					A range, such as 203.0.113.0/24, allows every address in it. It cannot overlap
					a private network, because those stay blocked.
				</Toggletip>
			}
			description={`Anything a preset does not cover, such as your college's own sites. ${hosts} of ${EGRESS_LIMITS.hosts} host names and ${ranges} of ${EGRESS_LIMITS.ranges} ranges used.`}
			actions={
				<Button
					iconStart="plus"
					data-testid="egress-add"
					onClick={() => onEdit({ kind: "host", value: "", label: "" })}
				>
					Add…
				</Button>
			}
		>
			{view.entries.length === 0 ? (
				<p
					className="m-0 text-[13px] text-ink-muted"
					data-testid="egress-entries-empty"
				>
					No hosts or ranges yet. Add a host name such as api.example.edu, or allow one
					from the refused names or the host test.
				</p>
			) : (
				<div className="pk-table-wrap">
					<table className="pk-table" data-testid="egress-entries">
						<caption className="sr-only">Your hosts and ranges</caption>
						<thead>
							<tr>
								<th scope="col">Host or range</th>
								<th scope="col">Label</th>
								<th scope="col">
									<span className="sr-only">Actions</span>
								</th>
							</tr>
						</thead>
						<tbody>
							{view.entries.map((entry) => (
								<tr key={entry.id} data-testid="egress-entry-row">
									<td>
										<span className="font-mono">{entry.value}</span>
										{entry.kind === "range" ? (
											<span className="ml-2 text-[12px] text-ink-muted">range</span>
										) : null}
									</td>
									<td className="text-ink-muted">{entry.label || "No label"}</td>
									<td className="text-right whitespace-nowrap">
										<Button
											size="sm"
											variant="quiet"
											aria-label={`Edit ${entry.value}`}
											onClick={() =>
												onEdit({
													id: entry.id,
													kind: entry.kind,
													value: entry.value,
													label: entry.label,
												})
											}
										>
											Edit
										</Button>
										<Button
											size="sm"
											variant="quiet"
											aria-label={`Remove ${entry.value}`}
											onClick={() => {
												removed.current = false;
												setRemoving(entry);
											}}
										>
											Remove
										</Button>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
			<ConfirmDialogRoot
				open={removing !== null}
				onOpenChange={(open) => {
					if (!open) {
						setRemoving(null);
						write.reset();
					}
				}}
			>
				{removing ? (
					<ConfirmDialog
						id="egress-remove-confirm"
						testId="egress-remove-dialog"
						title={`Remove ${removing.value}?`}
						description={
							view.mode === "allow-list"
								? "Workspaces stop reaching it within seconds, unless a preset also covers it."
								: "Open mode is on, so nothing changes for workspaces until you switch to allow-list."
						}
						confirmLabel="Remove"
						pending={write.isPending}
						onConfirm={remove}
						returnFocusTo={() => {
							if (!removed.current) return null;
							removed.current = false;
							return document.getElementById("egress-entries-title");
						}}
					>
						{write.isError ? (
							<p className="m-0 text-[13px] text-status-error" role="alert">
								{egressErrorText(write.error)}
							</p>
						) : null}
					</ConfirmDialog>
				) : null}
			</ConfirmDialogRoot>
		</AdminGroup>
	);
}
