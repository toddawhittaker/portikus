import { describe, expect, test } from "vitest";
import { PERMISSION_OPTION } from "./claude-adapter.js";
import {
	DecisionMemory,
	decisionForOption,
	MAX_REMEMBERED_DECISIONS,
} from "./decisions.js";

const started = (id: string) =>
	({ type: "tool.started", id, name: "Bash", title: "Bash", input: {} }) as const;

describe("decisionForOption", () => {
	test("each permission option maps to a fixed word", () => {
		expect(decisionForOption(PERMISSION_OPTION.allowOnce)).toBe("allowed");
		expect(decisionForOption(PERMISSION_OPTION.allowAlways)).toBe("allowedAlways");
		expect(decisionForOption(PERMISSION_OPTION.deny)).toBe("denied");
		expect(decisionForOption(PERMISSION_OPTION.planAcceptEdits)).toBe("allowed");
		expect(decisionForOption(PERMISSION_OPTION.planAskEdits)).toBe("allowed");
	});
});

describe("DecisionMemory", () => {
	test("replays a decision only for a tool call the history shows", () => {
		const memory = new DecisionMemory();
		memory.record("t1", "allowed");
		memory.record("t2", "denied");
		expect(memory.replayFor([started("t2"), started("other")])).toEqual([
			{ type: "card.resolved", id: "t2", decision: "denied" },
		]);
	});

	test("clear forgets every decision", () => {
		const memory = new DecisionMemory();
		memory.record("t1", "allowed");
		memory.clear();
		expect(memory.replayFor([started("t1")])).toEqual([]);
	});

	test("keeps the newest 500 and drops the oldest", () => {
		const memory = new DecisionMemory();
		for (let i = 0; i <= MAX_REMEMBERED_DECISIONS; i++)
			memory.record(`t${i}`, "allowed");
		const ids = Array.from({ length: MAX_REMEMBERED_DECISIONS + 1 }, (_, i) =>
			started(`t${i}`),
		);
		const replayed = memory.replayFor(ids);
		expect(replayed).toHaveLength(MAX_REMEMBERED_DECISIONS);
		expect(replayed[0]).toMatchObject({ id: "t1" });
	});

	test("answering the same call again moves it to the newest", () => {
		const memory = new DecisionMemory();
		memory.record("a", "allowed");
		for (let i = 0; i < MAX_REMEMBERED_DECISIONS - 1; i++)
			memory.record(`t${i}`, "allowed");
		memory.record("a", "denied");
		memory.record("extra", "allowed");
		expect(memory.replayFor([started("a")])).toEqual([
			{ type: "card.resolved", id: "a", decision: "denied" },
		]);
	});
});
