import type { CodingAgentState, CodingAgentTerminal } from "@portikus/contracts";
import { describe, expect, it } from "vitest";
import {
	alertTitle,
	createAgentStatusStore,
	marksByProject,
	mostUrgent,
	urgency,
} from "./codingAgentStatus.js";

const P1 = "11111111-1111-4111-8111-111111111111";
const P2 = "22222222-2222-4222-8222-222222222222";

function term(
	terminalId: string,
	state: CodingAgentState,
	projectId = P1,
	agent: "claude" | "codex" = "claude",
): CodingAgentTerminal {
	return { terminalId, projectId, agent, state, since: "2026-11-01T10:00:00.000Z" };
}

/** A store whose window focus the test controls. */
function makeStore(initialFocus = true) {
	const focus = { on: initialFocus };
	const store = createAgentStatusStore(() => focus.on);
	return { store, focus };
}

describe("urgency", () => {
	it("ranks needs input over an unread finish over working, and hides a seen finish", () => {
		expect(urgency({ state: "needs-input", unread: false })).toBeGreaterThan(
			urgency({ state: "finished", unread: true }),
		);
		expect(urgency({ state: "finished", unread: true })).toBeGreaterThan(
			urgency({ state: "working", unread: false }),
		);
		expect(urgency({ state: "finished", unread: false })).toBe(0);
	});

	it("picks the most urgent mark and null when none is worth showing", () => {
		expect(
			mostUrgent([
				{ state: "working", unread: false },
				{ state: "needs-input", unread: false },
				{ state: "finished", unread: true },
			]),
		).toEqual({ state: "needs-input", unread: false });
		expect(mostUrgent([{ state: "finished", unread: false }])).toBeNull();
		expect(mostUrgent([])).toBeNull();
	});

	it("words the alert title", () => {
		expect(alertTitle("claude", "needs-input")).toBe("Claude Code needs your input");
		expect(alertTitle("codex", "finished")).toBe("Codex finished");
	});
});

describe("the first list on a connection", () => {
	it("raises no alert and no unread mark", () => {
		const { store } = makeStore();
		const alerts = store.update(
			[term("a", "finished"), term("b", "needs-input")],
			true,
		);
		expect(alerts).toEqual([]);
		expect(store.getSnapshot().unread.size).toBe(0);
	});

	it("is the baseline: the same states afterwards are not news", () => {
		const { store } = makeStore();
		store.update([term("a", "finished")], true);
		expect(store.update([term("a", "finished")], false)).toEqual([]);
	});
});

describe("live changes", () => {
	it("alerts when an agent in a tab out of sight finishes or needs input", () => {
		const { store } = makeStore();
		store.update([term("a", "working"), term("b", "working", P2, "codex")], true);
		const alerts = store.update(
			[term("a", "finished"), term("b", "needs-input", P2, "codex")],
			false,
		);
		expect(alerts).toEqual([
			{ terminalId: "a", projectId: P1, agent: "claude", state: "finished" },
			{ terminalId: "b", projectId: P2, agent: "codex", state: "needs-input" },
		]);
		expect([...store.getSnapshot().unread]).toEqual(["a", "b"]);
	});

	it("does not alert for working, or for a state that did not change", () => {
		const { store } = makeStore();
		store.update([term("a", "needs-input")], true);
		expect(store.update([term("a", "needs-input")], false)).toEqual([]);
		expect(store.update([term("a", "working")], false)).toEqual([]);
	});

	it("alerts for a terminal that first appears already finished", () => {
		const { store } = makeStore();
		store.update([], true);
		expect(store.update([term("a", "finished")], false)).toHaveLength(1);
	});

	it("does not alert while the student is looking at that tab with the window focused", () => {
		const { store } = makeStore();
		store.setViewing(["a"]);
		store.update([term("a", "working")], true);
		expect(store.update([term("a", "finished")], false)).toEqual([]);
		expect(store.getSnapshot().unread.size).toBe(0);
	});

	it("alerts when the tab is on screen but the window lacks focus", () => {
		const { store, focus } = makeStore(false);
		store.setViewing(["a"]);
		store.update([term("a", "working")], true);
		expect(store.update([term("a", "finished")], false)).toHaveLength(1);
		expect(store.getSnapshot().unread.has("a")).toBe(true);
		focus.on = true;
		store.refresh();
		expect(store.getSnapshot().unread.has("a")).toBe(false);
	});

	it("alerts when another tab is the one on screen", () => {
		const { store } = makeStore();
		store.setViewing(["other"]);
		store.update([term("a", "working")], true);
		expect(store.update([term("a", "finished")], false)).toHaveLength(1);
	});
});

describe("unread", () => {
	it("clears when the tab is shown with the window focused, and says which cleared", () => {
		const { store } = makeStore();
		const seen: string[][] = [];
		store.onSeen((ids) => seen.push(ids));
		store.update([term("a", "working"), term("b", "working")], true);
		store.update([term("a", "finished"), term("b", "finished")], false);
		store.setViewing(["a"]);
		expect([...store.getSnapshot().unread]).toEqual(["b"]);
		expect(seen).toEqual([["a"]]);
	});

	it("stays while the window lacks focus", () => {
		const { store } = makeStore(false);
		store.update([term("a", "working")], true);
		store.update([term("a", "finished")], false);
		store.setViewing(["a"]);
		expect(store.getSnapshot().unread.has("a")).toBe(true);
	});

	it("survives the open tab changing, and goes when the terminal does", () => {
		const { store } = makeStore();
		store.update([term("a", "working")], true);
		store.update([term("a", "finished")], false);
		store.setViewing([]);
		expect(store.getSnapshot().unread.has("a")).toBe(true);
		store.update([], false);
		expect(store.getSnapshot().unread.size).toBe(0);
	});

	it("is kept across a list that leaves the state alone", () => {
		const { store } = makeStore();
		store.update([term("a", "working")], true);
		store.update([term("a", "finished")], false);
		store.update([term("a", "finished")], false);
		expect(store.getSnapshot().unread.has("a")).toBe(true);
	});
});

describe("project aggregation", () => {
	it("shows each project's most urgent terminal", () => {
		const { store } = makeStore();
		store.update(
			[
				term("a", "working", P1),
				term("b", "needs-input", P1),
				term("c", "finished", P2),
				term("d", "working", P2),
			],
			true,
		);
		// The finish at connect time is not unread, so P2 falls back to working.
		expect(marksByProject(store.getSnapshot()).get(P1)?.state).toBe("needs-input");
		expect(marksByProject(store.getSnapshot()).get(P2)?.state).toBe("working");
		store.update(
			[term("a", "working", P1), term("c", "working", P2), term("d", "finished", P2)],
			false,
		);
		const marks = marksByProject(store.getSnapshot());
		expect(marks.get(P1)).toEqual({ state: "working", unread: false });
		expect(marks.get(P2)).toEqual({ state: "finished", unread: true });
	});

	it("leaves out a project whose agents all finished and were seen", () => {
		const { store } = makeStore();
		store.update([term("a", "finished", P1)], true);
		expect(marksByProject(store.getSnapshot()).has(P1)).toBe(false);
	});
});
