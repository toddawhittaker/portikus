import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { stopTime } from "../shell/useCountdown.js";
import {
	COMPACT_HINT,
	ContextMeter,
	contextLevel,
	contextPercent,
	formatClock,
	formatTokens,
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

test("each step crossed is announced once, shortly", () => {
	show(report(100, 1000, null));
	show(report(260, 1000, null));
	show(report(300, 1000, null));
	show(report(520, 1000, null));
	show(report(760, 1000, null));
	show(report(790, 1000, null));
	show(report(910, 1000, null));
	expect(announced).toEqual([
		"Context is now 26% full.",
		"Context is now 52% full.",
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
