import type { AuditEvent } from "@portikus/contracts";
import { Button, TextField } from "@portikus/ui";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { ApiError } from "../../api/request.js";
import { UUID } from "../../links.js";
import { type AuditFilters, useAuditPage } from "./queries.js";

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** The filters a link such as `/admin?tab=audit&workspace=<id>` asks for. */
export function filtersFromSearch(search: Record<string, unknown>): AuditFilters {
	return {
		workspace: text(search.workspace),
		user: text(search.user),
		action: text(search.action),
	};
}

/**
 * The Audit tab of the admin page (SPEC.md §24.11): newest first, 50 rows a
 * page, filtered by workspace, user and action prefix.
 */
export function AuditTab() {
	const search = useSearch({ strict: false }) as Record<string, unknown>;
	const initial = filtersFromSearch(search);
	// A new link (for example "All events" from a workspace) starts afresh.
	return <AuditView key={JSON.stringify(initial)} initial={initial} />;
}

function AuditView({ initial }: { initial: AuditFilters }) {
	const navigate = useNavigate();
	const [draft, setDraft] = useState(initial);
	const filters = initial;
	const [invalid, setInvalid] = useState(false);
	// The `before` cursor of every page shown so far; the last one is current.
	const [cursors, setCursors] = useState<(number | null)[]>([null]);
	const before = cursors[cursors.length - 1] ?? null;
	const page = useAuditPage(filters, before);

	// Filters live in the URL so a filtered view can be linked; a change
	// re-keys this view, which starts again from the newest page.
	function show(next: AuditFilters) {
		void navigate({
			to: "/admin",
			search: {
				tab: "audit",
				workspace: next.workspace || undefined,
				user: next.user || undefined,
				action: next.action || undefined,
			},
		});
	}

	function apply(event: FormEvent) {
		event.preventDefault();
		const next = {
			workspace: draft.workspace.trim(),
			user: draft.user.trim(),
			action: draft.action.trim(),
		};
		// The router drops an ID that is not a UUID, so say so instead.
		if (
			(next.workspace && !UUID.test(next.workspace)) ||
			(next.user && !UUID.test(next.user))
		) {
			setInvalid(true);
			return;
		}
		show(next);
	}

	function clear() {
		show({ workspace: "", user: "", action: "" });
	}

	const nextBefore = page.data?.nextBefore ?? null;
	const events = page.data?.events ?? [];

	return (
		<section className="pk-card mt-6 p-6" aria-labelledby="audit-title">
			<h2 className="pk-text-heading m-0" id="audit-title">
				Audit events
			</h2>
			<form className="pk-actions mt-4 items-end" onSubmit={apply}>
				<TextField
					id="audit-workspace"
					label="Workspace ID"
					className="w-80"
					data-testid="audit-filter-workspace"
					value={draft.workspace}
					onChange={(event) => setDraft({ ...draft, workspace: event.target.value })}
				/>
				<TextField
					id="audit-user"
					label="User ID"
					className="w-80"
					data-testid="audit-filter-user"
					value={draft.user}
					onChange={(event) => setDraft({ ...draft, user: event.target.value })}
				/>
				<TextField
					id="audit-action"
					label="Action starts with"
					className="w-48"
					placeholder="workspace."
					data-testid="audit-filter-action"
					value={draft.action}
					onChange={(event) => setDraft({ ...draft, action: event.target.value })}
				/>
				<Button variant="primary" type="submit" data-testid="audit-filter-apply">
					Apply filters
				</Button>
				<Button type="button" data-testid="audit-filter-clear" onClick={clear}>
					Clear
				</Button>
			</form>
			{invalid ? (
				<p className="pk-error mt-4 text-status-error" role="alert">
					A workspace or user ID must be a full ID, as shown in the workspace detail
					panel.
				</p>
			) : null}
			{page.isError ? (
				<p className="pk-error mt-4 text-status-error" role="alert">
					{page.error instanceof ApiError
						? page.error.message
						: "Audit events could not be loaded."}
				</p>
			) : null}
			<table
				className="mt-4 w-full text-left text-[13px]"
				data-testid="audit-table"
				aria-busy={page.isFetching}
			>
				<caption className="pk-text-label pk-muted text-left">
					Audit events, newest first, {events.length} shown
				</caption>
				<thead>
					<tr className="pk-text-label text-ink-muted">
						<th className="py-2 pr-4 font-medium">Time</th>
						<th className="py-2 pr-4 font-medium">Actor</th>
						<th className="py-2 pr-4 font-medium">Action</th>
						<th className="py-2 pr-4 font-medium">Target</th>
						<th className="py-2 pr-4 font-medium">Result</th>
						<th className="py-2 font-medium">Details</th>
					</tr>
				</thead>
				<tbody>
					{events.map((event) => (
						<AuditRow key={event.id} event={event} />
					))}
				</tbody>
			</table>
			{page.isSuccess && events.length === 0 ? (
				<p className="pk-text-body pk-muted mt-4">No audit events match.</p>
			) : null}
			<div className="pk-actions mt-4">
				<Button
					data-testid="audit-newer"
					aria-label="Newer audit events"
					disabled={cursors.length < 2}
					onClick={() => setCursors(cursors.slice(0, -1))}
				>
					Newer
				</Button>
				<Button
					data-testid="audit-older"
					aria-label="Older audit events"
					disabled={nextBefore === null}
					onClick={() => setCursors([...cursors, nextBefore])}
				>
					Older
				</Button>
			</div>
		</section>
	);
}

function AuditRow({ event }: { event: AuditEvent }) {
	const metadata = Object.entries(event.metadata ?? {});
	return (
		<tr
			className="border-line border-t align-top"
			data-testid={`audit-row-${event.id}`}
		>
			<td className="py-2 pr-4 whitespace-nowrap">
				<time dateTime={event.at}>{new Date(event.at).toLocaleString()}</time>
			</td>
			<td className="py-2 pr-4" title={event.actor}>
				{event.actorName ?? event.actor}
			</td>
			<td className="py-2 pr-4 font-mono">{event.action}</td>
			<td className="py-2 pr-4 font-mono break-all">{event.target}</td>
			<td className="py-2 pr-4">{event.result}</td>
			<td className="py-2">
				{metadata.length === 0 ? (
					"—"
				) : (
					<dl className="m-0">
						{metadata.map(([key, value]) => (
							<div key={key} className="flex gap-1">
								<dt className="pk-muted">{key}:</dt>
								<dd className="m-0 font-mono break-all">
									{typeof value === "string" ? value : JSON.stringify(value)}
								</dd>
							</div>
						))}
					</dl>
				)}
			</td>
		</tr>
	);
}
