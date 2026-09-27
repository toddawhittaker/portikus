import {
	type AdminEgressView,
	EGRESS_DEFAULT_BLOCKED_SITES,
	EGRESS_LIMITS,
	type EgressBlockedSite,
} from "@portikus/contracts";
import {
	Button,
	ConfirmDialog,
	ConfirmDialogRoot,
	EmptyState,
	useToast,
} from "@portikus/ui";
import { useRef, useState } from "react";
import { BlockedSiteDialog, type BlockedSiteDraft } from "./BlockedSiteDialog.js";
import { egressErrorText, useEgressWrite } from "./queries.js";

const DEFAULTS: readonly string[] = EGRESS_DEFAULT_BLOCKED_SITES;

/**
 * Sites workspaces cannot reach in open mode (ADR 0043). Allow-list mode
 * ignores the list, since it already refuses everything it does not list.
 */
export function BlockedSitesCard({ view }: { view: AdminEgressView }) {
	const write = useEgressWrite();
	const toast = useToast();
	const [draft, setDraft] = useState<BlockedSiteDraft | null>(null);
	const [removing, setRemoving] = useState<EgressBlockedSite | null>(null);
	const removed = useRef(false);
	const sites = view.blockedSites;

	function remove() {
		if (!removing) return;
		write.mutate(
			{ kind: "block-remove", version: view.version, id: removing.id },
			{
				onSuccess: () => {
					toast.show({ tone: "success", title: `${removing.value} unblocked` });
					// The row and its Remove button are gone, so focus the card heading.
					removed.current = true;
					setRemoving(null);
				},
			},
		);
	}

	return (
		<section className="pk-card p-6" aria-labelledby="egress-blocked-sites-title">
			<div className="flex items-start gap-4">
				<div className="min-w-0 flex-1">
					<h3
						className="pk-text-heading m-0"
						id="egress-blocked-sites-title"
						tabIndex={-1}
					>
						Blocked sites
					</h3>
					<p className="pk-text-body pk-muted mt-1 mb-0">
						Sites workspaces cannot reach in open mode. A name also blocks every name
						under it. {sites.length} of {EGRESS_LIMITS.blockedSites} used.
					</p>
				</div>
				<Button
					iconStart="plus"
					data-testid="egress-block-add"
					onClick={() => setDraft({ value: "", label: "" })}
				>
					Block…
				</Button>
			</div>
			<p
				className="m-0 mt-3 text-[13px] text-ink-muted"
				data-testid="egress-block-note"
			>
				{view.mode === "allow-list"
					? "Allow-list mode is on, so this list is not used: anything you have not allowed is already blocked. It applies again when you switch to open mode."
					: sites.length > 0
						? "While any site is blocked, workspace web traffic passes through the platform's proxy, which checks only each connection's site name."
						: "Nothing is blocked, so workspaces reach every public site."}
			</p>
			{sites.length === 0 ? (
				<EmptyState icon="info" title="No blocked sites">
					Block a host name such as games.example.com.
				</EmptyState>
			) : (
				<div className="pk-table-wrap mt-4">
					<table className="pk-table" data-testid="egress-block-list">
						<caption className="sr-only">Blocked sites</caption>
						<thead>
							<tr>
								<th scope="col">Site</th>
								<th scope="col">Label</th>
								<th scope="col">
									<span className="sr-only">Actions</span>
								</th>
							</tr>
						</thead>
						<tbody>
							{sites.map((site) => (
								<tr key={site.id} data-testid="egress-block-row">
									<td>
										<span className="font-mono [overflow-wrap:anywhere]">
											{site.value}
										</span>
										{DEFAULTS.includes(site.value) ? (
											<span className="ml-2 text-[12px] text-ink-muted">default</span>
										) : null}
									</td>
									<td className="text-ink-muted">{site.label || "No label"}</td>
									<td className="text-right whitespace-nowrap">
										<Button
											size="sm"
											variant="quiet"
											aria-label={`Edit ${site.value}`}
											onClick={() =>
												setDraft({ id: site.id, value: site.value, label: site.label })
											}
										>
											Edit
										</Button>
										<Button
											size="sm"
											variant="quiet"
											aria-label={`Remove ${site.value}`}
											onClick={() => {
												removed.current = false;
												setRemoving(site);
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
			{draft ? (
				<BlockedSiteDialog
					draft={draft}
					version={view.version}
					onClose={() => setDraft(null)}
				/>
			) : null}
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
						id="egress-block-remove-confirm"
						testId="egress-block-remove-dialog"
						title={`Unblock ${removing.value}?`}
						description={
							view.mode === "open"
								? "Workspaces can reach it again within seconds."
								: "Allow-list mode is on, so nothing changes for workspaces until you switch to open mode."
						}
						confirmLabel="Remove"
						pending={write.isPending}
						onConfirm={remove}
						returnFocusTo={() => {
							if (!removed.current) return null;
							removed.current = false;
							return document.getElementById("egress-blocked-sites-title");
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
		</section>
	);
}
