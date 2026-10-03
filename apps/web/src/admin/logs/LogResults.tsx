import type { LogLine } from "@portikus/contracts";
import { Button } from "@portikus/ui";
import { useQueryClient } from "@tanstack/react-query";
import { Fragment, useEffect, useRef, useState } from "react";
import { ApiError } from "../../api/request.js";
import { SortHeader } from "../../table/SortHeader.js";
import { type SortState, sortText } from "../../table/sort.js";
import { shortId, shortTime } from "../../text.js";
import { focusAdminHeading } from "../AdminSection.js";
import { emptyText, type LogFilters } from "./filters.js";
import { field, levelTagClass, levelText, messageOf, SERVICE_LABELS } from "./line.js";
import { logPagesKey, useLogPages } from "./queries.js";
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

/** The sortable columns, in table order, with Message and Route between Code and Status. */
const LEADING: readonly LogColumn[] = ["time", "level", "service", "code"];

export function LogResults({
	filters,
	auto,
	setAuto,
	sort,
	setSort,
}: {
	filters: LogFilters;
	auto: boolean;
	setAuto: (auto: boolean) => void;
	sort: SortState<LogColumn>;
	setSort: (sort: SortState<LogColumn>) => void;
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
	const settled = pages.isSuccess && !pages.isFetching;
	const empty = pages.isSuccess && lines.length === 0;
	// An empty, finished search says so once, in the empty line, not also as "0 lines".
	const emptyMessage = empty && last?.scanComplete ? emptyText(filters) : "";
	const countText =
		pages.isSuccess && !empty ? linesText(lines.length, Boolean(last?.nextCursor)) : "";
	const announceText = countText || emptyMessage;
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
						<caption className="sr-only">{logsCaption(sort)}</caption>
						<thead>
							<tr>
								<th scope="col">
									<span className="sr-only">Full line</span>
								</th>
								{LEADING.map((column) => header(column))}
								<th scope="col">Message</th>
								<th scope="col">Route</th>
								{header("status", "pk-num")}
								<th scope="col">User</th>
								<th scope="col">Workspace</th>
							</tr>
						</thead>
						<tbody>
							{shown.map((line) => (
								<LogRow
									key={line.cursor}
									line={line}
									journalIndex={journalIndex.get(line.cursor) ?? 0}
								/>
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

function LogRow({ line, journalIndex }: { line: LogLine; journalIndex: number }) {
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
						data-journal-index={journalIndex}
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
