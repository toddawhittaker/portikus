import {
	LOG_LEVELS,
	LOG_SERVICES,
	type LogLevel,
	LogLevel as LogLevelSchema,
	type LogLine,
	type LogService,
} from "@portikus/contracts";
import {
	Button,
	Checkbox,
	CONTROL_CLASS,
	FIELD_CLASS,
	LABEL_CLASS,
	TextField,
	Toggletip,
	useToast,
} from "@portikus/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { type FormEvent, Fragment, useEffect, useRef, useState } from "react";
import { ApiError } from "../../api/request.js";
import { AdminSection, focusAdminHeading } from "../AdminSection.js";
import { shortId } from "../audit/AuditTab.js";
import {
	personLabel,
	personOptions,
	resolvePerson,
	workspaceLabel,
} from "../people.js";
import {
	useAdminUsers,
	usePlatformSettings,
	useUpdatePlatformSettings,
} from "../queries.js";
import { errorText } from "../SettingsTab.js";
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
	/** What the Person field holds; null until the admin types, so it follows the URL. */
	person: string | null;
	/** Whether a workspace filter from a link stays on. */
	onlyWorkspace: boolean;
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
		person: null,
		onlyWorkspace: filters.workspace !== "",
	};
}

function toggled<T>(list: readonly T[], item: T, on: boolean): T[] {
	return on ? [...list, item] : list.filter((value) => value !== item);
}

/** The form's checked fields, in the order they appear. */
const FIELD_ORDER = ["levels", "from", "to", "person"] as const;
const FIELD_IDS: Record<Exclude<(typeof FIELD_ORDER)[number], "levels">, string> = {
	from: "logs-from",
	to: "logs-to",
	person: "logs-person",
};

/** Levels joined for a sentence: "Error or Warn", "Error, Warn or Info". */
function levelList(levels: readonly LogLevel[]): string {
	const words = LOG_LEVELS.filter((level) => levels.includes(level)).map(
		(level) => LEVEL_LABELS[level],
	);
	if (words.length <= 1) return words.join("");
	return `${words.slice(0, -1).join(", ")} or ${words.at(-1)}`;
}

/**
 * What an empty result says, once: what was searched, and what to widen
 * (docs/DESIGN.md section 5).
 */
export function emptyText(filters: LogFilters): string {
	const preset = LOG_WINDOWS.find((item) => item === filters.since);
	const time =
		preset && !filters.until
			? `in the ${WINDOW_LABELS[preset].replace(/^Last /, "last ")}`
			: "in this time range";
	const others =
		filters.q !== "" ||
		filters.user !== "" ||
		filters.workspace !== "" ||
		filters.services.length > 0;
	const head = `No lines ${time} at ${levelList(filters.levels)}${others ? " match the other filters" : ""}.`;
	const longer = Boolean(preset) && preset !== "7d" && !filters.until;
	const missing = LOG_LEVELS.find((level) => !filters.levels.includes(level));
	const include = missing ? LEVEL_LABELS[missing] : null;
	if (longer && include) return `${head} Try a longer time, or include ${include}.`;
	if (longer) return `${head} Try a longer time.`;
	if (include) return `${head} Try including ${include}.`;
	if (others) return `${head} Try removing a filter.`;
	return head;
}

/**
 * The Logs tab (SPEC.md section 24.11): the platform's own JSON
 * lines from the journal, filtered by the URL, newest first.
 */
export function LogsTab() {
	const search = useSearch({ strict: false }) as Record<string, unknown>;
	const filters = filtersFromSearch(search);
	const key = JSON.stringify(filters);
	const navigate = useNavigate();
	const users = useAdminUsers();
	const userList = users.data?.users ?? [];
	const people = personOptions(userList);
	const [draft, setDraft] = useState(() => draftOf(filters));
	const [draftKey, setDraftKey] = useState(key);
	const [invalid, setInvalid] = useState<Record<string, string>>({});
	// Kept here, not in the results, so a new filter does not reset it.
	const [auto, setAuto] = useState(true);
	const formRef = useRef<HTMLFormElement>(null);
	// A new link (a chart bar, "View logs") refills the form.
	if (draftKey !== key) {
		setDraftKey(key);
		setDraft(draftOf(filters));
	}
	const personText =
		draft.person ?? (filters.user ? personLabel(people, filters.user) : "");

	function show(next: LogFilters) {
		void navigate({ to: "/admin", search: searchFromFilters(next) });
	}

	function apply(event: FormEvent) {
		event.preventDefault();
		const person =
			draft.person === null
				? { id: filters.user }
				: resolvePerson(draft.person, users.data?.users);
		const since = draft.window === "custom" ? fromLocalInput(draft.from) : draft.window;
		const until = draft.window === "custom" ? fromLocalInput(draft.to) : "";
		const errors: Record<string, string> = {};
		if (draft.levels.length === 0) errors.levels = "Choose at least one level.";
		if ("error" in person) errors.person = person.error;
		if (draft.window === "custom" && since === "") errors.from = "Enter a start time.";
		if (since !== "" && until !== "" && !errors.from && since > until) {
			errors.to = "The end must not be before the start.";
		}
		setInvalid(errors);
		const first = FIELD_ORDER.find((name) => errors[name]);
		if (first || "error" in person) {
			// Focus the first bad field so a screen reader hears its error.
			const target =
				first === "levels"
					? formRef.current?.querySelector<HTMLElement>("[data-level-checks] input")
					: document.getElementById(FIELD_IDS[first ?? "person"]);
			// Focusing the field that already has focus says nothing, so leave it first.
			if (target && target === document.activeElement) target.blur();
			target?.focus();
			return;
		}
		show({
			levels: draft.levels,
			services: draft.services,
			since,
			until,
			q: draft.q.trim(),
			user: person.id,
			workspace: draft.onlyWorkspace ? filters.workspace : "",
		});
	}

	function clear() {
		const cleared: LogFilters = {
			levels: [...DEFAULT_LEVELS],
			services: [],
			since: DEFAULT_WINDOW,
			until: "",
			q: "",
			user: "",
			workspace: "",
		};
		setInvalid({});
		// Also reset here: when the URL is already clear, nothing else refills the form.
		setDraft(draftOf(cleared));
		show(cleared);
	}

	return (
		<AdminSection
			title="Logs"
			intro={{
				id: "admin-logs",
				helpAnchor: "admin-logs",
				text: "The platform's own error, warning, info and debug lines. They never include students' files, commands or terminal output.",
			}}
		>
			<ServiceLogLevel />
			<form ref={formRef} onSubmit={apply} data-testid="logs-filters" noValidate>
				<fieldset className="m-0 flex min-w-0 flex-wrap items-end gap-x-6 gap-y-4 rounded-md border-0 bg-surface-sunken p-4">
					<legend className="sr-only">Filters</legend>
					<fieldset
						className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0"
						// Named by the word alone, not also by its help button.
						aria-labelledby="logs-levels-label"
						aria-describedby={invalid.levels ? "logs-levels-err" : undefined}
					>
						<legend className="mb-1.5 p-0">
							<span className="flex items-center gap-1">
								<span className={LABEL_CLASS} id="logs-levels-label">
									Levels
								</span>
								<Toggletip label="Levels">
									Debug lines exist only while the service log level is Debug. Info
									lines exist unless it is Warn or Error.
								</Toggletip>
							</span>
						</legend>
						<div
							className="flex h-[var(--pk-control)] flex-wrap items-center gap-4"
							data-level-checks
						>
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
							<p
								id="logs-levels-err"
								className="pk-error m-0 text-[12px] leading-4 text-status-error"
							>
								{invalid.levels}
							</p>
						) : null}
					</fieldset>
					<fieldset
						className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0"
						aria-labelledby="logs-services-label"
					>
						<legend className="mb-1.5 p-0">
							<span className="flex items-center gap-1">
								<span className={LABEL_CLASS} id="logs-services-label">
									Services
								</span>
								<Toggletip label="Services">
									API answers the browser's requests. Worker runs the background jobs:
									starting, stopping and rebuilding workspaces, the resource guard and
									health samples. Controller talks to the host that runs the workspaces.
								</Toggletip>
							</span>
						</legend>
						<div className="flex h-[var(--pk-control)] flex-wrap items-center gap-4">
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
					{/* A native select, as in the Users filter bar (ruling S18). */}
					<div className={FIELD_CLASS}>
						<label className={LABEL_CLASS} htmlFor="logs-window">
							Time
						</label>
						<select
							id="logs-window"
							className={`${CONTROL_CLASS} w-40 cursor-pointer`}
							data-testid="logs-window"
							value={draft.window}
							onChange={(event) =>
								setDraft({ ...draft, window: event.target.value as Draft["window"] })
							}
						>
							{LOG_WINDOWS.map((window) => (
								<option key={window} value={window}>
									{WINDOW_LABELS[window]}
								</option>
							))}
							<option value="custom">Custom</option>
						</select>
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
						type="search"
						className="w-56"
						maxLength={200}
						placeholder="Code, message or error"
						value={draft.q}
						onChange={(event) => setDraft({ ...draft, q: event.target.value })}
					/>
					<TextField
						id="logs-person"
						label="Person"
						type="search"
						className="w-56"
						list="logs-people"
						autoComplete="off"
						placeholder="Name or email"
						value={personText}
						error={invalid.person}
						onChange={(event) => setDraft({ ...draft, person: event.target.value })}
					/>
					<datalist id="logs-people">
						{people.map((option) => (
							<option key={option.id} value={option.label} />
						))}
					</datalist>
					{filters.workspace ? (
						<div className="flex h-[var(--pk-control)] items-center">
							<Checkbox
								label={workspaceLabel(people, filters.workspace)}
								checked={draft.onlyWorkspace}
								onChange={(event) =>
									setDraft({ ...draft, onlyWorkspace: event.target.checked })
								}
							/>
						</div>
					) : null}
					<div className="pk-actions ml-auto">
						<Button variant="primary" type="submit" data-testid="logs-filter-apply">
							Apply filters
						</Button>
						<Button type="button" data-testid="logs-filter-clear" onClick={clear}>
							Clear
						</Button>
					</div>
				</fieldset>
			</form>
			{/* Only the results re-key on new filters, so the focused form button stays. */}
			<LogResults key={key} filters={filters} auto={auto} setAuto={setAuto} />
		</AdminSection>
	);
}

/** The value the select uses for "no override"; the API takes null. */
const SERVICE_DEFAULT = "default";

/**
 * The runtime log level every service follows (ADR 0012). "Use service
 * default" clears the override, so each service falls back to its own
 * LOG_LEVEL from the environment. It sits here, beside the lines it
 * decides, rather than on the Settings tab.
 */
function ServiceLogLevel() {
	const settings = usePlatformSettings();
	const update = useUpdatePlatformSettings();
	const toast = useToast();
	const [draft, setDraft] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	const saved = settings.data?.logLevel ?? null;
	const value = draft ?? (saved === null ? SERVICE_DEFAULT : saved);

	function save(event: FormEvent) {
		event.preventDefault();
		setError(null);
		const parsed = LogLevelSchema.safeParse(value);
		update.mutate(
			{ logLevel: parsed.success ? parsed.data : null },
			{
				onSuccess: () => {
					setDraft(null);
					toast.show({ tone: "success", title: "Log level saved" });
				},
				onError: (failure) => setError(errorText(failure)),
			},
		);
	}

	return (
		<form
			className="flex flex-col gap-1.5"
			onSubmit={save}
			data-testid="log-level-form"
		>
			<div className="flex flex-wrap items-center gap-2">
				<span className="flex items-center gap-1">
					<label className={LABEL_CLASS} htmlFor="log-level">
						Services log at
					</label>
					<Toggletip label="Service log level">
						How much every service writes. Service default uses each service's own
						setting. Debug fills the journal quickly, so turn it back down when you are
						done.
					</Toggletip>
				</span>
				<div className="w-48">
					<select
						id="log-level"
						className={`${CONTROL_CLASS} cursor-pointer disabled:border-line disabled:bg-surface-sunken disabled:text-ink-faint`}
						data-testid="log-level-select"
						value={value}
						disabled={settings.isLoading}
						aria-invalid={error ? true : undefined}
						aria-describedby={error ? "log-level-err" : undefined}
						onChange={(event) => setDraft(event.target.value)}
					>
						<option value={SERVICE_DEFAULT}>Service default</option>
						{LogLevelSchema.options.map((level) => (
							<option key={level} value={level}>
								{LEVEL_LABELS[level]}
							</option>
						))}
					</select>
				</div>
				<Button type="submit" data-testid="log-level-save" loading={update.isPending}>
					Save
				</Button>
			</div>
			{error ? (
				<p
					className="pk-error m-0 text-[12px] leading-4 text-status-error"
					id="log-level-err"
					role="alert"
				>
					{error}
				</p>
			) : null}
		</form>
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

/** The visible note on automatic refresh (WCAG 2.2.2). */
export function refreshNote(auto: boolean, paused: boolean): string {
	if (paused) return "Automatic refresh is paused while older lines are shown.";
	return auto ? "Refreshes every 30 seconds." : "Automatic refresh is off.";
}

/** The note under a scan that stopped at its time limit. */
export function partialText(canContinue: boolean): string {
	return canContinue
		? "The search stopped at its time limit before it read the whole range. Load older lines to keep searching."
		: "The search stopped at its time limit before it found a line. Narrow the time range and try again.";
}

function LogResults({
	filters,
	auto,
	setAuto,
}: {
	filters: LogFilters;
	auto: boolean;
	setAuto: (auto: boolean) => void;
}) {
	const pages = useLogPages(filters, auto);
	const client = useQueryClient();
	const loaded = pages.data?.pages ?? [];
	const lines = loaded.flatMap((page) => page.lines);
	const last = loaded[loaded.length - 1];
	const skipped = loaded.reduce((sum, page) => sum + page.skippedLines, 0);
	const paused = loaded.length > 1;
	const tableRef = useRef<HTMLTableElement>(null);
	const countRef = useRef<HTMLSpanElement>(null);
	// Where focus goes once "Load older lines" finishes: the first new row.
	const firstNewRow = useRef<number | null>(null);
	// The count is announced after the admin acts, not after each auto refresh.
	const announceNext = useRef(true);
	const [announcement, setAnnouncement] = useState("");
	const settled = pages.isSuccess && !pages.isFetching;
	const empty = pages.isSuccess && lines.length === 0;
	// An empty, finished search says so once, in the empty line, not also as "0 lines".
	const emptyMessage = empty && last?.scanComplete ? emptyText(filters) : "";
	const countText =
		pages.isSuccess && !empty ? linesText(lines.length, Boolean(last?.nextCursor)) : "";
	const announceText = countText || emptyMessage;

	useEffect(() => {
		if (!settled) return;
		if (announceNext.current) {
			announceNext.current = false;
			setAnnouncement(announceText);
		}
		const index = firstNewRow.current;
		if (index === null) return;
		firstNewRow.current = null;
		// The button stays (and keeps focus) while there are older lines.
		if (last?.nextCursor) return;
		const toggles = tableRef.current?.querySelectorAll<HTMLElement>(
			"[data-testid=log-row-toggle]",
		);
		(toggles?.[index] ?? countRef.current)?.focus();
	}, [settled, announceText, last?.nextCursor]);

	function loadOlder() {
		firstNewRow.current = lines.length;
		announceNext.current = true;
		void pages.fetchNextPage();
	}

	function refresh() {
		announceNext.current = true;
		// Cleared first, so an unchanged count is still announced.
		setAnnouncement("");
		void client.resetQueries({ queryKey: logPagesKey(filters), exact: true });
		// Refresh leaves once the list starts over, so the heading takes focus.
		focusAdminHeading();
	}

	return (
		<>
			{pages.isError ? (
				<p className="pk-error text-status-error" role="alert" data-testid="logs-error">
					{pages.error instanceof ApiError
						? pages.error.message
						: "The logs could not be loaded."}
				</p>
			) : null}
			<div className="pk-actions items-center">
				<Button
					size="sm"
					aria-pressed={auto}
					data-testid="logs-auto-refresh"
					onClick={() => setAuto(!auto)}
				>
					Auto refresh
				</Button>
				<span className="pk-text-compact pk-muted" data-testid="logs-refresh-note">
					{refreshNote(auto, paused)}
				</span>
			</div>
			{/* No header row over nothing: an empty result is one line of text. overflow-clip
			    keeps the header sticking to the scrolling <main> (SPEC.md section 20.1). */}
			{empty ? null : (
				<div className="pk-table-wrap overflow-clip">
					<table
						ref={tableRef}
						className="pk-table pk-table--page"
						data-testid="logs-table"
						aria-busy={pages.isLoading}
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
			)}
			{emptyMessage ? (
				<p className="pk-text-body pk-muted m-0" data-testid="logs-empty">
					{emptyMessage}
				</p>
			) : null}
			{last && !last.scanComplete ? (
				<p className="pk-text-body pk-muted m-0 text-[13px]" data-testid="logs-partial">
					{partialText(Boolean(last.nextCursor))}
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
						loading={pages.isFetchingNextPage}
						onClick={loadOlder}
					>
						Load older lines
					</Button>
				) : null}
				{paused ? (
					<Button data-testid="logs-refresh" onClick={refresh}>
						Refresh
					</Button>
				) : null}
				<span
					ref={countRef}
					tabIndex={-1}
					className="pk-text-compact pk-muted"
					data-testid="logs-count"
				>
					{countText}
				</span>
				<span className="sr-only" role="status" data-testid="logs-announce">
					{announcement}
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

/** A route that may break before each slash, and nowhere else. */
function RouteText({ route }: { route: string }) {
	return route.split("/").map((part, index) => (
		// biome-ignore lint/suspicious/noArrayIndexKey: the segments of one fixed string never move.
		<Fragment key={index}>
			{index > 0 ? (
				<>
					<wbr />/
				</>
			) : null}
			{part}
		</Fragment>
	));
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
						className="pk-focus-ring inline-flex min-h-6 min-w-6 cursor-pointer items-center justify-center rounded-sm bg-transparent text-[var(--accent-text)]"
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
				{/* The inner min width keeps a narrow table from squeezing the message to one
				    word a line; the route wraps at its slashes instead (SPEC.md section 24.11). */}
				<td className="whitespace-normal" data-testid="log-message">
					<div className="min-w-[24ch] max-w-[48ch] break-words">{messageOf(body)}</div>
				</td>
				<td className="pk-mono-small whitespace-normal" data-testid="log-route">
					<RouteText route={field(body, "route")} />
				</td>
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
