import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { ChatServerEvent } from "@portikus/contracts";
import { describe, expect, test } from "vitest";
import {
	buildSnapshot,
	REPLAY_IMAGE_TURNS,
	REPLAY_TURNS,
	replayHistory,
} from "./snapshot.js";

const SESSION = "0b7e0a8e-3c1e-4c38-9a4e-2f0f6f7d1a11";
const PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGP4z8AARwzEcQCukw/x0F8jngAAAABJRU5ErkJggg==";

function entry(
	type: "user" | "assistant",
	message: unknown,
	parent: string | null = null,
): SessionMessage {
	return {
		type,
		uuid: crypto.randomUUID(),
		session_id: SESSION,
		message,
		parent_tool_use_id: parent,
		parent_agent_id: null,
	};
}

/** One turn: a prompt, a Read that returns an image, and a reply. */
function turn(n: number, image = PNG): SessionMessage[] {
	return [
		entry("user", { role: "user", content: `prompt ${n}` }),
		entry("assistant", {
			id: `m${n}`,
			content: [
				{ type: "tool_use", id: `t${n}`, name: "Read", input: { file_path: "a.png" } },
			],
		}),
		entry("user", {
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: `t${n}`,
					content: [
						{
							type: "image",
							source: { type: "base64", media_type: "image/png", data: image },
						},
					],
				},
			],
		}),
		entry("assistant", {
			id: `r${n}`,
			content: [{ type: "text", text: `reply ${n}` }],
		}),
	];
}

describe("history replay", () => {
	test("one turn replays as contract events in order", () => {
		const { events, truncated } = replayHistory(turn(1), false);
		expect(truncated).toBe(false);
		expect(events.map((event) => event.type)).toEqual([
			"turn.started",
			"message",
			"tool.started",
			"tool.output",
			"tool.finished",
			"message",
			"turn.finished",
		]);
		for (const event of events) {
			expect(
				ChatServerEvent.safeParse({ ...event, sessionId: SESSION, seq: 1 }).success,
			).toBe(true);
		}
	});

	test(`only the last ${REPLAY_TURNS} turns replay, and older ones set truncated`, () => {
		const entries = Array.from({ length: REPLAY_TURNS + 3 }, (_, i) => turn(i)).flat();
		const { events, truncated } = replayHistory(entries, false);
		expect(truncated).toBe(true);
		const prompts = events.filter((e) => e.type === "message" && e.role === "user");
		expect(prompts).toHaveLength(REPLAY_TURNS);
		expect(prompts[0]).toMatchObject({ markdown: "prompt 3" });
	});

	test(`images older than the last ${REPLAY_IMAGE_TURNS} turns are omitted`, () => {
		const entries = Array.from({ length: 8 }, (_, i) => turn(i)).flat();
		const parts = replayHistory(entries, false).events.flatMap((e) =>
			e.type === "tool.output" ? [e.part.type] : [],
		);
		expect(parts).toEqual([
			...Array(8 - REPLAY_IMAGE_TURNS).fill("imageOmitted"),
			...Array(REPLAY_IMAGE_TURNS).fill("image"),
		]);
	});

	test("an image too large for one frame is omitted", () => {
		const parts = replayHistory(turn(1, "A".repeat(4000)), false, 2000).events.flatMap(
			(e) => (e.type === "tool.output" ? [e.part] : []),
		);
		expect(parts).toEqual([{ type: "imageOmitted", mediaType: "image/png" }]);
	});

	test("a running turn is left open, and subagent entries are skipped", () => {
		const entries = [
			...turn(1),
			entry(
				"assistant",
				{ id: "sub", content: [{ type: "text", text: "subagent" }] },
				"t1",
			),
		];
		const { events } = replayHistory(entries, true);
		expect(events.some((e) => e.type === "turn.finished")).toBe(false);
		expect(events.some((e) => e.type === "message" && e.markdown === "subagent")).toBe(
			false,
		);
	});
});

describe("snapshot", () => {
	test("holds cards, the turn state, truncated, and only the reply streaming now", () => {
		const snapshot = buildSnapshot({
			sessionId: SESSION,
			seq: 4,
			cards: [],
			turnRunning: true,
			truncated: true,
			streaming: { id: "m1", role: "assistant", markdown: "Wor" },
		});
		expect(snapshot).toMatchObject({
			messages: [{ id: "m1", markdown: "Wor" }],
			turnRunning: true,
			truncated: true,
		});
		expect(ChatServerEvent.safeParse(snapshot).success).toBe(true);
		expect(
			buildSnapshot({
				sessionId: SESSION,
				seq: 0,
				cards: [],
				turnRunning: false,
				truncated: false,
				streaming: null,
			}).messages,
		).toEqual([]);
	});
});
