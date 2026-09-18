import type { FsEvent } from "@portikus/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { FakeWebSocket } from "../test-utils.js";
import { fileKeys } from "./queries.js";
import {
	applyInvalidations,
	invalidationsFor,
	useProjectEvents,
} from "./useProjectEvents.js";

function frame(partial: Partial<FsEvent> = {}): FsEvent {
	return { type: "fs", paths: [], git: false, truncated: false, ...partial };
}

test("each path asks for its own directory and its own file", () => {
	const work = invalidationsFor([frame({ paths: ["src/a.ts", "README.md"] })]);
	expect(work.trees.sort()).toEqual(["", "src"]);
	expect(work.files.sort()).toEqual(["README.md", "src/a.ts"]);
	expect(work.all).toBe(false);
});

// SPEC.md §12.3: editing a tracked file changes what Git reports, so an
// ordinary write has to refresh the status too.
test("a frame with paths but no git flag still asks for the Git status", () => {
	expect(invalidationsFor([frame({ paths: ["README.md"] })]).git).toBe(true);
});

test("a frame that names nothing at all asks for nothing", () => {
	const work = invalidationsFor([frame()]);
	expect(work.git).toBe(false);
	expect(work.all).toBe(false);
});

test("a git frame asks for the Git status and nothing else", () => {
	const work = invalidationsFor([frame({ git: true })]);
	expect(work.git).toBe(true);
	expect(work.trees).toEqual([]);
	expect(work.files).toEqual([]);
});

test("a truncated frame asks for everything and drops the path list", () => {
	const work = invalidationsFor([
		frame({ paths: ["src/a.ts"] }),
		frame({ truncated: true, git: true }),
	]);
	expect(work.all).toBe(true);
	expect(work.git).toBe(true);
	expect(work.trees).toEqual([]);
	expect(work.files).toEqual([]);
});

test("a batch refetches each named key once", () => {
	const client = new QueryClient();
	const invalidate = vi
		.spyOn(client, "invalidateQueries")
		.mockReturnValue(Promise.resolve());
	applyInvalidations(client, "ws", "pid", {
		git: true,
		trees: ["src"],
		files: ["src/a.ts"],
		all: false,
	});
	const keys = invalidate.mock.calls.map((call) => call[0]?.queryKey);
	expect(keys).toContainEqual(fileKeys.git("ws", "pid", false));
	expect(keys).toContainEqual(fileKeys.git("ws", "pid", true));
	expect(keys).toContainEqual(fileKeys.tree("ws", "pid", "src"));
	expect(keys).toContainEqual(fileKeys.file("ws", "pid", "src/a.ts"));
	expect(keys).toContainEqual(fileKeys.diff("ws", "pid", "src/a.ts"));
});

test("a git frame rewrites every open diff of the project", () => {
	const client = new QueryClient();
	const invalidate = vi
		.spyOn(client, "invalidateQueries")
		.mockReturnValue(Promise.resolve());
	applyInvalidations(client, "ws", "pid", {
		git: true,
		trees: [],
		files: [],
		all: false,
	});
	const predicate = invalidate.mock.calls
		.map((call) => call[0]?.predicate)
		.find((value) => value !== undefined);
	if (!predicate) throw new Error("a git frame needs a diff predicate");
	const match = (queryKey: readonly unknown[]) => predicate({ queryKey } as never);
	expect(match(fileKeys.diff("ws", "pid", "a.ts"))).toBe(true);
	expect(match(fileKeys.diff("ws", "other", "a.ts"))).toBe(false);
});

test("everything is refetched by a predicate that matches this project only", () => {
	const client = new QueryClient();
	const invalidate = vi
		.spyOn(client, "invalidateQueries")
		.mockReturnValue(Promise.resolve());
	applyInvalidations(client, "ws", "pid", {
		git: false,
		trees: [],
		files: [],
		all: true,
	});
	expect(invalidate).toHaveBeenCalledTimes(1);
	const predicate = invalidate.mock.calls[0]?.[0]?.predicate;
	if (!predicate) throw new Error("the whole-project refetch needs a predicate");
	const match = (queryKey: readonly unknown[]) => predicate({ queryKey } as never);
	expect(match(fileKeys.tree("ws", "pid", "src"))).toBe(true);
	expect(match(fileKeys.file("ws", "pid", "src/a.ts"))).toBe(true);
	expect(match(fileKeys.diff("ws", "pid", "src/a.ts"))).toBe(true);
	expect(match(fileKeys.tree("ws", "other", "src"))).toBe(false);
	expect(match(["projects", "ws"])).toBe(false);
	// A truncated batch skipped the Git status before; it must not.
	expect(match(fileKeys.git("ws", "pid", false))).toBe(true);
	expect(match(fileKeys.git("ws", "pid", true))).toBe(true);
});

/** The socket itself: when it is opened again, and when it gives up. */
function mountSocket() {
	const client = new QueryClient();
	const invalidate = vi
		.spyOn(client, "invalidateQueries")
		.mockReturnValue(Promise.resolve());
	const view = renderHook(() => useProjectEvents("ws", "pid"), {
		wrapper: ({ children }) => (
			<QueryClientProvider client={client}>{children}</QueryClientProvider>
		),
	});
	return { invalidate, unmount: view.unmount };
}

/** Close the newest socket, and let any retry timer that was set run. */
function closeLatest(code: number, waitMs: number) {
	act(() => {
		FakeWebSocket.last?.onclose?.({ code });
	});
	act(() => {
		vi.advanceTimersByTime(waitMs);
	});
}

beforeEach(() => {
	vi.useFakeTimers();
	FakeWebSocket.all = [];
	FakeWebSocket.last = null;
	vi.stubGlobal("WebSocket", FakeWebSocket);
});

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

test("a socket the server refuses is not opened again", () => {
	for (const code of [4401, 4404, 1008]) {
		FakeWebSocket.all = [];
		FakeWebSocket.last = null;
		const { unmount } = mountSocket();
		expect(FakeWebSocket.all).toHaveLength(1);
		closeLatest(code, 60_000);
		expect(FakeWebSocket.all).toHaveLength(1);
		unmount();
	}
});

test("a socket that keeps dying young is retried more and more slowly", () => {
	mountSocket();
	expect(FakeWebSocket.all).toHaveLength(1);

	// First failure: one second.
	closeLatest(1006, 1000);
	expect(FakeWebSocket.all).toHaveLength(2);

	// Second failure: one second is no longer enough.
	act(() => {
		FakeWebSocket.last?.onclose?.({ code: 1006 });
	});
	act(() => {
		vi.advanceTimersByTime(1000);
	});
	expect(FakeWebSocket.all).toHaveLength(2);
	act(() => {
		vi.advanceTimersByTime(1000);
	});
	expect(FakeWebSocket.all).toHaveLength(3);
});

test("a socket that worked for a while is retried straight away again", () => {
	mountSocket();
	act(() => {
		FakeWebSocket.last?.onopen?.();
		vi.advanceTimersByTime(10_000);
	});
	closeLatest(1006, 1000);
	expect(FakeWebSocket.all).toHaveLength(2);

	// And the wait after that is the first one again, not a doubled one.
	act(() => {
		FakeWebSocket.last?.onopen?.();
		vi.advanceTimersByTime(10_000);
	});
	closeLatest(1006, 1000);
	expect(FakeWebSocket.all).toHaveLength(3);
});

test("a reconnected socket refetches everything, because frames were missed", () => {
	const { invalidate } = mountSocket();
	act(() => {
		FakeWebSocket.last?.onopen?.();
	});
	expect(invalidate).not.toHaveBeenCalled();

	closeLatest(1006, 1000);
	act(() => {
		FakeWebSocket.last?.onopen?.();
	});
	const keys = invalidate.mock.calls.map((call) => call[0]?.queryKey);
	expect(keys).toContainEqual(fileKeys.git("ws", "pid", false));
	expect(keys).toContainEqual(fileKeys.git("ws", "pid", true));
	// The whole-project refetch is the last thing a reconnect asks for.
	const predicate = invalidate.mock.calls
		.map((call) => call[0]?.predicate)
		.filter((value) => value !== undefined)
		.at(-1);
	if (!predicate) throw new Error("a reconnect needs the whole-project refetch");
	expect(predicate({ queryKey: fileKeys.tree("ws", "pid", "src") } as never)).toBe(
		true,
	);
});
