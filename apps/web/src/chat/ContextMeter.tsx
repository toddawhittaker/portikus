/**
 * What this chat tab has used up, on the line under its pickers (SPEC.md §10.8): how full
 * Claude's context is, once it is over half, and the time until the prompt
 * cache goes cold, always while the host reports one. Both come from the
 * `context` event, so each chat tab shows its own conversation.
 *
 * The ticking digits are hidden from assistive technology; a stable sentence
 * carries the same meaning, and the row's status region announces the two
 * moments that matter once each (SPEC.md §25.8).
 */
import { Icon } from "@portikus/ui";
import { useEffect, useRef, useState } from "react";
import { useStore } from "zustand";
import { stopTime } from "../shell/useCountdown.js";
import type { ChatState, ChatStore } from "./chatStore.js";

type Cache = NonNullable<NonNullable<ChatState["context"]>["cache"]>;

/** The meter appears once more than this share of the window is used. */
const SHOW_OVER_PERCENT = 50;
/** The student is told once when the context reaches this share. */
const ANNOUNCE_AT_PERCENT = 80;
/** The cache timer turns to a warning for this long before it goes cold. */
const SOON_SECONDS = 60;

export const COMPACT_HINT = "Run /compact to free up space.";

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
	// The first figure seen is a starting point, not news, so it is never announced.
	const before = useRef(percent);
	useEffect(() => {
		if (before.current < ANNOUNCE_AT_PERCENT && percent >= ANNOUNCE_AT_PERCENT) {
			onAnnounce(`Context is now ${percent}% full. ${COMPACT_HINT}`);
		}
		before.current = percent;
	}, [percent, onAnnounce]);

	if (percent <= SHOW_OVER_PERCENT) return null;
	const high = percent >= ANNOUNCE_AT_PERCENT;
	return (
		<span
			className={`pk-ctx${high ? " is-warning" : ""}`}
			title={COMPACT_HINT}
			data-testid="composer-context"
		>
			{high ? <Icon name="alert" size="sm" /> : null}
			<span>Context {percent}%</span>
			<span className="sr-only">. {COMPACT_HINT}</span>
		</span>
	);
}

function CacheClock({
	cache,
	onAnnounce,
}: {
	cache: Cache;
	onAnnounce: (text: string) => void;
}) {
	const coldAt = cache.at + cache.ttlSeconds * 1000;
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
				<span>{cold ? "Cache cold" : `Cache ${formatClock(seconds)}`}</span>
				{soon ? <span>soon</span> : null}
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
					{context.windowTokens === null ? null : (
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
							onAnnounce={onAnnounce}
						/>
					) : null}
				</>
			) : null}
		</div>
	);
}
