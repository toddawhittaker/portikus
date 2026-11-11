/**
 * What this chat tab has used up, on the line under its pickers (SPEC.md §10.8): how full
 * Claude's context is, always, as "34.2k / 1M" with a bar, and the time until the prompt
 * cache goes cold, while the host reports one. Both come from the
 * `context` event, so each chat tab shows its own conversation. The look steps
 * up as the window fills, at 25, 50 and 75%, and turns to the error look from 90%.
 *
 * The ticking digits are hidden from assistive technology; a stable sentence
 * carries the same meaning, and the row's status region announces each step
 * crossed once (SPEC.md §25.8).
 */
import { Icon, Meter } from "@portikus/ui";
import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { stopTime } from "../shell/useCountdown.js";
import type { ChatState, ChatStore } from "./chatStore.js";

type Cache = NonNullable<NonNullable<ChatState["context"]>["cache"]>;

/** The looks the meter steps through, from this share of the window up. */
const STEPS = [
	{ from: 90, level: "full" },
	{ from: 75, level: "warning" },
	{ from: 50, level: "half" },
	{ from: 25, level: "rising" },
	{ from: 0, level: "low" },
] as const;
/** The top step is the nearly-full look: the Meter adds the alert icon and the words past this. */
const WARN_AT_PERCENT = 75;
/** The cache timer turns to a warning for this long before it goes cold. */
const SOON_SECONDS = 60;

export const COMPACT_HINT = "Run /compact to free up space.";

/** The look for this share of the window in use. */
export function contextLevel(percent: number): (typeof STEPS)[number]["level"] {
	return STEPS.find((step) => percent >= step.from)?.level ?? "low";
}

/** The step a share first reached, the one worth announcing; null below the first. */
function stepReached(percent: number): number | null {
	const step = STEPS.find((one) => percent >= one.from && one.from > 0);
	return step ? step.from : null;
}

/**
 * Tokens in short form: "640", "8.4k", "34.2k", "182k", "1M". One decimal
 * place below 100k, none from there, so exact counts are not shown.
 */
export function formatTokens(tokens: number): string {
	const count = Math.max(0, Math.round(tokens));
	if (count < 1000) return String(count);
	if (count < 99_950) return `${(Math.round(count / 100) / 10).toFixed(1)}k`;
	if (count < 999_500) return `${Math.round(count / 1000)}k`;
	const millions = Math.round(count / 100_000) / 10;
	return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
}

/** The same figure for a screen reader, which reads "34.2k" badly: "34 thousand". */
export function spokenTokens(tokens: number): string {
	const count = Math.max(0, Math.round(tokens));
	if (count < 1000) return String(count);
	if (count < 999_500) return `${Math.round(count / 1000)} thousand`;
	const millions = Math.round(count / 100_000) / 10;
	return `${Number.isInteger(millions) ? millions : millions.toFixed(1)} million`;
}

/** Whole percent of the window in use, never past 100. */
export function contextPercent(usedTokens: number, windowTokens: number): number {
	return Math.min(100, Math.round((usedTokens / windowTokens) * 100));
}

/** Seconds as m:ss; a one-hour cache starts at 60:00. */
export function formatClock(seconds: number): string {
	const total = Math.max(0, seconds);
	return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** The browser clock, ticking each second until `until` (epoch milliseconds), then still. */
function useNow(until: number): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		setNow(Date.now());
		if (Date.now() >= until) return;
		const timer = setInterval(() => {
			const next = Date.now();
			setNow(next);
			if (next >= until) clearInterval(timer);
		}, 1000);
		return () => clearInterval(timer);
	}, [until]);
	return now;
}

function useAnnounceSteps(percent: number, onAnnounce: (text: string) => void) {
	// The first figure seen is a starting point, not news, so it is never announced.
	const before = useRef(percent);
	useEffect(() => {
		const reached = stepReached(percent);
		if (reached !== null && reached > (stepReached(before.current) ?? 0)) {
			const hint = reached >= WARN_AT_PERCENT ? ` ${COMPACT_HINT}` : "";
			onAnnounce(`Context is now ${percent}% full.${hint}`);
		}
		before.current = percent;
	}, [percent, onAnnounce]);
}

function ContextUse({
	usedTokens,
	windowTokens,
	onAnnounce,
}: {
	usedTokens: number;
	windowTokens: number;
	onAnnounce: (text: string) => void;
}) {
	const percent = contextPercent(usedTokens, windowTokens);
	useAnnounceSteps(percent, onAnnounce);
	const level = contextLevel(percent);
	const alarm = level === "warning" || level === "full";
	return (
		<span
			className={`pk-ctx pk-ctx-meter${alarm ? ` pk-meter--${level}` : ""}`}
			data-level={level}
			title={COMPACT_HINT}
			data-testid="composer-context"
		>
			{/* The meter is named Context too, so the visible word is not read twice. */}
			<span className="pk-meter-label" aria-hidden={true}>
				Context
			</span>{" "}
			<Meter
				label="Context"
				value={percent}
				max={100}
				// The Meter warns strictly past `high`, so this warns from the top step itself.
				high={WARN_AT_PERCENT - 1}
				valueText={`about ${spokenTokens(usedTokens)} of ${spokenTokens(windowTokens)} tokens`}
				shortText={`${formatTokens(usedTokens)} / ${formatTokens(windowTokens)}`}
				className="pk-meter-line--slim"
			/>
			<span className="sr-only">. {COMPACT_HINT}</span>
		</span>
	);
}

/** The used count alone, when Claude Code has not yet said how large the window is. */
function ContextCount({ usedTokens }: { usedTokens: number }) {
	return (
		<span
			className="pk-ctx pk-ctx-meter"
			data-level="unknown"
			title={COMPACT_HINT}
			data-testid="composer-context"
		>
			<span className="pk-meter-label" aria-hidden={true}>
				Context
			</span>{" "}
			<span aria-hidden={true}>{formatTokens(usedTokens)} tokens</span>
			<span className="sr-only">
				Context: about {spokenTokens(usedTokens)} tokens. {COMPACT_HINT}
			</span>
		</span>
	);
}

function CacheClock({
	cache,
	clockOffsetMs,
	onAnnounce,
}: {
	cache: Cache;
	/** Added to the host's times to read them on the browser clock. */
	clockOffsetMs: number;
	onAnnounce: (text: string) => void;
}) {
	const coldAt = cache.at + cache.ttlSeconds * 1000 + clockOffsetMs;
	const now = useNow(coldAt);
	const cold = now >= coldAt;
	const seconds = Math.ceil((coldAt - now) / 1000);
	const soon = !cold && seconds <= SOON_SECONDS;
	const when = stopTime(coldAt);

	// Told once as it goes cold, never when the tab opens already cold.
	const wasCold = useRef(cold);
	useEffect(() => {
		if (!wasCold.current && cold) {
			onAnnounce(
				`The prompt cache went cold at ${when}. Your next message takes longer and uses more of your limit.`,
			);
		}
		wasCold.current = cold;
	}, [cold, when, onAnnounce]);

	return (
		<span
			className={`pk-ctx${soon ? " is-warning" : ""}${cold ? " is-cold" : ""}`}
			data-state={cold ? "cold" : soon ? "soon" : "warm"}
			data-testid="composer-cache"
		>
			<span className="pk-ctx-sight" aria-hidden={true}>
				{soon ? <Icon name="alert" size="sm" /> : null}
				<span>
					{cold
						? "Cache cold"
						: soon
							? `Cache expires soon, ${formatClock(seconds)}`
							: `Cache expires in ${formatClock(seconds)}`}
				</span>
			</span>
			{/* Stable until the cache goes cold; the digits above are not read. */}
			<span className="sr-only">
				{cold ? "Prompt cache: cold" : `Prompt cache: warm, goes cold at ${when}`}
			</span>
		</span>
	);
}

interface Props {
	store: ChatStore;
	/** A sentence for the composer's status region. */
	onAnnounce: (text: string) => void;
}

export function ContextMeter({ store, onAnnounce }: Props) {
	const context = useStore(store, (state) => state.context);
	// Always rendered, so its place is a line of the composer's bar only while it holds something.
	return (
		<div className="pk-ctx-row" data-testid="composer-meters">
			{context ? (
				<>
					{context.windowTokens === null ? (
						<ContextCount usedTokens={context.usedTokens} />
					) : (
						<ContextUse
							usedTokens={context.usedTokens}
							windowTokens={context.windowTokens}
							onAnnounce={onAnnounce}
						/>
					)}
					{context.cache ? (
						<CacheClock
							// A new cache write restarts the clock with its own state.
							key={context.cache.at}
							cache={context.cache}
							clockOffsetMs={context.clockOffsetMs}
							onAnnounce={onAnnounce}
						/>
					) : null}
				</>
			) : null}
		</div>
	);
}
