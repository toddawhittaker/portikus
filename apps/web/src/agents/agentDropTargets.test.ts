import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import {
	type AgentDropTarget,
	registerAgentDropTarget,
	useAgentDropTargets,
} from "./agentDropTargets";

const cleanups: Array<() => void> = [];

function register(
	terminalId: string,
	label = "Claude Code (TUI)",
	kind: AgentDropTarget["kind"] = "terminal",
) {
	const target: AgentDropTarget = {
		terminalId,
		kind,
		label,
		deliver: vi.fn(async () => {}),
	};
	cleanups.push(registerAgentDropTarget(target));
	return target;
}

afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

test("a registered pane is listed, in the order it registered", () => {
	const { result } = renderHook(() => useAgentDropTargets());
	expect(result.current).toEqual([]);
	let a: AgentDropTarget | undefined;
	let b: AgentDropTarget | undefined;
	act(() => {
		a = register("a");
		b = register("b", "Codex (GUI)", "chat");
	});
	expect(result.current).toEqual([a, b]);
});

test("a second registration for the same id replaces the first and keeps its place", () => {
	const { result } = renderHook(() => useAgentDropTargets());
	let second: AgentDropTarget | undefined;
	act(() => {
		register("a", "old");
		register("b");
		second = register("a", "new");
	});
	expect(result.current.map((t) => t.terminalId)).toEqual(["a", "b"]);
	expect(result.current[0]).toBe(second);
});

test("unregistering removes the pane, and the hook follows", () => {
	const { result } = renderHook(() => useAgentDropTargets());
	let off: () => void = () => {};
	act(() => {
		register("a");
		off = registerAgentDropTarget({
			terminalId: "b",
			kind: "chat",
			label: "x",
			deliver: async () => {},
		});
	});
	expect(result.current).toHaveLength(2);
	act(() => off());
	expect(result.current.map((t) => t.terminalId)).toEqual(["a"]);
});

test("a replaced registration's old unregister does not remove the newer one", () => {
	const { result } = renderHook(() => useAgentDropTargets());
	let offOld: () => void = () => {};
	act(() => {
		offOld = registerAgentDropTarget({
			terminalId: "a",
			kind: "terminal",
			label: "old",
			deliver: async () => {},
		});
		register("a", "new");
	});
	act(() => offOld());
	expect(result.current.map((t) => t.label)).toEqual(["new"]);
});

test("unregistering twice is harmless", () => {
	let off: () => void = () => {};
	act(() => {
		off = registerAgentDropTarget({
			terminalId: "a",
			kind: "terminal",
			label: "x",
			deliver: async () => {},
		});
	});
	act(() => {
		off();
		off();
	});
	const { result } = renderHook(() => useAgentDropTargets());
	expect(result.current).toEqual([]);
});

test("the list is stable between changes", () => {
	const { result, rerender } = renderHook(() => useAgentDropTargets());
	act(() => {
		register("a");
	});
	const before = result.current;
	rerender();
	expect(result.current).toBe(before);
});
