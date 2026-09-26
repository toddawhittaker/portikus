import type { AuditEvent } from "@portikus/contracts";
import { Button, TextField } from "@portikus/ui";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { ApiError } from "../../api/request.js";
import { UUID } from "../../links.js";
import { AdminSection } from "../AdminSection.js";
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
	const filters = filtersFromSearch(search);
	const key = JSON.stringify(filters);
	const navigate = useNavigate();
	const [draft, setDraft] = useState(filters);
	const [draftKey, setDraftKey] = useState(key);
	const [invalid, setInvalid] = useState<{ workspace: boolean; user: boolean }>({
		workspace: false,
		user: false,
	});
	// A new link (for example "All events" from a workspace) refills the form.
	if (draftKey !== key) {
		setDraftKey(key);
		setDraft(filters);
	}

	// Filters live in the URL so a filtered view can be linked.
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
		const bad = {
			workspace: next.workspace !== "" && !UUID.test(next.workspace),
			user: next.user !== "" && !UUID.test(next.user),
		};
		setInvalid(bad);
		if (bad.workspace || bad.user) return;
		show(next);
	}

	function clear() {
		setInvalid({ workspace: false, user: false });
		show({ workspace: "", user: "", action: "" });
	}

	return (
		<AdminSection title="Audit">
			<form className="pk-actions items-end" onSubmit={apply}>
				<TextField
					id="audit-workspace"
					label="Workspace ID"
					className="w-80"
					data-testid="audit-filter-workspace"
					value={draft.workspace}
					error={invalid.workspace ? INVALID_ID_TEXT : undefined}
					onChange={(event) => setDraft({ ...draft, workspace: event.target.value })}
				/>
				<TextField
					id="audit-user"
					label="User ID"
					className="w-80"
					data-testid="audit-filter-user"
					value={draft.user}
					error={invalid.user ? INVALID_ID_TEXT : undefined}
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
			{/* Only the results re-key on new filters, so the focused form button stays. */}
			<AuditResults key={key} filters={filters} />
		</AdminSection>
	);
}

export const INVALID_ID_TEXT =
	"Enter a full ID, as shown in the workspace detail panel.";

function AuditResults({ filters }: { filters: AuditFilters }) {
	// The `before` cursor of every page shown so far; the last one is current.
	const [cursors, setCursors] = useState<(number | null)[]>([null]);
	const before = cursors[cursors.length - 1] ?? null;
	const page = useAuditPage(filters, before);

	const nextBefore = page.data?.nextBefore ?? null;
	const events = page.data?.events ?? [];
	const atNewest = cursors.length < 2;
	const atOldest = nextBefore === null;

	return (
		<>
			{page.isError ? (
				<p className="pk-error text-status-error" role="alert">
					{page.error instanceof ApiError
						? page.error.message
						: "Audit events could not be loaded."}
				</p>
			) : null}
			{/* overflow-clip, not the wrap's overflow auto, so the header sticks to the scrolling <main> (EPIC-18 ruling 5). */}
			<div className="pk-table-wrap overflow-clip">
				<table
					className="pk-table"
					data-testid="audit-table"
					aria-busy={page.isFetching}
				>
					<caption className="sr-only">
						Audit events, newest first, {events.length} shown
					</caption>
					<thead>
						<tr>
							<th>Time</th>
							<th>Actor</th>
							<th>Action</th>
							<th>Target</th>
							<th>Result</th>
							<th>Details</th>
						</tr>
					</thead>
					<tbody>
						{events.map((event) => (
							<AuditRow key={event.id} event={event} />
						))}
					</tbody>
				</table>
			</div>
			{page.isSuccess && events.length === 0 ? (
				<p className="pk-text-body pk-muted">No audit events match.</p>
			) : null}
			<div className="pk-actions items-center">
				{/* Unavailable buttons stay focusable so paging never drops focus. */}
				<Button
					data-testid="audit-newer"
					aria-label="Newer audit events"
					aria-disabled={atNewest ? true : undefined}
					onClick={() => (atNewest ? undefined : setCursors(cursors.slice(0, -1)))}
				>
					Newer
				</Button>
				<Button
					data-testid="audit-older"
					aria-label="Older audit events"
					aria-disabled={atOldest ? true : undefined}
					onClick={() => (atOldest ? undefined : setCursors([...cursors, nextBefore]))}
				>
					Older
				</Button>
				<span
					className="pk-text-compact pk-muted"
					role="status"
					data-testid="audit-page"
				>
					{page.isSuccess ? pageText(cursors.length, events.length) : ""}
				</span>
			</div>
		</>
	);
}

export function pageText(pageNumber: number, count: number): string {
	return `Page ${pageNumber}, ${count} ${count === 1 ? "event" : "events"}`;
}

function AuditRow({ event }: { event: AuditEvent }) {
	const metadata = Object.entries(event.metadata ?? {});
	return (
		<tr className="align-top" data-testid={`audit-row-${event.id}`}>
			<td className="py-2">
				<time dateTime={event.at}>{new Date(event.at).toLocaleString()}</time>
			</td>
			<td className="py-2" title={event.actor}>
				{event.actorName ?? event.actor}
			</td>
			<td className="py-2 font-mono">{event.action}</td>
			<td className="py-2 font-mono whitespace-normal break-all">{event.target}</td>
			<td className="py-2">{event.result}</td>
			<td className="py-2 whitespace-normal">
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
