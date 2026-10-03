import {
	type AdminEgressView,
	EGRESS_LIMITS,
	type EgressBlockedSite,
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
import { BlockedSiteDialog, type BlockedSiteDraft } from "./BlockedSiteDialog.js";
import { egressErrorText, useEgressWrite } from "./queries.js";

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
	const idle = view.mode === "allow-list" && sites.length === 0;

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
		<AdminGroup
			id="egress-blocked-sites-title"
			title="Blocked sites"
			help={
				<Toggletip label="blocked sites">
					A name also blocks every name under it. While any site is blocked, workspace
					DNS goes through the platform's resolver, ports 80 and 443 carry only HTTP and
					TLS through the platform's proxy (which checks only each connection's site
					name), and QUIC is dropped. Blocking is best effort against casual use: other
					DNS services, direct addresses and tunnels on other ports get round it. Only
					allow-list mode stops a determined student.
				</Toggletip>
			}
			// An unused, empty list needs no more than its one-line note.
			description={
				idle
					? undefined
					: `Sites workspaces cannot reach in open mode. ${sites.length} of ${EGRESS_LIMITS.blockedSites} used.`
			}
			actions={
				<Button
					iconStart="plus"
					data-testid="egress-block-add"
					onClick={() => setDraft({ value: "", label: "" })}
				>
					Block…
				</Button>
			}
		>
			{view.mode === "allow-list" || sites.length === 0 ? (
				<p className="m-0 text-[13px] text-ink-muted" data-testid="egress-block-note">
					{view.mode === "allow-list"
						? "Allow-list mode is on, so this list is not used until you switch to open mode."
						: "Nothing is blocked, so workspaces reach every public site. Blocking a site, such as games.example.com, puts workspace DNS and web traffic through the platform's resolver and proxy."}
				</p>
			) : null}
			{sites.length === 0 ? null : (
				<div className="pk-table-wrap">
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
		</AdminGroup>
	);
}
