import { expect, test } from "vitest";
import {
	afterRequest,
	ContextTracker,
	fromTranscript,
	mainThreadUsage,
	windowFromModelUsage,
} from "./context-usage.js";

const reply = (
	usage: Record<string, unknown> | undefined,
	parent: string | null = null,
) => ({
	type: "assistant",
	parent_tool_use_id: parent,
	message: { usage },
});

test("the context in use counts every input token the request sent plus its output", () => {
	const usage = mainThreadUsage(
		reply({
			input_tokens: 12,
			output_tokens: 300,
			cache_read_input_tokens: 40000,
			cache_creation_input_tokens: 2000,
		}),
	);
	expect(usage && afterRequest(null, usage, 1, 200000).usedTokens).toBe(42312);
});

test("subagent messages, user messages, missing and empty usage are not requests", () => {
	expect(mainThreadUsage(reply({ input_tokens: 5 }, "toolu_1"))).toBeNull();
	expect(
		mainThreadUsage({ type: "user", parent_tool_use_id: null, message: {} }),
	).toBeNull();
	expect(mainThreadUsage(reply(undefined))).toBeNull();
	expect(mainThreadUsage(reply({ input_tokens: 0, output_tokens: 0 }))).toBeNull();
	expect(
		mainThreadUsage(reply({ input_tokens: "x", cache_read_input_tokens: 3 }))?.input,
	).toBe(0);
});

test("a one-hour write sets a one-hour lifetime; a five-minute write sets five minutes", () => {
	const hour = mainThreadUsage(
		reply({
			input_tokens: 1,
			cache_creation_input_tokens: 10,
			cache_creation: { ephemeral_1h_input_tokens: 10 },
		}),
	);
	const fiveMinutes = mainThreadUsage(
		reply({
			input_tokens: 1,
			cache_creation_input_tokens: 10,
			cache_creation: { ephemeral_5m_input_tokens: 10, ephemeral_1h_input_tokens: 0 },
		}),
	);
	expect(hour && afterRequest(null, hour, 5, null).cache).toEqual({
		at: 5,
		ttlSeconds: 3600,
	});
	expect(fiveMinutes && afterRequest(null, fiveMinutes, 5, null).cache).toEqual({
		at: 5,
		ttlSeconds: 300,
	});
});

test("a read refreshes the clock and keeps the lifetime the entry was written with", () => {
	const read = mainThreadUsage(
		reply({ input_tokens: 1, cache_read_input_tokens: 500 }),
	);
	if (!read) throw new Error("expected usage");
	const written = {
		usedTokens: 1,
		windowTokens: null,
		cache: { at: 1, ttlSeconds: 3600 as const },
	};
	expect(afterRequest(written, read, 9, null).cache).toEqual({
		at: 9,
		ttlSeconds: 3600,
	});
	expect(afterRequest(null, read, 9, null).cache).toEqual({ at: 9, ttlSeconds: 300 });
});

test("a request that neither read nor wrote leaves the clock as it was", () => {
	const plain = mainThreadUsage(reply({ input_tokens: 50, output_tokens: 5 }));
	if (!plain) throw new Error("expected usage");
	expect(afterRequest(null, plain, 9, null).cache).toBeNull();
	const earlier = {
		usedTokens: 1,
		windowTokens: null,
		cache: { at: 1, ttlSeconds: 300 as const },
	};
	expect(afterRequest(earlier, plain, 9, null).cache).toEqual({
		at: 1,
		ttlSeconds: 300,
	});
});

test("the transcript's last main-thread request gives the figure, with no cache time", () => {
	const figures = fromTranscript(
		[
			reply({ input_tokens: 1, output_tokens: 1 }),
			reply({ input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 100 }),
			reply({ input_tokens: 9999 }, "toolu_sub"),
			{ type: "user", parent_tool_use_id: null, message: {} },
		],
		200000,
	);
	expect(figures).toEqual({ usedTokens: 112, windowTokens: 200000, cache: null });
	expect(fromTranscript([], null)).toBeNull();
});

test("the window is the named model's, or the only model's, else unknown", () => {
	expect(
		windowFromModelUsage({ a: { contextWindow: 100 }, b: { contextWindow: 200 } }, "b"),
	).toBe(200);
	expect(windowFromModelUsage({ a: { contextWindow: 100 } }, "other")).toBe(100);
	expect(
		windowFromModelUsage(
			{ a: { contextWindow: 100 }, b: { contextWindow: 200 } },
			null,
		),
	).toBeNull();
	expect(windowFromModelUsage({ a: { contextWindow: 0 } }, "a")).toBeNull();
	expect(windowFromModelUsage(undefined, "a")).toBeNull();
});

test("the window is shown as an empty context before any request, and kept by the next one", () => {
	const tracker = new ContextTracker();
	expect(tracker.current()).toBeNull();
	expect(tracker.window(1_000_000)).toEqual({
		usedTokens: 0,
		windowTokens: 1_000_000,
		cache: null,
	});
	// The same window again changes nothing.
	expect(tracker.window(1_000_000)).toBeNull();
	const after = tracker.request(
		reply({ input_tokens: 10, output_tokens: 5 }) as never,
		1000,
	);
	expect(after).toMatchObject({ usedTokens: 15, windowTokens: 1_000_000 });
});

test("another model's window replaces the figure's window and keeps what was used", () => {
	const tracker = new ContextTracker();
	tracker.window(200_000);
	tracker.request(reply({ input_tokens: 10, output_tokens: 5 }) as never, 1000);
	expect(tracker.window(1_000_000)).toMatchObject({
		usedTokens: 15,
		windowTokens: 1_000_000,
	});
});

test("after a new session the figures start empty again in the same window", () => {
	const tracker = new ContextTracker();
	tracker.window(200_000);
	tracker.request(reply({ input_tokens: 10, output_tokens: 5 }) as never, 1000);
	tracker.figures = null;
	expect(tracker.current()).toEqual({
		usedTokens: 0,
		windowTokens: 200_000,
		cache: null,
	});
});
