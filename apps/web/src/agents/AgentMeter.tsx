import type { AgentUsageCounts, PlanUsage } from "@portikus/contracts";
import { Meter, useToast } from "@portikus/ui";
import { useEffect, useId, useRef } from "react";
import { useCourseProfile } from "../editor/settingsQueries.js";
import { formatHoldEnd, useStudentTimezone } from "../shell/KeepRunning.js";
import { METER_CLEAR_BELOW, METER_WARN_AT } from "../shell/meterLevel.js";
import {
	chooseDisplay,
	formatCost,
	formatCount,
	limitWarning,
	livePlan,
	type ProviderMeter,
	percentText,
	shouldWarn,
	todayText,
	warnKey,
} from "./agentDisplay.js";
import { useAgentMeter } from "./useAgentMeter.js";
import "./agent-meter.css";

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
 * Each provider's 7-day plan usage in the status bar (SPEC.md §10.8, §25.10):
 * percent used and when it resets, or today's counts for a student whose
 * provider reports no plan. Renders nothing for a provider with neither.
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
		for (const entry of data.providers) {
			const plan = livePlan(entry.plan, now);
			if (!plan || !shouldWarn(plan, seen)) continue;
			seen.add(warnKey(plan));
			changed = true;
			toast.show({
				tone: "warning",
				title: `${plan.label} usage is at ${percentText(plan.usedPercent)}`,
				children: `The 7-day limit resets ${formatHoldEnd(plan.resetsAt, timeZone)}.`,
			});
		}
		if (changed) writeWarned(seen);
	}, [data, toast, timeZone]);

	if (!data) return null;
	const now = Date.now();
	return (
		<>
			{data.providers.map((entry) => (
				<ProviderStatus key={entry.id} entry={entry} now={now} timeZone={timeZone} />
			))}
		</>
	);
}

function ProviderStatus({
	entry,
	now,
	timeZone,
}: {
	entry: ProviderMeter;
	now: number;
	timeZone: string | undefined;
}) {
	const popoverId = useId();
	const warned = useRef(false);
	const display = chooseDisplay(entry, now);
	const name = entry.label;
	if (display?.kind !== "plan") warned.current = false;
	if (!display) return null;

	const detail = (
		<Details
			entry={entry}
			display={display}
			now={now}
			timeZone={timeZone}
			id={popoverId}
		/>
	);
	if (display.kind === "today") {
		const text = todayText(display.counts);
		return (
			<>
				<button
					type="button"
					className="pk-statusbar-item"
					popoverTarget={popoverId}
					data-testid={`agent-meter-${entry.id}`}
					data-kind="today"
					aria-label={`${name} today: ${text}. Show usage details`}
				>
					{name} today: {text}
				</button>
				{detail}
			</>
		);
	}

	const { plan } = display;
	const level = limitWarning(plan.usedPercent, warned.current) ? "warning" : "ok";
	warned.current = level === "warning";
	const shortText = percentText(plan.usedPercent);
	const warnAt = warned.current ? METER_CLEAR_BELOW : METER_WARN_AT;
	const resets = formatHoldEnd(plan.resetsAt, timeZone, now);
	return (
		<>
			<button
				type="button"
				className={`pk-statusbar-item pk-statusbar-meter pk-meter ${level === "warning" ? "pk-meter--warning" : ""}`}
				popoverTarget={popoverId}
				data-testid={`agent-meter-${entry.id}`}
				data-kind="plan"
				data-level={level}
				aria-label={`${name} ${shortText} resets ${resets}, of the 7-day limit${level === "warning" ? ", nearly full" : ""}. Show usage details`}
			>
				<span className="pk-meter-label">{name}</span>
				<Meter
					label={name}
					value={Math.floor(plan.usedPercent)}
					max={100}
					high={100 * warnAt - 1}
					valueText={`${shortText} of the 7-day limit`}
					shortText={shortText}
					className="pk-meter-line--slim"
				/>
				{/* In the name and the details; hidden here so the strip stays short. */}
				<span className="pk-visually-hidden">resets {resets}</span>
			</button>
			{detail}
		</>
	);
}

function Details({
	entry,
	display,
	now,
	timeZone,
	id,
}: {
	entry: ProviderMeter;
	display: NonNullable<ReturnType<typeof chooseDisplay>>;
	now: number;
	timeZone: string | undefined;
	id: string;
}) {
	return (
		// biome-ignore lint/a11y/useSemanticElements: a fieldset is for form controls
		<div
			id={id}
			popover="auto"
			role="group"
			aria-label={`${entry.label} usage`}
			className="pk-agent-popover"
			data-testid={`agent-meter-${entry.id}-details`}
		>
			{display.kind === "plan" ? (
				<PlanDetails plan={display.plan} now={now} timeZone={timeZone} />
			) : (
				<>
					<Today counts={display.counts} />
					<p className="pk-agent-popover-note">
						Counts update every 5 minutes. Days start at midnight UTC.
					</p>
				</>
			)}
		</div>
	);
}

function PlanDetails({
	plan,
	now,
	timeZone,
}: {
	plan: PlanUsage;
	now: number;
	timeZone: string | undefined;
}) {
	return (
		<dl className="pk-agent-popover-list">
			<div>
				<dt>Limit</dt>
				<dd>7 days</dd>
			</div>
			<div>
				<dt>Used</dt>
				<dd>{percentText(plan.usedPercent)}</dd>
			</div>
			<div>
				<dt>Resets</dt>
				<dd>
					<time dateTime={plan.resetsAt}>
						{formatHoldEnd(plan.resetsAt, timeZone, now)}
					</time>
				</dd>
			</div>
		</dl>
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
