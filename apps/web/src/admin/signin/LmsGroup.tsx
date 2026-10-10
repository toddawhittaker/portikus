import {
	AdminLmsPlatforms,
	type AdminLtiPlatform,
	SiteJobView,
} from "@portikus/contracts";
import { Button, ConfirmDialog, ConfirmDialogRoot, Skeleton } from "@portikus/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { ApiError, errorText, sendJson } from "../../api/request.js";
import { AdminGroup } from "../AdminSection.js";
import { SiteJobLine, useSiteList } from "../site-job.js";
import { LmsDialog, RESTART_WARNING } from "./LmsDialog.js";
import { draftOf, EMPTY_DRAFT } from "./lms-form.js";

const BUSY_NOTE = "A change is being applied. Wait until it ends.";
const BUSY_NOTE_ID = "lms-busy-note";
const GROUP_ID = "admin-signin-lms";

const groupHeading = () => document.getElementById(GROUP_ID);

type Editing = { index: number | null; platform: AdminLtiPlatform | null };

/**
 * LMS platforms for LTI launches: the operator's, read-only, and the ones
 * registered here (SPEC.md section 20.1, ADR 0025, ADR 0059). A change is a
 * root job that updates the proxy and restarts the API.
 */
export function LmsGroup() {
	const { query, job, busy, follow } = useSiteList(
		"lms",
		"/admin/lms",
		AdminLmsPlatforms,
	);
	const client = useQueryClient();
	const save = useMutation({
		mutationFn: (platforms: AdminLtiPlatform[]) =>
			sendJson(SiteJobView, "/admin/lms", { platforms }, "PUT"),
		onSuccess: (queued) => {
			follow(queued);
			void client.invalidateQueries({ queryKey: ["admin", "lms"] });
		},
	});
	const [editing, setEditing] = useState<Editing | null>(null);
	const [removing, setRemoving] = useState<number | null>(null);
	const data = query.data;

	function close() {
		setEditing(null);
		setRemoving(null);
		save.reset();
	}

	if (query.isError && !data) {
		const off = query.error instanceof ApiError && query.error.status === 404;
		return (
			<AdminGroup
				id="admin-signin-lms"
				title="Learning management systems"
				testId="admin-signin-lms"
			>
				<p className="pk-text-compact m-0" data-testid="lms-off">
					{off
						? "This server runs without the site job, so platforms cannot be added here."
						: errorText(query.error)}
				</p>
			</AdminGroup>
		);
	}

	function replaceAt(index: number | null, platform: AdminLtiPlatform) {
		if (!data) return;
		const next = [...data.platforms];
		if (index === null) next.push(platform);
		else next[index] = platform;
		save.mutate(next, { onSuccess: close });
	}

	return (
		<AdminGroup
			id="admin-signin-lms"
			title="Learning management systems"
			description="Platforms that may launch Portikus. Register Portikus in the LMS with the addresses below, then add the platform here."
			testId="admin-signin-lms"
			actions={
				data ? (
					<Button
						iconStart="plus"
						data-testid="lms-add"
						aria-disabled={busy ? true : undefined}
						aria-describedby={busy ? BUSY_NOTE_ID : undefined}
						onClick={() => {
							if (!busy) setEditing({ index: null, platform: null });
						}}
					>
						Add platform…
					</Button>
				) : undefined
			}
		>
			{data ? (
				<>
					<dl className="m-0 grid gap-2 text-[13px]" data-testid="lms-tool-urls">
						{(
							[
								["Login address", data.toolUrls.loginUrl],
								["Launch address", data.toolUrls.launchUrl],
								["Keyset (JWKS) address", data.toolUrls.keysetUrl],
								["Deep Linking address", data.toolUrls.deepLinkingUrl],
							] as const
						).map(([label, url]) => (
							<div key={label} className="grid gap-0.5">
								<dt className="pk-muted">{label}</dt>
								<dd className="m-0 font-mono [overflow-wrap:anywhere]">{url}</dd>
							</div>
						))}
					</dl>
					<div role="status" data-testid="lms-job">
						<SiteJobLine job={job} />
					</div>
					{busy ? (
						<p id={BUSY_NOTE_ID} className="pk-text-compact pk-muted m-0">
							{BUSY_NOTE}
						</p>
					) : null}
					<PlatformTable
						platforms={data.platforms}
						busy={busy}
						onEdit={(index) =>
							setEditing({ index, platform: data.platforms[index] ?? null })
						}
						onRemove={setRemoving}
					/>
					{data.operatorPlatforms.length > 0 ? (
						<div className="grid gap-2">
							<h4 className="pk-text-compact m-0 font-semibold text-ink-muted">
								Set by the operator
							</h4>
							<ul className="m-0 grid gap-1 pl-5" data-testid="lms-operator">
								{data.operatorPlatforms.map((p) => (
									<li key={`${p.issuer} ${p.clientId}`} className="text-[13px]">
										<span className="font-medium">{p.name}</span>{" "}
										<span className="font-mono [overflow-wrap:anywhere]">
											{p.issuer}
										</span>
										{p.mock ? " (test platform)" : ""}
									</li>
								))}
							</ul>
						</div>
					) : null}
				</>
			) : (
				<Skeleton variant="block" height={120} />
			)}
			{data && editing ? (
				<LmsDialog
					title={editing.platform ? `Edit ${editing.platform.name}` : "Add a platform"}
					initial={editing.platform ? draftOf(editing.platform) : EMPTY_DRAFT}
					others={data.platforms.filter((_, i) => i !== editing.index)}
					operator={data.operatorPlatforms}
					pending={save.isPending}
					error={save.isError ? errorText(save.error) : null}
					onSave={(platform) => replaceAt(editing.index, platform)}
					returnFocusTo={() =>
						(editing.platform &&
							document.querySelector<HTMLElement>(
								`[aria-label="Edit ${CSS.escape(editing.platform.name)}"]`,
							)) ||
						groupHeading()
					}
					onClose={close}
				/>
			) : null}
			<ConfirmDialogRoot
				open={removing !== null}
				onOpenChange={(open) => {
					if (!open) close();
				}}
			>
				{data && removing !== null ? (
					<ConfirmDialog
						id="lms-remove-confirm"
						testId="lms-remove-dialog"
						title={`Remove ${data.platforms[removing]?.name ?? "platform"}?`}
						description={`Launches from it stop working. ${RESTART_WARNING}`}
						confirmLabel="Remove and restart"
						pending={save.isPending}
						returnFocusTo={groupHeading}
						onConfirm={() =>
							save.mutate(
								data.platforms.filter((_, i) => i !== removing),
								{
									onSuccess: close,
								},
							)
						}
					>
						{save.isError ? (
							<p className="m-0 text-[13px] text-status-error" role="alert">
								{errorText(save.error)}
							</p>
						) : null}
					</ConfirmDialog>
				) : null}
			</ConfirmDialogRoot>
		</AdminGroup>
	);
}

function PlatformTable({
	platforms,
	busy,
	onEdit,
	onRemove,
}: {
	platforms: AdminLtiPlatform[];
	busy: boolean;
	onEdit: (index: number) => void;
	onRemove: (index: number) => void;
}) {
	if (platforms.length === 0) {
		return (
			<p className="pk-text-compact pk-muted m-0" data-testid="lms-empty">
				No platforms have been added here.
			</p>
		);
	}
	return (
		<div className="pk-table-wrap">
			<table className="pk-table" data-testid="lms-list">
				<caption className="sr-only">Platforms added on this page</caption>
				<thead>
					<tr>
						<th scope="col">Name</th>
						<th scope="col">Issuer</th>
						<th scope="col">
							<span className="sr-only">Actions</span>
						</th>
					</tr>
				</thead>
				<tbody>
					{platforms.map((p, index) => (
						<tr key={`${p.issuer} ${p.clientId}`} data-testid="lms-row">
							<td>{p.name}</td>
							<td>
								<span className="font-mono [overflow-wrap:anywhere]">{p.issuer}</span>
							</td>
							<td className="text-right whitespace-nowrap">
								<Button
									size="sm"
									variant="quiet"
									aria-label={`Edit ${p.name}`}
									aria-disabled={busy ? true : undefined}
									aria-describedby={busy ? BUSY_NOTE_ID : undefined}
									onClick={() => {
										if (!busy) onEdit(index);
									}}
								>
									Edit
								</Button>
								<Button
									size="sm"
									variant="quiet"
									aria-label={`Remove ${p.name}`}
									aria-disabled={busy ? true : undefined}
									aria-describedby={busy ? BUSY_NOTE_ID : undefined}
									onClick={() => {
										if (!busy) onRemove(index);
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
	);
}
