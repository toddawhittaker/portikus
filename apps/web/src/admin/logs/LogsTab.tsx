import {
	LOG_LEVELS,
	LOG_SERVICES,
	type LogLevel,
	type LogLine,
	type LogService,
} from "@portikus/contracts";
import { Button, Checkbox, Select, TextField } from "@portikus/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { ApiError } from "../../api/request.js";
import { UUID } from "../../links.js";
import { AdminSection } from "../AdminSection.js";
import { shortId } from "../audit/AuditTab.js";
import { shortTime } from "../shortTime.js";
import {
	DEFAULT_LEVELS,
	DEFAULT_WINDOW,
	filtersFromSearch,
	fromLocalInput,
	LOG_WINDOWS,
	type LogFilters,
	type LogWindow,
	searchFromFilters,
	toLocalInput,
	WINDOW_LABELS,
} from "./filters.js";
import { logPagesKey, useLogPages } from "./queries.js";

const LEVEL_LABELS: Record<LogLevel, string> = {
	error: "Error",
	warn: "Warn",
	info: "Info",
	debug: "Debug",
};

const SERVICE_LABELS: Record<LogService, string> = {
	api: "API",
	worker: "Worker",
	controller: "Controller",
};

/** The form's copy of the filters; times are `datetime-local` values. */
interface Draft {
	levels: LogLevel[];
	services: LogService[];
	window: LogWindow | "custom";
	from: string;
	to: string;
	q: string;
	user: string;
	workspace: string;
}

function draftOf(filters: LogFilters): Draft {
	const preset = LOG_WINDOWS.find((item) => item === filters.since);
	return {
		levels: filters.levels,
		services: filters.services,
		window: preset && !filters.until ? preset : "custom",
		from: preset ? "" : toLocalInput(filters.since),
		to: toLocalInput(filters.until),
		q: filters.q,
		user: filters.user,
		workspace: filters.workspace,
	};
}

function toggled<T>(list: readonly T[], item: T, on: boolean): T[] {
	return on ? [...list, item] : list.filter((value) => value !== item);
}

export const INVALID_ID_TEXT = "Enter a full ID, as shown in the detail panel.";

/**
 * The Logs tab (docs/EPIC-19.md rulings 31 to 36): the platform's own JSON
 * lines from the journal, filtered by the URL, newest first.
 */
export function LogsTab() {
	const search = useSearch({ strict: false }) as Record<string, unknown>;
	const filters = filtersFromSearch(search);
	const key = JSON.stringify(filters);
	const navigate = useNavigate();
	const [draft, setDraft] = useState(() => draftOf(filters));
	const [draftKey, setDraftKey] = useState(key);
	const [invalid, setInvalid] = useState<Record<string, string>>({});
	// A new link (a chart bar, "View logs") refills the form.
	if (draftKey !== key) {
		setDraftKey(key);
		setDraft(draftOf(filters));
	}

	function show(next: LogFilters) {
		void navigate({ to: "/admin", search: searchFromFilters(next) });
	}

	function apply(event: FormEvent) {
		event.preventDefault();
		const user = draft.user.trim();
		const workspace = draft.workspace.trim();
		const since = draft.window === "custom" ? fromLocalInput(draft.from) : draft.window;
		const until = draft.window === "custom" ? fromLocalInput(draft.to) : "";
		const errors: Record<string, string> = {};
		if (draft.levels.length === 0) errors.levels = "Choose at least one level.";
		if (user !== "" && !UUID.test(user)) errors.user = INVALID_ID_TEXT;
		if (workspace !== "" && !UUID.test(workspace)) errors.workspace = INVALID_ID_TEXT;
		if (draft.window === "custom" && since === "") errors.from = "Enter a start time.";
		if (since !== "" && until !== "" && !errors.from && since > until) {
			errors.to = "The end must not be before the start.";
		}
		setInvalid(errors);
		if (Object.keys(errors).length > 0) return;
		show({
			levels: draft.levels,
			services: draft.services,
			since,
			until,
			q: draft.q.trim(),
			user,
			workspace,
		});
	}

	function clear() {
		setInvalid({});
		show({
			levels: [...DEFAULT_LEVELS],
			services: [],
			since: DEFAULT_WINDOW,
			until: "",
			q: "",
			user: "",
			workspace: "",
		});
	}

	return (
		<AdminSection title="Logs">
			<form className="flex flex-col gap-4" onSubmit={apply} data-testid="logs-filters">
				<div className="flex flex-wrap gap-8">
					<fieldset
						className="m-0 flex flex-col gap-1.5 border-0 p-0"
						aria-describedby={invalid.levels ? "logs-levels-err" : undefined}
					>
						<legend className="pk-text-label mb-1.5 p-0">Levels</legend>
						<div className="flex flex-wrap gap-4">
							{LOG_LEVELS.map((level) => (
								<Checkbox
									key={level}
									label={LEVEL_LABELS[level]}
									checked={draft.levels.includes(level)}
									onChange={(event) =>
										setDraft({
											...draft,
											levels: toggled(draft.levels, level, event.target.checked),
										})
									}
								/>
							))}
						</div>
						{invalid.levels ? (
							<p id="logs-levels-err" className="pk-error m-0 text-status-error">
								{invalid.levels}
							</p>
						) : null}
					</fieldset>
					<fieldset className="m-0 flex flex-col gap-1.5 border-0 p-0">
						<legend className="pk-text-label mb-1.5 p-0">Services</legend>
						<div className="flex flex-wrap gap-4">
							{LOG_SERVICES.map((service) => (
								<Checkbox
									key={service}
									label={SERVICE_LABELS[service]}
									checked={
										draft.services.length === 0 || draft.services.includes(service)
									}
									onChange={(event) => {
										const current =
											draft.services.length === 0 ? [...LOG_SERVICES] : draft.services;
										setDraft({
											...draft,
											services: toggled(current, service, event.target.checked),
										});
									}}
								/>
							))}
						</div>
					</fieldset>
				</div>
				<p
					className="pk-text-body pk-muted m-0 text-[13px]"
					data-testid="logs-level-note"
				>
					Debug lines exist only while the log level on the Settings tab is Debug. Info
					lines exist unless it is Warn or Error.
				</p>
				<div className="pk-actions items-start">
					<div className="w-48">
						<Select
							id="logs-window"
							label="Time"
							value={draft.window}
							options={[
								...LOG_WINDOWS.map((window) => ({
									value: window,
									label: WINDOW_LABELS[window],
								})),
								{ value: "custom", label: "Custom" },
							]}
							onValueChange={(value) =>
								setDraft({ ...draft, window: value as Draft["window"] })
							}
						/>
					</div>
					{draft.window === "custom" ? (
						<>
							<TextField
								id="logs-from"
								label="From"
								type="datetime-local"
								className="w-56"
								value={draft.from}
								error={invalid.from}
								onChange={(event) => setDraft({ ...draft, from: event.target.value })}
							/>
							<TextField
								id="logs-to"
								label="To"
								type="datetime-local"
								className="w-56"
								hint="Leave empty for now."
								value={draft.to}
								error={invalid.to}
								onChange={(event) => setDraft({ ...draft, to: event.target.value })}
							/>
						</>
					) : null}
					<TextField
						id="logs-text"
						label="Text"
						className="w-64"
						maxLength={200}
						hint="Matches the code, message and error."
						value={draft.q}
						onChange={(event) => setDraft({ ...draft, q: event.target.value })}
					/>
					<TextField
						id="logs-user"
						label="User ID"
						className="w-80"
						value={draft.user}
						error={invalid.user}
						onChange={(event) => setDraft({ ...draft, user: event.target.value })}
					/>
					<TextField
						id="logs-workspace"
						label="Workspace ID"
						className="w-80"
						value={draft.workspace}
						error={invalid.workspace}
						onChange={(event) => setDraft({ ...draft, workspace: event.target.value })}
					/>
				</div>
				<div className="flex gap-2">
					<Button variant="primary" type="submit" data-testid="logs-filter-apply">
						Apply filters
					</Button>
					<Button type="button" data-testid="logs-filter-clear" onClick={clear}>
						Clear
					</Button>
				</div>
			</form>
			{/* Only the results re-key on new filters, so the focused form button stays. */}
			<LogResults key={key} filters={filters} />
		</AdminSection>
	);
}

/** The level as a word, so the tag never relies on colour. */
export function levelText(level: string): string {
	if (level === "fatal") return "Fatal";
	return LEVEL_LABELS[level as LogLevel] ?? level;
}

export function levelTagClass(level: string): string {
	if (level === "error" || level === "fatal") return "pk-tag pk-tag--error";
	if (level === "warn") return "pk-tag pk-tag--warning";
	return "pk-tag";
}

function field(line: Record<string, unknown>, name: string): string {
	const value = line[name];
	if (value === undefined || value === null) return "";
	return typeof value === "string" ? value : JSON.stringify(value);
}

/** The row's message: the error when there is one, else `msg`. */
export function messageOf(line: Record<string, unknown>): string {
	return field(line, "error") || field(line, "msg");
}

export function linesText(count: number, more: boolean): string {
	return `${count} ${count === 1 ? "line" : "lines"}${more ? ", older lines available" : ""}`;
}

function LogResults({ filters }: { filters: LogFilters }) {
	const pages = useLogPages(filters);
	const client = useQueryClient();
	const loaded = pages.data?.pages ?? [];
	const lines = loaded.flatMap((page) => page.lines);
	const last = loaded[loaded.length - 1];
	const skipped = loaded.reduce((sum, page) => sum + page.skippedLines, 0);
	const paused = loaded.length > 1;

	return (
		<>
			{pages.isError ? (
				<p className="pk-error text-status-error" role="alert" data-testid="logs-error">
					{pages.error instanceof ApiError
						? pages.error.message
						: "The logs could not be loaded."}
				</p>
			) : null}
			{/* overflow-clip keeps the header sticking to the scrolling <main> (SPEC.md section 20.1). */}
			<div className="pk-table-wrap overflow-clip">
				<table
					className="pk-table pk-table--page"
					data-testid="logs-table"
					aria-busy={pages.isFetching}
				>
					<caption className="sr-only">Log lines, newest first</caption>
					<thead>
						<tr>
							<th scope="col">
								<span className="sr-only">Full line</span>
							</th>
							<th scope="col">Time</th>
							<th scope="col">Level</th>
							<th scope="col">Service</th>
							<th scope="col">Code</th>
							<th scope="col">Message</th>
							<th scope="col">Route</th>
							<th scope="col" className="pk-num">
								Status
							</th>
							<th scope="col">User</th>
							<th scope="col">Workspace</th>
						</tr>
					</thead>
					<tbody>
						{lines.map((line) => (
							<LogRow key={line.cursor} line={line} />
						))}
					</tbody>
				</table>
			</div>
			{pages.isSuccess && lines.length === 0 ? (
				<p className="pk-text-body pk-muted" data-testid="logs-empty">
					No log lines match.
				</p>
			) : null}
			{last && !last.scanComplete ? (
				<p className="pk-text-body pk-muted m-0 text-[13px]" data-testid="logs-partial">
					The search stopped at its time limit before it read the whole range. Load
					older lines to keep searching.
				</p>
			) : null}
			{skipped > 0 ? (
				<p className="pk-text-body pk-muted m-0 text-[13px]" data-testid="logs-skipped">
					{skipped} journal {skipped === 1 ? "entry was" : "entries were"} not a
					Portikus log line, such as systemd's start and stop messages. Use journalctl
					on the VM to read them.
				</p>
			) : null}
			<div className="pk-actions items-center">
				{last?.nextCursor ? (
					<Button
						data-testid="logs-older"
						disabled={pages.isFetchingNextPage}
						onClick={() => void pages.fetchNextPage()}
					>
						Load older lines
					</Button>
				) : null}
				{paused ? (
					<Button
						data-testid="logs-refresh"
						onClick={() =>
							void client.resetQueries({ queryKey: logPagesKey(filters), exact: true })
						}
					>
						Refresh
					</Button>
				) : null}
				<span
					className="pk-text-compact pk-muted"
					role="status"
					data-testid="logs-count"
				>
					{pages.isSuccess ? linesText(lines.length, Boolean(last?.nextCursor)) : ""}
				</span>
			</div>
		</>
	);
}

/** A shortened ID that screen readers still read in full. */
function IdText({ id }: { id: string }) {
	const short = shortId(id);
	if (short === id) return <span className="pk-mono-small">{id}</span>;
	return (
		<span className="pk-mono-small" title={id}>
			<span aria-hidden="true">{short}</span>
			<span className="sr-only">{id}</span>
		</span>
	);
}

function LogRow({ line }: { line: LogLine }) {
	const [open, setOpen] = useState(false);
	const body = line.line;
	const level = field(body, "level");
	const userId = field(body, "userId");
	const workspaceId = field(body, "workspaceId") || field(body, "instance");
	const status = field(body, "status");
	const detailId = `log-line-${line.cursor.replace(/[^0-9a-z]/gi, "")}`;
	return (
		<>
			<tr className="align-top" data-testid="log-row">
				<td>
					<button
						type="button"
						className="pk-focus-ring cursor-pointer rounded-sm bg-transparent px-1 text-[var(--accent-text)]"
						aria-expanded={open}
						aria-controls={open ? detailId : undefined}
						aria-label={`Full line, ${shortTime(line.at)}`}
						data-testid="log-row-toggle"
						onClick={() => setOpen(!open)}
					>
						<span aria-hidden="true">{open ? "▾" : "▸"}</span>
					</button>
				</td>
				<td>
					<time dateTime={line.at} title={new Date(line.at).toLocaleString()}>
						<span aria-hidden="true">{shortTime(line.at)}</span>
						<span className="sr-only">{new Date(line.at).toLocaleString()}</span>
					</time>
				</td>
				<td>
					<span className={levelTagClass(level)} data-testid="log-level">
						{levelText(level)}
					</span>
				</td>
				<td>{SERVICE_LABELS[line.service]}</td>
				<td className="pk-mono-small">{field(body, "code")}</td>
				<td
					className="max-w-[48ch] whitespace-normal break-words"
					data-testid="log-message"
				>
					{messageOf(body)}
				</td>
				<td className="pk-mono-small">{field(body, "route")}</td>
				<td className="pk-num">{status}</td>
				<td>{line.userName ?? (userId ? <IdText id={userId} /> : "")}</td>
				<td>{workspaceId ? <IdText id={workspaceId} /> : ""}</td>
			</tr>
			{open ? (
				<tr id={detailId} data-testid="log-row-detail">
					<td colSpan={10}>
						{/* Plain text in <pre>: a log line is never rendered as HTML. */}
						<pre className="pk-techdetail m-0 whitespace-pre-wrap break-all">
							{JSON.stringify(body, null, 2)}
						</pre>
					</td>
				</tr>
			) : null}
		</>
	);
}
