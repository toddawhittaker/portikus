import type { LogLine } from "@portikus/contracts";
import { Badge, Button, Icon, IconButton } from "@portikus/ui";
import { useQueryClient } from "@tanstack/react-query";
import { Fragment, type ReactNode, useEffect, useRef, useState } from "react";
import { ApiError } from "../../api/request.js";
import { revealFocused } from "../../table/revealFocus.js";
import { SortHeader } from "../../table/SortHeader.js";
import { type SortState, sortText } from "../../table/sort.js";
import { shortId, shortTime } from "../../text.js";
import { focusAdminHeading } from "../AdminSection.js";
import { emptyText, type LogFilters } from "./filters.js";
import {
	clockTime,
	dayLabel,
	field,
	levelText,
	levelTone,
	SERVICE_LABELS,
	statusClass,
} from "./line.js";
import { logPagesKey, useLogPages } from "./queries.js";
import { lineSummary } from "./summary.js";
import "./logs.css";
import {
	DEFAULT_LOG_SORT,
	LOG_COLUMN_FIRST,
	LOG_COLUMN_LABEL,
	type LogColumn,
	sortLogLines,
} from "./sort.js";

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

/** The caption: what the table holds and, away from newest first, how it is sorted. */
export function logsCaption(sort: SortState<LogColumn>): string {
	if (
		sort.column === DEFAULT_LOG_SORT.column &&
		sort.direction === DEFAULT_LOG_SORT.direction
	) {
		return "Log lines, newest first";
	}
	return `Loaded log lines, ${sortText(LOG_COLUMN_LABEL[sort.column], sort.direction)}`;
}

/** The sortable columns before Message, in table order. */
const LEADING: readonly LogColumn[] = ["time", "level", "service"];

export function LogResults({
	filters,
	auto,
	setAuto,
	sort,
	setSort,
	settings,
}: {
	filters: LogFilters;
	auto: boolean;
	setAuto: (auto: boolean) => void;
	sort: SortState<LogColumn>;
	setSort: (sort: SortState<LogColumn>) => void;
	/** The service log level, at the end of the results toolbar. */
	settings?: ReactNode;
}) {
	const pages = useLogPages(filters, auto);
	const client = useQueryClient();
	const loaded = pages.data?.pages ?? [];
	const lines = loaded.flatMap((page) => page.lines);
	const shown = sortLogLines(lines, sort);
	const last = loaded[loaded.length - 1];
	const skipped = loaded.reduce((sum, page) => sum + page.skippedLines, 0);
	const paused = loaded.length > 1;
	const tableRef = useRef<HTMLTableElement>(null);
	const countRef = useRef<HTMLSpanElement>(null);
	// How many lines were loaded when "Load older lines" was pressed; the next one gets focus.
	const firstNewLine = useRef<number | null>(null);
	// The count is announced after the admin acts, not after each auto refresh.
	const announceNext = useRef(true);
	const [announcement, setAnnouncement] = useState("");
	// The line open in the inspector, by its journal cursor.
	const [selected, setSelected] = useState<string | null>(null);
	const selectedLine = selected
		? lines.find((line) => line.cursor === selected)
		: undefined;
	const settled = pages.isSuccess && !pages.isFetching;
	const empty = pages.isSuccess && lines.length === 0;
	// An empty, finished search says so once, in the empty line, not also as "0 lines".
	const emptyMessage = empty && last?.scanComplete ? emptyText(filters) : "";
	const countText =
		pages.isSuccess && !empty ? linesText(lines.length, Boolean(last?.nextCursor)) : "";
	const announceText = countText || emptyMessage;
	// A column empty on every loaded line is left out, so Message gets the width.
	const columns = shownColumns(lines);
	// Each row knows its place in the journal's order, so the first new line is found whatever the sort.
	const journalIndex = new Map(lines.map((line, index) => [line.cursor, index]));

	useEffect(() => {
		if (!settled) return;
		if (announceNext.current) {
			announceNext.current = false;
			setAnnouncement(announceText);
		}
		const index = firstNewLine.current;
		if (index === null) return;
		firstNewLine.current = null;
		// The button stays (and keeps focus) while there are older lines.
		if (last?.nextCursor) return;
		const toggle = tableRef.current?.querySelector<HTMLElement>(
			`[data-journal-index="${index}"]`,
		);
		(toggle ?? countRef.current)?.focus();
	}, [settled, announceText, last?.nextCursor]);

	function loadOlder() {
		firstNewLine.current = lines.length;
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

	const header = (column: LogColumn, className?: string) => (
		<SortHeader
			key={column}
			column={column}
			label={LOG_COLUMN_LABEL[column]}
			sort={sort}
			onSort={setSort}
			first={LOG_COLUMN_FIRST[column]}
			className={className}
		/>
	);

	return (
		<>
			{pages.isError ? (
				<p className="pk-error text-status-error" role="alert" data-testid="logs-error">
					{pages.error instanceof ApiError
						? pages.error.message
						: "The logs could not be loaded."}
				</p>
			) : null}
			<div className="pk-logs-toolbar">
				<LiveToggle auto={auto} paused={paused} setAuto={setAuto} />
				{/* The count again above the list, so it is in view before a long scroll. */}
				{countText ? (
					<span
						className="pk-text-compact pk-muted pk-logs-count-top"
						aria-hidden="true"
					>
						{countText}
					</span>
				) : null}
				{settings}
			</div>
			{/* No header row over nothing: an empty result is one line of text. overflow-clip
			    keeps the header sticking to the scrolling <main> (SPEC.md section 20.1). */}
			{empty ? null : (
				<div className="pk-workbench" data-inspecting={selectedLine ? "" : undefined}>
					{/* A focusable region, so the keyboard can scroll a narrow box to columns with no control in them (SPEC.md section 25.8). */}
					<section
						className="pk-table-wrap pk-log-wrap overflow-clip"
						aria-labelledby="logs-table-caption"
						// biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must take focus to scroll by keyboard
						tabIndex={0}
						onFocus={revealFocused}
					>
						<table
							ref={tableRef}
							className="pk-table pk-log-table"
							data-testid="logs-table"
							aria-busy={pages.isLoading}
						>
							<caption id="logs-table-caption" className="sr-only">
								{logsCaption(sort)}
							</caption>
							<thead>
								<tr>
									<th scope="col">
										<span className="sr-only">Full line</span>
									</th>
									{LEADING.map((column) => header(column))}
									<th scope="col">Message</th>
									{columns.status ? header("status", "pk-num") : null}
									{columns.user ? (
										<th scope="col" className="pk-log-user">
											User
										</th>
									) : null}
									{columns.workspace ? (
										<th scope="col" className="pk-log-workspace">
											Workspace
										</th>
									) : null}
								</tr>
							</thead>
							<tbody>
								{shown.map((line) => (
									<LogRow
										key={line.cursor}
										line={line}
										journalIndex={journalIndex.get(line.cursor) ?? 0}
										columns={columns}
										open={line.cursor === selected}
										onToggle={() =>
											setSelected(line.cursor === selected ? null : line.cursor)
										}
									/>
								))}
							</tbody>
						</table>
					</section>
					{selectedLine ? (
						<LogInspector line={selectedLine} onClose={() => setSelected(null)} />
					) : null}
				</div>
			)}
			{emptyMessage ? (
				<p className="pk-text-body pk-muted m-0" data-testid="logs-empty">
					{emptyMessage}
				</p>
			) : null}
			<LogNotes
				partial={last ? !last.scanComplete : false}
				canContinue={Boolean(last?.nextCursor)}
				skipped={skipped}
			/>
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

/** Auto refresh as a live signal, with the visible note on what it does (WCAG 2.2.2). */
function LiveToggle({
	auto,
	paused,
	setAuto,
}: {
	auto: boolean;
	paused: boolean;
	setAuto: (auto: boolean) => void;
}) {
	return (
		<div className="pk-logs-live">
			<Button
				size="sm"
				className="pk-live-toggle"
				aria-pressed={auto}
				data-live={auto && !paused ? "" : undefined}
				data-testid="logs-auto-refresh"
				onClick={() => setAuto(!auto)}
			>
				<span className="pk-live-dot" aria-hidden={true} />
				Auto refresh
			</Button>
			<span className="pk-text-compact pk-muted" data-testid="logs-refresh-note">
				{refreshNote(auto, paused)}
			</span>
		</div>
	);
}

/** What the search could not cover: a scan cut short, or journal entries that were not log lines. */
function LogNotes({
	partial,
	canContinue,
	skipped,
}: {
	partial: boolean;
	canContinue: boolean;
	skipped: number;
}) {
	return (
		<>
			{partial ? (
				<p className="pk-text-body pk-muted m-0 text-[13px]" data-testid="logs-partial">
					{partialText(canContinue)}
				</p>
			) : null}
			{skipped > 0 ? (
				<p className="pk-text-body pk-muted m-0 text-[13px]" data-testid="logs-skipped">
					{skipped} journal {skipped === 1 ? "entry was" : "entries were"} not a
					Portikus log line, such as systemd's start and stop messages. Use journalctl
					on the VM to read them.
				</p>
			) : null}
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

type OptionalColumns = Record<"status" | "user" | "workspace", boolean>;

function workspaceOf(body: Record<string, unknown>): string {
	return field(body, "workspaceId") || field(body, "instance");
}

/** Which optional columns carry something on at least one line. */
export function shownColumns(lines: readonly LogLine[]): OptionalColumns {
	const has = (pick: (line: LogLine) => unknown) =>
		lines.some((line) => Boolean(pick(line)));
	return {
		status: has((line) => field(line.line, "status")),
		user: has((line) => line.userName ?? field(line.line, "userId")),
		workspace: has(
			(line) => workspaceOf(line.line) || field(line.line, "workspaceAddress"),
		),
	};
}

function LogRow({
	line,
	journalIndex,
	columns,
	open,
	onToggle,
}: {
	line: LogLine;
	journalIndex: number;
	columns: OptionalColumns;
	open: boolean;
	onToggle: () => void;
}) {
	const body = line.line;
	const level = field(body, "level");
	const userId = field(body, "userId");
	const workspaceId = workspaceOf(body);
	const status = field(body, "status");
	const route = field(body, "route");
	const method = field(body, "method");
	const code = field(body, "code");
	const day = dayLabel(line.at);
	return (
		<tr
			className="pk-log-row"
			data-testid="log-row"
			data-level={level}
			aria-selected={open}
			onClick={(event) => {
				// The row is a larger target for its own toggle; a click on a control inside keeps its own job.
				if ((event.target as HTMLElement).closest("button, a")) return;
				onToggle();
			}}
		>
			<td>
				<button
					type="button"
					data-journal-index={journalIndex}
					className="pk-log-toggle pk-focus-ring inline-flex min-h-6 min-w-6 cursor-pointer items-center justify-center rounded-sm bg-transparent text-[var(--accent-text)]"
					aria-expanded={open}
					aria-controls={open ? LOG_INSPECTOR_ID : undefined}
					aria-label={`Full line, ${shortTime(line.at)}`}
					data-testid="log-row-toggle"
					onClick={onToggle}
				>
					<Icon name="chevron-right" size="sm" />
				</button>
			</td>
			<td className="pk-log-time">
				<time dateTime={line.at} title={new Date(line.at).toLocaleString()}>
					<span aria-hidden="true">
						{day ? <span className="pk-log-day">{day} </span> : null}
						{clockTime(line.at)}
					</span>
					<span className="sr-only">{new Date(line.at).toLocaleString()}</span>
				</time>
			</td>
			<td>
				<LevelMark level={level} />
			</td>
			<td className="pk-log-service">{SERVICE_LABELS[line.service]}</td>
			{/* The inner min width keeps a narrow table from squeezing the message to one
			    word a line; the route under it wraps at its slashes (SPEC.md section 24.11). */}
			<td className="pk-log-message whitespace-normal">
				<div
					className="min-w-[22ch] max-w-[72ch] break-words"
					data-testid="log-message"
				>
					{lineSummary(body)}
				</div>
				{route || code ? (
					<div className="pk-log-source">
						{route ? (
							<span>
								{method ? `${method} ` : null}
								<span data-testid="log-route">
									<RouteText route={route} />
								</span>
							</span>
						) : null}
						{code ? <span className="pk-log-code">{code}</span> : null}
					</div>
				) : null}
			</td>
			{columns.status ? (
				<td className="pk-num">
					<span className={statusClass(status)}>{status}</span>
				</td>
			) : null}
			{columns.user ? (
				<td className="pk-log-user">
					{line.userName ?? (userId ? <IdText id={userId} /> : "")}
				</td>
			) : null}
			{columns.workspace ? (
				<td className="pk-log-workspace">
					{workspaceId ? (
						<IdText id={workspaceId} />
					) : (
						<span className="pk-mono-small">{field(body, "workspaceAddress")}</span>
					)}
				</td>
			) : null}
		</tr>
	);
}

/** Warn and Error are badges; Info and Debug are a quiet word, so problems stand out. */
function LevelMark({ level }: { level: string }) {
	const tone = levelTone(level);
	if (tone === "neutral") {
		return (
			<span className="pk-log-level-word" data-testid="log-level">
				{levelText(level)}
			</span>
		);
	}
	return (
		<Badge tone={tone} data-testid="log-level">
			{levelText(level)}
		</Badge>
	);
}

const LOG_INSPECTOR_ID = "log-inspector";

/** The fields the inspector names first, in this order; the rest follow as the line has them. */
const LEAD_FIELDS = [
	"code",
	"route",
	"method",
	"status",
	"durationMs",
	"requestId",
] as const;

/** One line in full beside the table: its message, its fields, and the raw JSON. */
function LogInspector({ line, onClose }: { line: LogLine; onClose: () => void }) {
	const body = line.line;
	const level = field(body, "level");
	const leading = LEAD_FIELDS.filter((name) => field(body, name) !== "");
	const userId = field(body, "userId");
	const workspace = workspaceOf(body) || field(body, "workspaceAddress");
	return (
		<aside
			className="pk-inspector"
			id={LOG_INSPECTOR_ID}
			aria-label="Log line"
			data-testid="log-row-detail"
		>
			<div className="pk-inspector-head">
				<div className="flex items-start gap-2">
					<div className="grid min-w-0 flex-1 gap-1">
						<p className="pk-overline">
							{SERVICE_LABELS[line.service]} · {levelText(level)}
						</p>
						<p className="m-0 break-words font-semibold">{lineSummary(body)}</p>
					</div>
					<IconButton icon="x" label="Close log line" size="sm" onClick={onClose} />
				</div>
				<p className="pk-muted m-0 text-[13px]">
					<time dateTime={line.at}>{new Date(line.at).toLocaleString()}</time>
				</p>
			</div>
			<div className="pk-inspector-body">
				<dl className="pk-kv">
					<dt>Level</dt>
					<dd>
						<LevelMark level={level} />
					</dd>
					{leading.map((name) => (
						<Fragment key={name}>
							<dt>{FIELD_LABEL[name]}</dt>
							<dd className="pk-mono-small break-all">{field(body, name)}</dd>
						</Fragment>
					))}
					{line.userName || userId ? (
						<>
							<dt>User</dt>
							<dd>{line.userName ?? <IdText id={userId} />}</dd>
						</>
					) : null}
					{workspace ? (
						<>
							<dt>Workspace</dt>
							<dd className="pk-mono-small break-all">{workspace}</dd>
						</>
					) : null}
				</dl>
				<section className="grid gap-2" aria-labelledby="log-inspector-raw">
					<h3 className="pk-overline" id="log-inspector-raw">
						Full line
					</h3>
					{/* Plain text in <pre>: a log line is never rendered as HTML. */}
					<pre className="pk-techdetail m-0 whitespace-pre-wrap break-all">
						{JSON.stringify(body, null, 2)}
					</pre>
				</section>
			</div>
		</aside>
	);
}

const FIELD_LABEL: Record<(typeof LEAD_FIELDS)[number], string> = {
	code: "Code",
	route: "Route",
	method: "Method",
	status: "Status",
	durationMs: "Duration (ms)",
	requestId: "Request",
};
