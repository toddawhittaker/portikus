import type { AdminUser, AuditEvent } from "@portikus/contracts";
import { Button, Icon, IconButton, TextField, Toggletip } from "@portikus/ui";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { ApiError } from "../../api/request.js";
import { UUID } from "../../links.js";
import { SortAnnouncement, useAnnouncedSort } from "../../table/announce.js";
import { revealFocused } from "../../table/revealFocus.js";
import { SortHeader } from "../../table/SortHeader.js";
import type { SortState } from "../../table/sort.js";
import { shortId, shortTime } from "../../text.js";
import { AdminSection } from "../AdminSection.js";
import { personLabel, personOptions, resolvePerson } from "../people.js";
import { useAdminUsers } from "../queries.js";
import { type AuditFilters, useAuditPage } from "./queries.js";
import "../logs/logs.css";
import "./audit.css";

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
	// Kept here, so paging and new filters keep the order.
	const { sort, setSort, announcement } = useAnnouncedSort(NEWEST_FIRST, TIME_LABEL);
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
				lead: "A record of every sign-in and every change to accounts, workspaces and settings, and who made it.",
				text: "Use it to find out who did something, and when.",
				helpAnchor: "admin-audit",
			}}
		>
			<form className="pk-logbar" onSubmit={apply}>
				<div className="pk-logbar-row">
					<TextField
						id="audit-person"
						label="Person"
						className="pk-logbar-search"
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
						className="w-56"
						placeholder="workspace."
						data-testid="audit-filter-action"
						value={actionDraft}
						onChange={(event) => setActionDraft(event.target.value)}
					/>
					{/* 26 px is LABEL_CLASS's 20 px line plus FIELD_CLASS's 6 px gap, so the
				    buttons line up with the inputs even when a field shows an error. */}
					<div className="pk-logbar-actions mt-[26px] self-start">
						<Button variant="primary" type="submit" data-testid="audit-filter-apply">
							Apply filters
						</Button>
						<Button type="button" data-testid="audit-filter-clear" onClick={clear}>
							Clear
						</Button>
					</div>
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
			<AuditResults key={key} filters={filters} sort={sort} setSort={setSort} />
			<SortAnnouncement text={announcement} testId="audit-sort-announce" />
		</AdminSection>
	);
}

/** The order the API pages in. */
const NEWEST_FIRST: SortState<"time"> = { column: "time", direction: "descending" };

const TIME_LABEL = { time: "Time" } as const;

/**
 * The table holds one page of 50 from a much longer history, so only Time
 * sorts: flipping a page's own order is honest, while sorting a page by
 * actor or action would read as the whole history's order. Filters do that job.
 */
function AuditResults({
	filters,
	sort,
	setSort,
}: {
	filters: AuditFilters;
	sort: SortState<"time">;
	setSort: (sort: SortState<"time">) => void;
}) {
	// The `before` cursor of every page shown so far; the last one is current.
	const [cursors, setCursors] = useState<(number | null)[]>([null]);
	const before = cursors[cursors.length - 1] ?? null;
	const page = useAuditPage(filters, before);

	const nextBefore = page.data?.nextBefore ?? null;
	// The API pages newest first, so oldest first is that order reversed; a sort by
	// timestamp would leave events in the same second newest first.
	const loaded = page.data?.events ?? [];
	const events = sort.direction === "descending" ? loaded : [...loaded].reverse();
	const atNewest = cursors.length < 2;
	const atOldest = nextBefore === null;
	// The event open in the inspector; it stays open across a refresh while the event is listed.
	const [selected, setSelected] = useState<number | null>(null);
	const selectedEvent = events.find((event) => event.id === selected);

	return (
		<>
			{page.isError ? (
				<p className="pk-error text-status-error" role="alert">
					{page.error instanceof ApiError
						? page.error.message
						: "Audit events could not be loaded."}
				</p>
			) : null}
			<div className="pk-workbench" data-inspecting={selectedEvent ? "" : undefined}>
				{/* overflow-clip, not the wrap's overflow auto, so the header sticks to the scrolling <main> (SPEC.md section 20.1). */}
				{/* A focusable region, so the keyboard can scroll a narrow box to columns with no control in them (SPEC.md section 25.8). */}
				<section
					className="pk-table-wrap overflow-clip"
					aria-labelledby="audit-table-caption"
					// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must take focus to scroll by keyboard
					tabIndex={0}
					onFocus={revealFocused}
				>
					<table
						className="pk-table"
						data-testid="audit-table"
						aria-busy={page.isFetching}
					>
						<caption id="audit-table-caption" className="sr-only">
							Audit events,{" "}
							{sort.direction === "descending" ? "newest first" : "oldest first"},{" "}
							{events.length} shown
						</caption>
						<thead>
							<tr>
								<SortHeader
									column="time"
									label={TIME_LABEL.time}
									sort={sort}
									onSort={setSort}
									first="descending"
								/>
								<th scope="col">Actor</th>
								<th scope="col">Event</th>
								<th scope="col">Target</th>
								<th scope="col">
									<span className="inline-flex items-center gap-1">
										Result
										<Toggletip label="Result">
											ok and success mean it worked. denied means Portikus refused it,
											and failed means it was tried and did not work.
										</Toggletip>
									</span>
								</th>
								<th scope="col">
									<span className="sr-only">Details</span>
								</th>
							</tr>
						</thead>
						<tbody>
							{events.map((event) => (
								<AuditRow
									key={event.id}
									event={event}
									open={event.id === selected}
									onToggle={() => setSelected(event.id === selected ? null : event.id)}
								/>
							))}
						</tbody>
					</table>
				</section>
				{selectedEvent ? (
					<AuditInspector event={selectedEvent} onClose={() => setSelected(null)} />
				) : null}
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

/**
 * An action as words: "workspace.quota_updated" reads "Workspace quota
 * updated". The raw name stays under it, as the filter matches on it.
 */
export function actionName(action: string): string {
	const words = action.split(/[._]+/).filter(Boolean).join(" ");
	return words ? words.charAt(0).toUpperCase() + words.slice(1) : action;
}

/** "ok" and "success" are neutral; every other result is shown as an error. */
export function resultTagClass(result: string): string {
	return result === "ok" || result === "success" ? "pk-tag" : "pk-tag pk-tag--error";
}

function detailText(value: unknown): string {
	return typeof value === "string" ? value : JSON.stringify(value);
}

function AuditRow({
	event,
	open,
	onToggle,
}: {
	event: AuditEvent;
	open: boolean;
	onToggle: () => void;
}) {
	const metadata = Object.entries(event.metadata ?? {});
	const actorShort = shortId(event.actor);
	const quiet = event.result === "ok" || event.result === "success";
	return (
		<tr
			className="pk-audit-row"
			data-testid={`audit-row-${event.id}`}
			data-result={quiet ? undefined : "problem"}
			aria-selected={open}
			onClick={(click) => {
				// The row is a larger target for its Details button; links and disclosures keep their own job.
				if ((click.target as HTMLElement).closest("a, button, summary, details"))
					return;
				onToggle();
			}}
		>
			<td className="pk-audit-time">
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
			<td className="pk-audit-event whitespace-normal">
				<span className="pk-audit-name">{actionName(event.action)}</span>
				<span className="pk-audit-meta">
					{metadata.length > 0 ? <ChangeSummary metadata={metadata} /> : null}
					<span className="pk-audit-code pk-mono-small">{event.action}</span>
				</span>
				{metadata.length > 0 ? <AuditDetails metadata={metadata} /> : null}
			</td>
			<td>
				<TargetCell event={event} />
			</td>
			<td>
				{quiet ? (
					// A success is the quiet case: a check and the word, so only failures carry a chip.
					<span className={resultTagClass(event.result)} data-quiet="">
						<Icon name="check" size="sm" />
						{event.result}
					</span>
				) : (
					<span className={resultTagClass(event.result)}>{event.result}</span>
				)}
			</td>
			<td className="pk-cell-actions">
				<IconButton
					icon="chevron-right"
					size="sm"
					label={`Event details, ${actionName(event.action)}, ${shortTime(event.at)}`}
					aria-expanded={open}
					aria-controls={open ? AUDIT_INSPECTOR_ID : undefined}
					className="pk-audit-open"
					onClick={onToggle}
				/>
			</td>
		</tr>
	);
}

function TargetCell({ event }: { event: AuditEvent }) {
	if (!UUID.test(event.target))
		return <span className="pk-mono-small">{event.target}</span>;
	return (
		<span className="pk-cell-stack">
			<Link
				to="/admin/$tab"
				params={{ tab: "audit" }}
				search={{ workspace: event.target }}
				className={
					event.targetName
						? "pk-focus-ring pk-entity-link block max-w-[24ch] truncate"
						: "pk-focus-ring pk-entity-link pk-mono-small"
				}
				title={event.targetName ? `${event.targetName}, ${event.target}` : event.target}
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
	);
}

/** A key as words without its unit: "homeGiB" reads "Home", "errorCode" reads "Error code". */
function keyLabel(key: string): string {
	const bare = key.replace(/(GiB|MiB|Percent|Ms)$/, "");
	const words = bare
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replace(/[._]+/g, " ")
		.trim()
		.toLowerCase();
	return words ? words.charAt(0).toUpperCase() + words.slice(1) : key;
}

/** The unit a key's name carries, written after its value. */
function unitOf(key: string): string {
	if (key.endsWith("GiB")) return " GiB";
	if (key.endsWith("MiB")) return " MiB";
	if (key.endsWith("Percent")) return "%";
	if (key.endsWith("Ms")) return " ms";
	return "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** One readable part of a change: a label, the old value when there is one, and the new value. */
interface ChangePart {
	label: string;
	from?: string;
	to: string;
}

/**
 * The event's details as short readable parts. A `from` and `to` pair of
 * objects becomes one part a field ("Home 5 → 10 GiB"); other fields read
 * as label and value. Long values stay whole here; the row clips them.
 */
export function changeParts(metadata: [string, unknown][]): ChangePart[] {
	const map = Object.fromEntries(metadata);
	const parts: ChangePart[] = [];
	const rest = metadata.filter(([key]) => key !== "from" && key !== "to");
	if ("to" in map) {
		const from = map.from;
		const to = map.to;
		if (isRecord(to)) {
			for (const [key, value] of Object.entries(to)) {
				const unit = unitOf(key);
				const was = isRecord(from) ? from[key] : undefined;
				parts.push({
					label: keyLabel(key),
					from: was === undefined ? undefined : detailText(was),
					to: `${detailText(value)}${unit}`,
				});
			}
		} else {
			parts.push({
				label: "Changed",
				from: from === undefined ? undefined : detailText(from),
				to: detailText(to),
			});
		}
	}
	for (const [key, value] of rest) {
		parts.push({ label: keyLabel(key), to: `${detailText(value)}${unitOf(key)}` });
	}
	return parts;
}

function ChangeSummary({ metadata }: { metadata: [string, unknown][] }) {
	return (
		<span className="pk-audit-summary">
			{changeParts(metadata).map((part) => (
				<span key={part.label} className="pk-audit-part">
					<span className="pk-audit-label">{part.label}</span>{" "}
					{part.from !== undefined ? (
						<>
							<span className="pk-audit-was">{part.from}</span>
							<span aria-hidden="true"> → </span>
							<span className="sr-only"> to </span>
						</>
					) : null}
					<span className="pk-audit-value">{part.to}</span>
				</span>
			))}
		</span>
	);
}

const AUDIT_INSPECTOR_ID = "audit-inspector";

/** One event in full beside the table: what happened, to whom, and the raw record. */
function AuditInspector({
	event,
	onClose,
}: {
	event: AuditEvent;
	onClose: () => void;
}) {
	const metadata = Object.entries(event.metadata ?? {});
	const quiet = event.result === "ok" || event.result === "success";
	return (
		<aside
			className="pk-inspector"
			id={AUDIT_INSPECTOR_ID}
			aria-label="Audit event"
			data-testid="audit-inspector"
		>
			<div className="pk-inspector-head">
				<div className="flex items-start gap-2">
					<div className="grid min-w-0 flex-1 gap-1">
						<p className="pk-overline">Audit event</p>
						<p className="m-0 font-semibold">{actionName(event.action)}</p>
					</div>
					<IconButton
						icon="x"
						label="Close event details"
						size="sm"
						onClick={onClose}
					/>
				</div>
				<p className="pk-muted m-0 text-[13px]">
					<time dateTime={event.at}>{new Date(event.at).toLocaleString()}</time>
				</p>
			</div>
			<div className="pk-inspector-body">
				<dl className="pk-kv">
					<dt>Result</dt>
					<dd>
						<span
							className={resultTagClass(event.result)}
							data-quiet={quiet ? "" : undefined}
						>
							{quiet ? <Icon name="check" size="sm" /> : null}
							{event.result}
						</span>
					</dd>
					<dt>Actor</dt>
					<dd className="grid">
						{event.actorName ? <span>{event.actorName}</span> : null}
						<span className="pk-mono-small break-all">{event.actor}</span>
					</dd>
					<dt>Target</dt>
					<dd className="grid">
						{event.targetName ? <span>{event.targetName}</span> : null}
						<span className="pk-mono-small break-all">{event.target}</span>
					</dd>
					<dt>Action</dt>
					<dd className="pk-mono-small break-all">{event.action}</dd>
				</dl>
				{metadata.length > 0 ? (
					<section className="grid gap-2" aria-labelledby="audit-inspector-raw">
						<h3 className="pk-overline" id="audit-inspector-raw">
							Recorded details
						</h3>
						{/* Plain text in <pre>: recorded values are never rendered as HTML. */}
						<pre className="pk-techdetail m-0 whitespace-pre-wrap break-all">
							{JSON.stringify(event.metadata, null, 2)}
						</pre>
					</section>
				) : null}
			</div>
		</aside>
	);
}

/** Values longer than this are clipped in the row, so the row offers a way to read them. */
const CLIPPED_AT = 48;

/** Every value in full, as recorded. */
function DetailLines({ metadata }: { metadata: [string, unknown][] }) {
	return (
		<dl className="m-0 w-80 max-w-full">
			{metadata.map(([key, value]) => (
				<div key={key} className="whitespace-normal wrap-anywhere">
					<dt className="pk-muted inline">{key}:</dt>
					<dd className="m-0 ml-1 inline font-mono text-[length:var(--text-sm)]">
						{detailText(value)}
					</dd>
				</div>
			))}
		</dl>
	);
}

/** A disclosure with every value in full, for a row whose summary clips a long one. */
function AuditDetails({ metadata }: { metadata: [string, unknown][] }) {
	const long = metadata.some(([, value]) => detailText(value).length > CLIPPED_AT);
	if (!long) return null;
	return (
		<details className="pk-audit-full group" data-testid="audit-details-full">
			<summary className="pk-focus-ring inline-flex cursor-pointer list-none items-center gap-1 [&::-webkit-details-marker]:hidden text-[var(--accent-text)]">
				<Icon
					name="chevron-right"
					size="sm"
					className="flex-none group-open:rotate-90"
				/>
				Show full details
			</summary>
			<DetailLines metadata={metadata} />
		</details>
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
