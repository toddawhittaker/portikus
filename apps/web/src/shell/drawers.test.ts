import { expect, test } from "vitest";
import { openedTab } from "./drawers.js";

const state = (ids: string[], active: string | null) => ({
	layout: { tabs: ids.map((id) => ({ id })) },
	activeTabId: active,
});

test("a new tab, or a switch to another open tab, counts as opening one", () => {
	expect(openedTab(state(["a"], "a"), state(["a", "b"], "b"))).toBe(true);
	expect(openedTab(state([], null), state(["a"], "a"))).toBe(true);
	expect(openedTab(state(["a", "b"], "b"), state(["a", "b"], "a"))).toBe(true);
});

test("a tab closing on its own, or no change, does not", () => {
	expect(openedTab(state(["a", "b"], "b"), state(["a"], "a"))).toBe(false);
	expect(openedTab(state(["a"], "a"), state([], null))).toBe(false);
	expect(openedTab(state(["a"], "a"), state(["a"], "a"))).toBe(false);
});
