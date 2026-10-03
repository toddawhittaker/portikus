import type { AdminUser, AuditEvent } from "@portikus/contracts";
import { Button, TextField, Toggletip } from "@portikus/ui";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { ApiError } from "../../api/request.js";
import { UUID } from "../../links.js";
import { shortTime } from "../../text.js";
import { AdminSection } from "../AdminSection.js";
import { personLabel, personOptions, resolvePerson } from "../people.js";
import { useAdminUsers } from "../queries.js";
import { type AuditFilters, useAuditPage } from "./queries.js";

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** The filters a link such as `/admin/audit?workspace=<id>` asks for. */
export function filtersFromSearch(search: Record<string, unknown>): AuditFilters {
	return {
		workspace: text(search.workspace),
		user: text(search.user),
		action: text(search.action),
	};
}

/** "Alice Student" for a user, "Alice Student's workspace" for their workspace, else null. */
export function targetLabel(id: string, users: AdminUser[] | undefined): string | null {
	for (const user of users ?? []) {
		if (user.id === id) return user.displayName;
		if (user.workspace?.id === id) return `${user.displayName}'s workspace`;
	}
	return null;
}

/**
 * The Audit tab of the admin page (SPEC.md §24.11): newest first, 50 rows a
 * page, filtered by person and action prefix. A target link filters by that
 * target, under the `workspace` URL key so older links still work.
 */
export function AuditTab() {
	const search = useSearch({ strict: false }) as Record<string, unknown>;
	const filters = filtersFromSearch(search);
	const key = JSON.stringify(filters);
	const navigate = useNavigate();
	const users = useAdminUsers({ poll: false }).data?.users;
	const people = personOptions(users ?? []);
	// null until typed in, so the field shows the filtered person's name once the list loads.
	const [personDraft, setPersonDraft] = useState<string | null>(null);
	const [actionDraft, setActionDraft] = useState(filters.action);
	const [draftKey, setDraftKey] = useState(key);
	const [personError, setPersonError] = useState<string | null>(null);
	// A new link (for example "All events" from a workspace) refills the form.
	if (draftKey !== key) {
		setDraftKey(key);
		setPersonDraft(null);
		setActionDraft(filters.action);
		setPersonError(null);
	}
	const personValue =
		personDraft ?? (filters.user ? personLabel(people, filters.user) : "");

	// Filters live in the URL so a filtered view can be linked.
	function show(next: AuditFilters) {
		void navigate({
			to: "/admin/$tab",
			params: { tab: "audit" },
			search: {
				workspace: next.workspace || undefined,
				user: next.user || undefined,
				action: next.action || undefined,
			},
		});
	}

	function apply(event: FormEvent) {
		event.preventDefault();
		const person =
			personDraft === null ? { id: filters.user } : resolvePerson(personDraft, users);
		if ("error" in person) {
			setPersonError(person.error);
			// Focus the field so a screen reader hears its error; refocusing says nothing, so leave first.
			const field = document.getElementById("audit-person");
			if (field && field === document.activeElement) field.blur();
			field?.focus();
			return;
		}
		setPersonError(null);
		show({ workspace: filters.workspace, user: person.id, action: actionDraft.trim() });
	}

	function clear() {
		setPersonDraft("");
		setActionDraft("");
		setPersonError(null);
		show({ workspace: "", user: "", action: "" });
	}

	const targetName = filters.workspace ? targetLabel(filters.workspace, users) : null;

	return (
		<AdminSection
			title="Audit"
			intro={{
				id: "admin-audit",
				text: "A record of every sign-in and every change to accounts, workspaces and settings, and who made it. Use it to find out who did something, and when.",
				helpAnchor: "admin-audit",
			}}
		>
			<form className="pk-actions items-start" onSubmit={apply}>
				<TextField
					id="audit-person"
					label="Person"
					className="w-80"
					list="audit-people"
					autoComplete="off"
					data-testid="audit-filter-person"
					value={personValue}
					error={personError ?? undefined}
					onChange={(event) => setPersonDraft(event.target.value)}
				/>
				<datalist id="audit-people">
					{people.map((option) => (
						<option key={option.id} value={option.label} />
					))}
				</datalist>
				<TextField
					id="audit-action"
					label="Action starts with"
					help={
						<Toggletip label="Action starts with">
							Actions are named for their area and then the event, such as
							workspace.start_requested or user.disabled. Type workspace. to see every
							workspace action.
						</Toggletip>
					}
					className="w-48"
					placeholder="workspace."
					data-testid="audit-filter-action"
					value={actionDraft}
					onChange={(event) => setActionDraft(event.target.value)}
				/>
				{/* mt-6 is LABEL_CLASS's 18 px line plus FIELD_CLASS's 6 px gap, so the
				    buttons line up with the inputs even when a field shows an error. */}
				<div className="mt-6 flex gap-2">
					<Button variant="primary" type="submit" data-testid="audit-filter-apply">
						Apply filters
					</Button>
					<Button type="button" data-testid="audit-filter-clear" onClick={clear}>
						Clear
					</Button>
				</div>
				{filters.workspace ? (
					<div
						className="flex basis-full items-center gap-2 pk-text-compact"
						data-testid="audit-filter-target"
					>
						<span className="min-w-0">
							Only events about{" "}
							{targetName ? (
								<strong className="font-semibold">{targetName}</strong>
							) : (
								<IdText full={filters.workspace} short={shortId(filters.workspace)} />
							)}
						</span>
						<Button
							size="sm"
							type="button"
							data-testid="audit-filter-target-remove"
							onClick={() => show({ ...filters, workspace: "" })}
						>
							Show all targets
						</Button>
					</div>
				) : null}
			</form>
			{/* Only the results re-key on new filters, so the focused form button stays. */}
			<AuditResults key={key} filters={filters} />
		</AdminSection>
	);
}

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
			{/* overflow-clip, not the wrap's overflow auto, so the header sticks to the scrolling <main> (SPEC.md section 20.1). */}
			<div className="pk-table-wrap overflow-clip">
				<table
					className="pk-table pk-table--page"
					data-testid="audit-table"
					aria-busy={page.isFetching}
				>
					<caption className="sr-only">
						Audit events, newest first, {events.length} shown
					</caption>
					<thead>
						<tr>
							<th scope="col">Time</th>
							<th scope="col">Actor</th>
							<th scope="col">Action</th>
							<th scope="col">Target</th>
							<th scope="col">
								<span className="inline-flex items-center gap-1">
									Result
									<Toggletip label="Result">
										ok and success mean it worked. denied means Portikus refused it, and
										failed means it was tried and did not work.
									</Toggletip>
								</span>
							</th>
							<th scope="col">Details</th>
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

function pageText(pageNumber: number, count: number): string {
	return `Page ${pageNumber}, ${count} ${count === 1 ? "event" : "events"}`;
}

/** The first 8 characters of a UUID, keeping a `user:` style prefix. */
export function shortId(value: string): string {
	const colon = value.indexOf(":");
	const prefix = colon === -1 ? "" : value.slice(0, colon + 1);
	const rest = value.slice(prefix.length);
	return UUID.test(rest) ? `${prefix}${rest.slice(0, 8)}` : value;
}

/** "ok" and "success" are neutral; every other result is shown as an error. */
export function resultTagClass(result: string): string {
	return result === "ok" || result === "success" ? "pk-tag" : "pk-tag pk-tag--error";
}

function detailText(value: unknown): string {
	return typeof value === "string" ? value : JSON.stringify(value);
}

function AuditRow({ event }: { event: AuditEvent }) {
	const metadata = Object.entries(event.metadata ?? {});
	const actorShort = shortId(event.actor);
	return (
		<tr className="align-top" data-testid={`audit-row-${event.id}`}>
			<td>
				<time dateTime={event.at} title={new Date(event.at).toLocaleString()}>
					<span aria-hidden="true">{shortTime(event.at)}</span>
					<span className="sr-only">{new Date(event.at).toLocaleString()}</span>
				</time>
			</td>
			<td title={event.actorName ? `${event.actorName}, ${event.actor}` : event.actor}>
				{event.actorName ? (
					<span className="block max-w-[24ch] truncate">{event.actorName}</span>
				) : (
					<IdText full={event.actor} short={actorShort} />
				)}
			</td>
			<td className="font-mono">{event.action}</td>
			<td>
				{UUID.test(event.target) ? (
					<span className="pk-cell-stack">
						<Link
							to="/admin/$tab"
							params={{ tab: "audit" }}
							search={{ workspace: event.target }}
							className={
								event.targetName
									? "pk-focus-ring block max-w-[24ch] truncate text-[var(--accent-text)] underline"
									: "pk-focus-ring pk-mono-small text-[var(--accent-text)] underline"
							}
							title={
								event.targetName ? `${event.targetName}, ${event.target}` : event.target
							}
							aria-label={`Show events for target ${event.targetName ? `${event.targetName}, ` : ""}${event.target}`}
							data-testid="audit-target-link"
						>
							{event.targetName ?? shortId(event.target)}
						</Link>
						{event.targetName ? (
							<span className="pk-cell-secondary pk-mono-small" aria-hidden="true">
								{shortId(event.target)}
							</span>
						) : null}
					</span>
				) : (
					<span className="pk-mono-small">{event.target}</span>
				)}
			</td>
			<td>
				<span className={resultTagClass(event.result)}>{event.result}</span>
			</td>
			<td>{metadata.length === 0 ? "—" : <AuditDetails metadata={metadata} />}</td>
		</tr>
	);
}

/** Values longer than this are clipped in the row, so the row offers a way to read them. */
const CLIPPED_AT = 48;

function DetailLines({
	metadata,
	clip,
}: {
	metadata: [string, unknown][];
	clip: boolean;
}) {
	return (
		<dl className="m-0 max-w-[48ch]">
			{metadata.map(([key, value]) => {
				const full = detailText(value);
				return (
					<div
						key={key}
						className={clip ? "truncate" : "whitespace-normal break-all"}
						title={clip ? `${key}: ${full}` : undefined}
					>
						{/* truncate only clips visually; screen readers get the whole value. */}
						<dt className="pk-muted inline">{key}:</dt>
						<dd className="m-0 ml-1 inline font-mono">{full}</dd>
					</div>
				);
			})}
		</dl>
	);
}

function AuditDetails({ metadata }: { metadata: [string, unknown][] }) {
	const long = metadata.some(([, value]) => detailText(value).length > CLIPPED_AT);
	if (!long) return <DetailLines metadata={metadata} clip />;
	return (
		<>
			<DetailLines metadata={metadata} clip />
			<details data-testid="audit-details-full">
				<summary className="pk-focus-ring cursor-pointer text-[var(--accent-text)]">
					Show full details
				</summary>
				<DetailLines metadata={metadata} clip={false} />
			</details>
		</>
	);
}

/** A shortened ID that screen readers still read in full. */
function IdText({ full, short }: { full: string; short: string }) {
	if (full === short) return <span className="pk-mono-small">{full}</span>;
	return (
		<span className="pk-mono-small">
			<span aria-hidden="true">{short}</span>
			<span className="sr-only">{full}</span>
		</span>
	);
}
