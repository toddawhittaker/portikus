import type { ChatClientMessage } from "@portikus/contracts";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { stopTime } from "../shell/useCountdown.js";
import {
	CACHE_EXPIRED,
	COMPACT_HINT,
	ContextMeter,
	contextLevel,
	contextPercent,
	formatClock,
	formatTokens,
	HANDOFF_BUTTON,
	RESTART_EXPLAINED,
	RESTART_NOW,
	restartText,
	spokenTokens,
} from "./ContextMeter.js";
import { type ChatState, type ChatStore, createChatStore } from "./chatStore.js";

type Context = NonNullable<ChatState["context"]>;

const START = Date.parse("2026-11-09T22:00:00Z");
let store: ChatStore;
let announced: string[];

function show(context: Context | null) {
	act(() => store.setState({ context }));
}

/** A context report whose cache was written `agoSeconds` ago. */
function report(
	used: number,
	window: number | null,
	cache: { agoSeconds: number; ttlSeconds: 300 | 3600 } | null,
): Context {
	return {
		usedTokens: used,
		windowTokens: window,
		cache: cache
			? { at: START - cache.agoSeconds * 1000, ttlSeconds: cache.ttlSeconds }
			: null,
		clockOffsetMs: 0,
	};
}

function tick(seconds: number) {
	act(() => {
		vi.advanceTimersByTime(seconds * 1000);
	});
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(START);
	store = createChatStore(() => true);
	announced = [];
	render(<ContextMeter store={store} onAnnounce={(text) => announced.push(text)} />);
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

test("formats the percent and the clock", () => {
	expect(contextPercent(72, 100)).toBe(72);
	expect(contextPercent(150, 100)).toBe(100);
	expect(formatClock(222)).toBe("3:42");
	expect(formatClock(3600)).toBe("60:00");
	expect(formatClock(-4)).toBe("0:00");
});

test("tokens are short: plain under 1,000, one decimal under 100k, none after, 1M for a million", () => {
	const cases: [number, string][] = [
		[0, "0"],
		[640, "640"],
		[999, "999"],
		[1000, "1.0k"],
		[8_400, "8.4k"],
		[34_200, "34.2k"],
		[99_949, "99.9k"],
		// 99.95k rounds up to the next form, not "100.0k".
		[99_950, "100k"],
		[182_300, "182k"],
		[200_000, "200k"],
		[999_499, "999k"],
		[999_500, "1M"],
		[1_000_000, "1M"],
		[1_500_000, "1.5M"],
	];
	for (const [tokens, short] of cases)
		expect(formatTokens(tokens), `${tokens}`).toBe(short);
});

test("tokens are spelled out for a screen reader", () => {
	expect(spokenTokens(640)).toBe("640");
	expect(spokenTokens(34_200)).toBe("34 thousand");
	expect(spokenTokens(200_000)).toBe("200 thousand");
	expect(spokenTokens(1_000_000)).toBe("1 million");
	expect(spokenTokens(1_500_000)).toBe("1.5 million");
});

test("the look steps at 25, 50, 75 and 90 percent", () => {
	expect(contextLevel(0)).toBe("low");
	expect(contextLevel(24)).toBe("low");
	expect(contextLevel(25)).toBe("rising");
	expect(contextLevel(49)).toBe("rising");
	expect(contextLevel(50)).toBe("half");
	expect(contextLevel(74)).toBe("half");
	expect(contextLevel(75)).toBe("warning");
	expect(contextLevel(89)).toBe("warning");
	expect(contextLevel(90)).toBe("full");
	expect(contextLevel(100)).toBe("full");
});

test("shows nothing before the host reports", () => {
	expect(screen.queryByTestId("composer-context")).toBeNull();
	expect(screen.queryByTestId("composer-cache")).toBeNull();
});

test("the context is always shown, with both figures, even before the first reply", () => {
	show(report(0, 1_000_000, null));
	const meter = screen.getByTestId("composer-context");
	expect(meter.textContent).toContain("Context 0 / 1M");
	expect(meter.getAttribute("data-level")).toBe("low");
	show(report(34_200, 1_000_000, null));
	expect(screen.getByTestId("composer-context").textContent).toContain("34.2k / 1M");
	expect(meter.getAttribute("title")).toBe(COMPACT_HINT);
	expect(meter.textContent).toContain(COMPACT_HINT);
	// A native meter, named Context, whose value is spelled out for a screen reader.
	const bar = meter.querySelector("meter");
	expect(bar?.getAttribute("aria-label")).toBe("Context");
	expect(bar?.getAttribute("aria-valuetext")).toBe(
		"about 34 thousand of 1 million tokens",
	);
	expect(meter.querySelector("svg")).toBeNull();
});

test("the figures are hidden from assistive technology; the meter says them", () => {
	show(report(34_200, 1_000_000, null));
	const meter = screen.getByTestId("composer-context");
	const text = meter.querySelector(".pk-meter-text");
	expect(text?.getAttribute("aria-hidden")).toBe("true");
	expect(text?.textContent).toBe("34.2k / 1M");
});

test("an unknown window shows the used count alone, with no bar", () => {
	show(report(34_200, null, null));
	const meter = screen.getByTestId("composer-context");
	expect(meter.textContent).toContain("34.2k tokens");
	expect(meter.querySelector("meter")).toBeNull();
	expect(meter.getAttribute("data-level")).toBe("unknown");
	expect(meter.textContent).toContain("Context: about 34 thousand tokens.");
});

test("each step has its own look, and the top two carry the alert icon, not colour alone", () => {
	const level = (used: number) => {
		show(report(used, 1000, null));
		return screen.getByTestId("composer-context");
	};
	expect(level(240).getAttribute("data-level")).toBe("low");
	expect(level(250).getAttribute("data-level")).toBe("rising");
	expect(level(500).getAttribute("data-level")).toBe("half");
	expect(level(500).querySelector("svg")).toBeNull();
	const warning = level(750);
	expect(warning.getAttribute("data-level")).toBe("warning");
	expect(warning.querySelector("svg")).not.toBeNull();
	expect(warning.querySelector("meter")?.getAttribute("aria-valuetext")).toBe(
		"about 750 of 1 thousand tokens, nearly full",
	);
	const full = level(900);
	expect(full.getAttribute("data-level")).toBe("full");
	expect(full.querySelector("svg")).not.toBeNull();
});

test("only crossing 75 and 90 percent is announced, once each", () => {
	show(report(100, 1000, null));
	show(report(260, 1000, null));
	show(report(300, 1000, null));
	show(report(520, 1000, null));
	show(report(760, 1000, null));
	show(report(790, 1000, null));
	show(report(910, 1000, null));
	expect(announced).toEqual([
		`Context is now 76% full. ${COMPACT_HINT}`,
		`Context is now 91% full. ${COMPACT_HINT}`,
	]);
});

test("a jump over several steps is announced once, and a fall then a climb is news again", () => {
	show(report(100, 1000, null));
	show(report(810, 1000, null));
	expect(announced).toEqual([`Context is now 81% full. ${COMPACT_HINT}`]);
	// After /compact it falls, and the next climb is news again.
	show(report(300, 1000, null));
	show(report(900, 1000, null));
	expect(announced).toHaveLength(2);
});

test("a first figure already past a step is not announced", () => {
	show(report(950, 1000, null));
	expect(announced).toEqual([]);
});

test("the cache clock counts down to the cache's end", () => {
	show(report(10, 1000, { agoSeconds: 78, ttlSeconds: 300 }));
	const cache = screen.getByTestId("composer-cache");
	expect(cache.textContent).toContain("Cache expires in 3:42");
	expect(cache.getAttribute("data-state")).toBe("warm");
	tick(1);
	expect(cache.textContent).toContain("Cache expires in 3:41");
	tick(60);
	expect(cache.textContent).toContain("Cache expires in 2:41");
});

test("a one-hour cache counts from an hour", () => {
	show(report(10, 1000, { agoSeconds: 0, ttlSeconds: 3600 }));
	expect(screen.getByTestId("composer-cache").textContent).toContain(
		"Cache expires in 60:00",
	);
});

test("the name is stable and the ticking digits are hidden from assistive technology", () => {
	const cache = { agoSeconds: 78, ttlSeconds: 300 } as const;
	show(report(10, 1000, cache));
	const meter = screen.getByTestId("composer-cache");
	const when = stopTime(START - 78_000 + 300_000);
	const spoken = () =>
		[...meter.children]
			.filter((one) => one.getAttribute("aria-hidden") !== "true")
			.map((one) => one.textContent)
			.join(" ");
	expect(spoken()).toBe(`Prompt cache: warm, goes cold at ${when}`);
	expect(meter.querySelector("[aria-hidden=true]")?.textContent).toContain(
		"Cache expires in 3:42",
	);
	tick(30);
	expect(spoken()).toBe(`Prompt cache: warm, goes cold at ${when}`);
	// Nothing about a tick reaches the status region.
	expect(announced).toEqual([]);
});

test("the last minute warns with an icon and the word soon", () => {
	show(report(10, 1000, { agoSeconds: 230, ttlSeconds: 300 }));
	const cache = screen.getByTestId("composer-cache");
	expect(cache.getAttribute("data-state")).toBe("warm");
	tick(10);
	expect(cache.getAttribute("data-state")).toBe("soon");
	expect(cache.textContent).toContain("Cache expires soon, 1:00");
	expect(cache.textContent).toContain("soon");
	expect(cache.querySelector("svg")).not.toBeNull();
	expect(cache.className).toContain("is-warning");
	expect(announced).toEqual([]);
});

test("at zero it reads cold, is announced once, and stops ticking", () => {
	show(report(10, 1000, { agoSeconds: 297, ttlSeconds: 300 }));
	const cache = screen.getByTestId("composer-cache");
	tick(3);
	expect(cache.getAttribute("data-state")).toBe("cold");
	expect(cache.textContent).toContain("Cache cold");
	expect(cache.textContent).toContain("Prompt cache: cold");
	expect(cache.querySelector("svg")).toBeNull();
	expect(announced).toHaveLength(1);
	expect(announced[0]).toContain("The prompt cache went cold at");
	tick(30);
	expect(announced).toHaveLength(1);
	expect(vi.getTimerCount()).toBe(0);
});

test("a cache already cold when it first shows is not announced", () => {
	show(report(10, 1000, { agoSeconds: 4000, ttlSeconds: 3600 }));
	expect(screen.getByTestId("composer-cache").textContent).toContain("Cache cold");
	expect(announced).toEqual([]);
});

test("a new cache write restarts the clock and the next cold is announced again", () => {
	show(report(10, 1000, { agoSeconds: 299, ttlSeconds: 300 }));
	tick(1);
	expect(announced).toHaveLength(1);
	act(() =>
		store.setState({
			context: {
				usedTokens: 20,
				windowTokens: 1000,
				cache: { at: Date.now(), ttlSeconds: 300 },
				clockOffsetMs: 0,
			},
		}),
	);
	const cache = screen.getByTestId("composer-cache");
	expect(cache.getAttribute("data-state")).toBe("warm");
	expect(cache.textContent).toContain("Cache expires in 5:00");
	tick(300);
	expect(cache.getAttribute("data-state")).toBe("cold");
	expect(announced).toHaveLength(2);
	expect(announced[1]).not.toBe(announced[0]);
});

test("the cache shows without a window, and goes when the host reports none", () => {
	show(report(10, null, { agoSeconds: 0, ttlSeconds: 300 }));
	expect(screen.getByTestId("composer-cache")).toBeTruthy();
	show(report(10, null, null));
	expect(screen.queryByTestId("composer-cache")).toBeNull();
	expect(vi.getTimerCount()).toBe(0);
});

test("a host clock ahead of the browser's is corrected by the skew the event carries", () => {
	// The host runs ten minutes ahead; its cache write was 60 seconds ago by its own clock.
	const hostNow = START + 10 * 60 * 1000;
	act(() => {
		store.setState({ awaitingSnapshot: false });
		store.getState().receive(
			JSON.stringify({
				type: "context",
				sessionId: "00000000-0000-4000-8000-000000000001",
				seq: 0,
				usedTokens: 10,
				windowTokens: 1000,
				cache: { at: hostNow - 60_000, ttlSeconds: 300 },
				now: hostNow,
			}),
		);
	});
	const cache = screen.getByTestId("composer-cache");
	expect(cache.getAttribute("data-state")).toBe("warm");
	expect(cache.textContent).toContain("Cache expires in 4:00");
});

test("an older host that sends no time gets no correction", () => {
	act(() => {
		store.setState({ awaitingSnapshot: false });
		store.getState().receive(
			JSON.stringify({
				type: "context",
				sessionId: "00000000-0000-4000-8000-000000000001",
				seq: 0,
				usedTokens: 10,
				windowTokens: 1000,
				cache: { at: START - 60_000, ttlSeconds: 300 },
			}),
		);
	});
	expect(screen.getByTestId("composer-cache").textContent).toContain(
		"Cache expires in 4:00",
	);
});

/** Two finished messages: a warm-up of 18k in 14 requests, then 18k in 14 requests, from a 58k start. */
function finishedTwice() {
	return {
		firstUsedTokens: 58_000,
		messagesSent: 2,
		contextEvents: 28,
		usedAfterFirstMessage: 76_000,
		firstMessageEvents: 14,
		messagesDone: 2,
		usedAtLastDone: 94_000,
		eventsAtLastDone: 28,
	};
}

/** A Claude chat on a one-hour cache whose first report was 58k, two messages in. */
function growing(used: number) {
	act(() =>
		store.setState({
			settings: {
				agent: "claude",
				model: "claude-opus-5-5",
				effort: "medium",
				mode: "default",
			},
			growth: finishedTwice(),
			context: report(used, 1_000_000, { agoSeconds: 0, ttlSeconds: 3600 }),
		}),
	);
}

test("the fresh-chat hint is hidden on an empty chat", () => {
	show(report(0, 1_000_000, null));
	expect(screen.queryByTestId("composer-restart")).toBeNull();
});

test("no hint, and no handoff button, before the gate: the pilot's one-message chat at 28k", () => {
	act(() =>
		store.setState({
			settings: { agent: "claude", model: "opus", effort: "medium", mode: "default" },
			growth: {
				firstUsedTokens: 26_313,
				messagesSent: 1,
				contextEvents: 3,
				usedAfterFirstMessage: 28_328,
				firstMessageEvents: 3,
				messagesDone: 1,
				usedAtLastDone: 28_328,
				eventsAtLastDone: 3,
			},
			context: report(28_328, 1_000_000, { agoSeconds: 0, ttlSeconds: 3600 }),
		}),
	);
	expect(screen.queryByTestId("composer-restart")).toBeNull();
	expect(screen.queryByRole("button", { name: HANDOFF_BUTTON })).toBeNull();
	expect(screen.queryByText(/fresh chat/i)).toBeNull();
});

test("the hint prices the model the host reported, not the settings alias", () => {
	// The setting says haiku, whose prices differ; the reported Opus 5.5 id sets the count.
	growing(60_000);
	act(() =>
		store.setState({
			settings: { agent: "claude", model: "haiku", effort: "medium", mode: "default" },
			context: {
				...report(60_000, 1_000_000, { agoSeconds: 0, ttlSeconds: 3600 }),
				model: "claude-opus-5-5",
			},
		}),
	);
	expect(screen.getByTestId("composer-restart").textContent).toContain(
		"About 5 more messages",
	);
});

test("the fresh-chat hint counts down in words, singular at one", () => {
	// The first message's rates put the cheapest restart at 156k, 18k per message.
	growing(60_000);
	const hint = screen.getByTestId("composer-restart");
	expect(hint.textContent).toContain(
		"About 5 more messages before a fresh chat saves usage",
	);
	expect(hint.getAttribute("title")).toBe(RESTART_EXPLAINED);
	expect(hint.classList.contains("is-warning")).toBe(false);
	growing(138_000);
	expect(screen.getByTestId("composer-restart").textContent).toContain(
		"About 1 more message before a fresh chat saves usage",
	);
	expect(restartText(2)).toBe("About 2 more messages before a fresh chat saves usage");
});

test("at zero the hint warns, keeps its count from a screen reader, and is announced once", () => {
	growing(120_000);
	expect(announced).toEqual([]);
	growing(160_000);
	const hint = screen.getByTestId("composer-restart");
	expect(hint.classList.contains("is-warning")).toBe(true);
	expect(hint.textContent).toContain(RESTART_NOW);
	expect(hint.querySelector(".sr-only")?.textContent).not.toMatch(/\d/);
	growing(200_000);
	growing(300_000);
	expect(announced.filter((text) => text.startsWith(RESTART_NOW))).toHaveLength(1);
});

test("a chat that opens past the point is not announced", () => {
	growing(400_000);
	expect(screen.getByTestId("composer-restart").textContent).toContain(RESTART_NOW);
	expect(announced).toEqual([]);
});

test("only once a fresh chat would save usage, a button starts fresh with a handoff", () => {
	cleanup();
	const sent: ChatClientMessage[] = [];
	store = createChatStore((message) => {
		sent.push(message);
		return true;
	});
	render(<ContextMeter store={store} onAnnounce={() => undefined} />);
	growing(120_000);
	expect(screen.queryByRole("button", { name: HANDOFF_BUTTON })).toBeNull();
	growing(400_000);
	const button = screen.getByRole("button", { name: HANDOFF_BUTTON });
	// Outside the hint, so the hint's own words and hidden sentence stay as they were.
	expect(screen.getByTestId("composer-restart").contains(button)).toBe(false);
	expect(button.closest('[data-testid="composer-meters"]')).not.toBeNull();
	fireEvent.click(button);
	expect(sent).toEqual([{ type: "handoff.start" }]);
});

test("once the cache expires, the next message is priced as a re-write and the title says so", () => {
	// 100k used with a fresh chat at 66k: a few messages left while warm.
	growing(100_000);
	const warm = screen.getByTestId("composer-restart");
	expect(warm.textContent).not.toContain(RESTART_NOW);
	expect(warm.getAttribute("title")).toBe(RESTART_EXPLAINED);
	tick(3600);
	const cold = screen.getByTestId("composer-restart");
	expect(cold.textContent).toContain(RESTART_NOW);
	expect(cold.getAttribute("title")).toBe(`${RESTART_EXPLAINED} ${CACHE_EXPIRED}`);
	expect(cold.querySelector(".sr-only")?.textContent).toContain(CACHE_EXPIRED);
});

test("a Codex chat on the 30-minute cache goes cold too", () => {
	act(() =>
		store.setState({
			settings: {
				agent: "codex",
				model: "gpt-6.1-sol",
				effort: "medium",
				mode: "default",
			},
			growth: finishedTwice(),
			context: {
				...report(100_000, 475_000, null),
				cache: { at: START, ttlSeconds: 1800 },
			},
		}),
	);
	expect(screen.getByTestId("composer-restart").getAttribute("title")).toBe(
		RESTART_EXPLAINED,
	);
	tick(1800);
	expect(screen.getByTestId("composer-restart").getAttribute("title")).toBe(
		`${RESTART_EXPLAINED} ${CACHE_EXPIRED}`,
	);
});

test("after a compaction the host's restarted counts bring the estimate back to a sane count", () => {
	const SESSION = "11111111-1111-4111-8111-111111111111";
	let seq = 0;
	const receive = (body: Record<string, unknown>) =>
		act(() =>
			store
				.getState()
				.receive(JSON.stringify({ sessionId: SESSION, seq: seq++, ...body })),
		);
	receive({ type: "snapshot", cards: [], turnRunning: false, truncated: false });
	receive({
		type: "settings",
		agent: "claude",
		model: "claude-opus-5-5",
		effort: "medium",
		mode: "default",
	});
	const cache = { at: START, ttlSeconds: 3600 };
	receive({
		type: "context",
		usedTokens: 400_000,
		windowTokens: 1_000_000,
		cache,
		now: START,
		growth: {
			startTokens: 58_000,
			messages: 10,
			requests: 140,
			firstMessageTokens: 76_000,
			firstMessageRequests: 14,
			doneMessages: 10,
			doneTokens: 400_000,
			doneRequests: 140,
		},
	});
	expect(screen.getByTestId("composer-restart").textContent).toContain(RESTART_NOW);
	// Compacted to 60k: below the old start, with the counts begun again from there.
	receive({
		type: "context",
		usedTokens: 60_000,
		windowTokens: 1_000_000,
		cache,
		now: START,
		growth: {
			startTokens: 42_000,
			messages: 2,
			requests: 28,
			firstMessageTokens: 60_000,
			firstMessageRequests: 14,
			doneMessages: 2,
			doneTokens: 78_000,
			doneRequests: 28,
		},
	});
	const hint = screen.getByTestId("composer-restart");
	expect(hint.classList.contains("is-warning")).toBe(false);
	expect(hint.textContent).toContain(
		"About 3 more messages before a fresh chat saves usage",
	);
});
