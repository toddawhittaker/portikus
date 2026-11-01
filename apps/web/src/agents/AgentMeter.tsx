import type {
	AgentLimitWindow,
	AgentMeter,
	AgentUsageCounts,
} from "@portikus/contracts";
import { Meter, useToast } from "@portikus/ui";
import { useEffect, useId, useRef } from "react";
import { useCourseProfile } from "../editor/settingsQueries.js";
import { formatHoldEnd, useStudentTimezone } from "../shell/KeepRunning.js";
import { METER_CLEAR_BELOW, METER_WARN_AT } from "../shell/meterLevel.js";
import {
	AGENT_NAMES,
	chooseDisplay,
	formatCost,
	formatCount,
	limitWarning,
	liveWindows,
	percentText,
	todayText,
	warnKey,
	windowsToWarn,
} from "./agentDisplay.js";
import { useAgentMeter } from "./useAgentMeter.js";
import "./agent-meter.css";

type Entry = AgentMeter["agents"][number];

const WARNED_STORAGE_KEY = "portikus.usage-warned";

/** Warnings already shown, kept per browser so a reload does not repeat one. */
function readWarned(): Set<string> {
	try {
		const parsed: unknown = JSON.parse(
			localStorage.getItem(WARNED_STORAGE_KEY) ?? "[]",
		);
		return new Set(
			Array.isArray(parsed) ? parsed.filter((k) => typeof k === "string") : [],
		);
	} catch {
		return new Set();
	}
}

function writeWarned(keys: ReadonlySet<string>) {
	try {
		localStorage.setItem(WARNED_STORAGE_KEY, JSON.stringify([...keys].slice(-50)));
	} catch {
		// Private browsing or a full store: the warning may repeat, nothing worse.
	}
}

/**
 * Each agent's plan usage in the status bar (SPEC.md §25.10): a meter of the
 * fullest limit window, or today's counts for a student with no plan limit.
 * Renders nothing for an agent with neither.
 */
export function AgentMeters({
	workspaceId,
	enabled,
}: {
	workspaceId: string;
	/** Only a running workspace has agents to ask. */
	enabled: boolean;
}) {
	// A Traditional course has no coding agents to meter.
	const traditional = useCourseProfile() === "traditional";
	const meter = useAgentMeter(workspaceId, enabled && !traditional);
	const toast = useToast();
	const timeZone = useStudentTimezone();
	const data = enabled && !traditional ? meter.data : undefined;

	useEffect(() => {
		if (!data) return;
		const seen = readWarned();
		const now = Date.now();
		let changed = false;
		for (const entry of data.agents) {
			const windows = entry.limits ? liveWindows(entry.limits.windows, now) : [];
			for (const window of windowsToWarn(entry.agent, windows, seen)) {
				seen.add(warnKey(entry.agent, window));
				changed = true;
				toast.show({
					tone: "warning",
					title: `${AGENT_NAMES[entry.agent]} usage is at ${percentText(window.usedPercent)}`,
					children: `The ${window.name} limit resets ${formatHoldEnd(window.resetsAt, timeZone)}.`,
				});
			}
		}
		if (changed) writeWarned(seen);
	}, [data, toast, timeZone]);

	if (!data) return null;
	const now = Date.now();
	return (
		<>
			{data.agents.map((entry) => (
				<AgentStatus key={entry.agent} entry={entry} now={now} timeZone={timeZone} />
			))}
		</>
	);
}

function AgentStatus({
	entry,
	now,
	timeZone,
}: {
	entry: Entry;
	now: number;
	timeZone: string | undefined;
}) {
	const popoverId = useId();
	const warned = useRef(false);
	const display = chooseDisplay(entry, now);
	const name = AGENT_NAMES[entry.agent];
	if (display?.kind !== "limits") warned.current = false;
	if (!display) return null;

	const detail = <Details entry={entry} now={now} timeZone={timeZone} id={popoverId} />;
	if (display.kind === "today") {
		const text = todayText(display.counts);
		return (
			<>
				<button
					type="button"
					className="pk-statusbar-item"
					popoverTarget={popoverId}
					data-testid={`agent-meter-${entry.agent}`}
					data-kind="today"
					aria-label={`${name} today: ${text}. Show usage details`}
				>
					{name} today: {text}
				</button>
				{detail}
			</>
		);
	}

	const { top } = display;
	const level = limitWarning(top.usedPercent, warned.current) ? "warning" : "ok";
	warned.current = level === "warning";
	const shortText = percentText(top.usedPercent);
	const warnAt = warned.current ? METER_CLEAR_BELOW : METER_WARN_AT;
	return (
		<>
			<button
				type="button"
				className={`pk-statusbar-item pk-statusbar-meter pk-meter ${level === "warning" ? "pk-meter--warning" : ""}`}
				popoverTarget={popoverId}
				data-testid={`agent-meter-${entry.agent}`}
				data-kind="limits"
				data-level={level}
				aria-label={`${name} ${shortText} of the ${top.name} limit${level === "warning" ? ", nearly full" : ""}, resets ${formatHoldEnd(top.resetsAt, timeZone, now)}. Show usage details`}
			>
				<span className="pk-meter-label">{name}</span>
				<Meter
					label={name}
					value={Math.floor(top.usedPercent)}
					max={100}
					high={100 * warnAt - 1}
					valueText={`${shortText} of the ${top.name} limit`}
					shortText={shortText}
				/>
			</button>
			{detail}
		</>
	);
}

/** The native popover opened by the button before it: Escape and an outside click close it. */
function Details({
	entry,
	now,
	timeZone,
	id,
}: {
	entry: Entry;
	now: number;
	timeZone: string | undefined;
	id: string;
}) {
	const name = AGENT_NAMES[entry.agent];
	const windows = entry.limits ? liveWindows(entry.limits.windows, now) : [];
	return (
		// biome-ignore lint/a11y/useSemanticElements: a fieldset is for form controls
		<div
			id={id}
			popover="auto"
			role="group"
			aria-label={`${name} usage`}
			className="pk-agent-popover"
			data-testid={`agent-meter-${entry.agent}-details`}
		>
			{windows.length > 0 ? (
				<Windows windows={windows} now={now} timeZone={timeZone} />
			) : null}
			{entry.today ? <Today counts={entry.today} /> : null}
			{entry.today ? (
				<p className="pk-agent-popover-note">
					Counts update every 5 minutes. Days start at midnight UTC.
				</p>
			) : null}
		</div>
	);
}

function Windows({
	windows,
	now,
	timeZone,
}: {
	windows: AgentLimitWindow[];
	now: number;
	timeZone: string | undefined;
}) {
	return (
		<table className="pk-agent-popover-table">
			<thead>
				<tr>
					<th scope="col">Limit</th>
					<th scope="col">Used</th>
					<th scope="col">Resets</th>
				</tr>
			</thead>
			<tbody>
				{windows.map((window) => (
					<tr key={window.name}>
						<th scope="row">{window.name}</th>
						<td>{percentText(window.usedPercent)}</td>
						<td>
							<time dateTime={window.resetsAt}>
								{formatHoldEnd(window.resetsAt, timeZone, now)}
							</time>
						</td>
					</tr>
				))}
			</tbody>
		</table>
	);
}

function Today({ counts }: { counts: AgentUsageCounts }) {
	const rows: Array<[string, string]> = [
		["Sessions today", formatCount(counts.sessions)],
		["Input tokens", formatCount(counts.inputTokens)],
		["Output tokens", formatCount(counts.outputTokens)],
		["Cache tokens", formatCount(counts.cacheReadTokens + counts.cacheWriteTokens)],
	];
	if (counts.costUsd !== null)
		rows.push(["Estimated cost", formatCost(counts.costUsd)]);
	return (
		<dl className="pk-agent-popover-list">
			{rows.map(([label, value]) => (
				<div key={label}>
					<dt>{label}</dt>
					<dd>{value}</dd>
				</div>
			))}
		</dl>
	);
}
