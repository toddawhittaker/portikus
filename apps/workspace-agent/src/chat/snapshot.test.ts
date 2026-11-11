import type { SessionMessage } from "@anthropic-ai/claude-agent-sdk";
import { ChatServerEvent } from "@portikus/contracts";
import { describe, expect, test } from "vitest";
import {
	buildSnapshot,
	REPLAY_IMAGE_TURNS,
	REPLAY_SUBAGENT_ENTRIES,
	REPLAY_TURNS,
	replayHistory,
	replaySubagent,
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

describe("replayed turns", () => {
	const at = (iso: string) => ({ timestamp: iso });
	function stamped(e: SessionMessage, iso: string, more: object = {}): SessionMessage {
		return { ...e, ...at(iso), ...more } as SessionMessage;
	}
	const marker = (text: string) =>
		entry("user", { role: "user", content: [{ type: "text", text }] });

	test("turn events carry the transcript's start and finish times", () => {
		const [prompt, ...rest] = turn(1);
		const entries = [
			stamped(prompt as SessionMessage, "2026-11-07T10:00:00.000Z"),
			...rest.slice(0, -1),
			stamped(rest.at(-1) as SessionMessage, "2026-11-07T10:03:43.000Z"),
		];
		const { events } = replayHistory(entries, false);
		expect(events[0]).toEqual({
			type: "turn.started",
			at: Date.parse("2026-11-07T10:00:00.000Z"),
		});
		expect(events.at(-1)).toEqual({
			type: "turn.finished",
			status: "done",
			at: Date.parse("2026-11-07T10:03:43.000Z"),
		});
	});

	test("an interrupted turn replays as interrupted, and its marker is not a student message", () => {
		for (const text of [
			"[Request interrupted by user]",
			"[Request interrupted by user for tool use]",
		]) {
			const entries = [...turn(1).slice(0, 2), marker(text), ...turn(2)];
			const { events } = replayHistory(entries, false);
			expect(events.filter((e) => e.type === "turn.finished")).toMatchObject([
				{ status: "interrupted" },
				{ status: "done" },
			]);
			const typed = events.filter((e) => e.type === "message" && e.role === "user");
			expect(typed.map((e) => (e as { markdown: string }).markdown)).toEqual([
				"prompt 1",
				"prompt 2",
			]);
		}
	});

	test("a turn ending in an API error replays as error, without the error as a reply", () => {
		const entries = [
			entry("user", { role: "user", content: "hi" }),
			entry("assistant", {
				id: "e1",
				model: "<synthetic>",
				content: [{ type: "text", text: "API Error: Can't reach the API server" }],
			}),
		];
		const { events } = replayHistory(entries, false);
		expect(events.at(-1)).toMatchObject({ type: "turn.finished", status: "error" });
		expect(events.some((e) => e.type === "message" && e.role === "assistant")).toBe(
			false,
		);
	});

	test("Claude Code's own user entries are not shown and start no turn", () => {
		const entries = [
			...turn(1),
			{
				...marker("<task-notification>done</task-notification>"),
				origin: { kind: "task-notification" },
			} as SessionMessage,
			{ ...marker("caveat"), is_meta: true } as SessionMessage,
			{
				...marker("<command-name>/clear</command-name>"),
				isCompletedLocalCommand: true,
			} as SessionMessage,
			{
				...entry("user", { role: "user", content: "typed" }),
				origin: { kind: "human" },
			} as SessionMessage,
		];
		const { events } = replayHistory(entries, false);
		expect(events.filter((e) => e.type === "turn.started")).toHaveLength(2);
		const typed = events.filter((e) => e.type === "message" && e.role === "user");
		expect(typed.map((e) => (e as { markdown: string }).markdown)).toEqual([
			"prompt 1",
			"typed",
		]);
	});

	test("an image-only message is a typed message, with its attachments as paths", () => {
		const entries = [
			entry("user", {
				role: "user",
				content: [
					{ type: "text", text: "Attached file: .portikus/pastes/1/red.png" },
					{
						type: "image",
						source: { type: "base64", media_type: "image/png", data: PNG },
					},
				],
			}),
			entry("user", {
				role: "user",
				content: [
					{
						type: "image",
						source: { type: "base64", media_type: "image/png", data: PNG },
					},
				],
			}),
		];
		const { events } = replayHistory(entries, false);
		expect(events.filter((e) => e.type === "turn.started")).toHaveLength(2);
		expect(events.filter((e) => e.type === "message")).toMatchObject([
			{
				role: "user",
				markdown: "",
				attachments: [{ path: ".portikus/pastes/1/red.png" }],
			},
			{ role: "user", markdown: "" },
		]);
	});
});

describe("snapshot", () => {
	test("holds cards, the turn state and truncated, and never messages", () => {
		const snapshot = buildSnapshot({
			sessionId: SESSION,
			seq: 4,
			cards: [],
			turnRunning: true,
			truncated: true,
		});
		expect(snapshot).toMatchObject({ turnRunning: true, truncated: true });
		expect(snapshot).not.toHaveProperty("messages");
		expect(ChatServerEvent.safeParse(snapshot).success).toBe(true);
	});
});

describe("shell commands on replay", () => {
	const input = (command: string) =>
		entry("user", { role: "user", content: `<bash-input>${command}</bash-input>` });
	const output = (stdout: string, stderr = "") =>
		entry("user", {
			role: "user",
			content: `<bash-stdout>${stdout}</bash-stdout><bash-stderr>${stderr}</bash-stderr>`,
		});

	test("a command and its output come back as one shell item, outside any turn", () => {
		const ran = input("ls");
		const { events } = replayHistory(
			[...turn(1), ran, output("a\nb\n", "Exit code 2"), ...turn(2)],
			false,
		);
		const types = events.map((event) => event.type);
		const shellAt = types.indexOf("shell");
		expect(types[shellAt - 1]).toBe("turn.finished");
		expect(types[shellAt + 1]).toBe("turn.started");
		expect(events[shellAt]).toEqual({
			type: "shell",
			id: ran.uuid,
			command: "ls",
			output: "a\nb\n",
			exitCode: 2,
			truncated: false,
			state: "done",
		});
		// The command is not shown as a typed message.
		expect(
			events.filter((event) => event.type === "message" && event.role === "user"),
		).toHaveLength(2);
		expect(
			ChatServerEvent.safeParse({ ...events[shellAt], sessionId: SESSION, seq: 1 })
				.success,
		).toBe(true);
	});

	test("a command with no output yet is left for the live host to show", () => {
		const { events } = replayHistory([...turn(1), input("sleep 9")], false);
		expect(events.some((event) => event.type === "shell")).toBe(false);
	});

	test("a command first in the transcript replays on its own", () => {
		const { events } = replayHistory([input("pwd"), output("/p\n")], false);
		expect(events.map((event) => event.type)).toEqual(["shell"]);
	});
});

describe("replaySubagent", () => {
	const CALL = "toolu_agent";
	const prompt = entry("user", { role: "user", content: "Count the routes." }, CALL);
	const work = [
		entry(
			"assistant",
			{
				id: "s1",
				content: [
					{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "a.png" } },
				],
			},
			CALL,
		),
		entry(
			"user",
			{
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "t1",
						content: [
							{
								type: "image",
								source: { type: "base64", media_type: "image/png", data: PNG },
							},
						],
					},
				],
			},
			CALL,
		),
		entry(
			"assistant",
			{ id: "s2", content: [{ type: "text", text: "There are 4." }] },
			CALL,
		),
	];

	test("a finished subagent replays as one turn: its prompt, its work with images, its reply", () => {
		const { events, truncated } = replaySubagent([prompt, ...work], false, 1000);
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
		expect(events[1]).toMatchObject({ role: "user", markdown: "Count the routes." });
		expect(events[3]).toMatchObject({ part: { type: "image" } });
		expect(events.at(-1)).toMatchObject({ status: "done" });
	});

	test("a running subagent's turn is left open", () => {
		const { events } = replaySubagent([prompt], true, 1000);
		expect(events.map((event) => event.type)).toEqual(["turn.started", "message"]);
	});

	test("an empty transcript of a running subagent starts its turn now", () => {
		expect(replaySubagent([], true, 1234).events).toEqual([
			{ type: "turn.started", at: 1234 },
		]);
	});

	test("only the newest entries replay, without the prompt, and say older ones exist", () => {
		const reply = (n: number) =>
			entry(
				"assistant",
				{ id: `r${n}`, content: [{ type: "text", text: `${n}` }] },
				CALL,
			);
		const many = [
			prompt,
			...Array.from({ length: REPLAY_SUBAGENT_ENTRIES }, (_, n) => reply(n)),
		];
		const { events, truncated } = replaySubagent(many, false, 1000);
		expect(truncated).toBe(true);
		const messages = events.filter((event) => event.type === "message");
		expect(messages).toHaveLength(REPLAY_SUBAGENT_ENTRIES);
		expect(messages.every((event) => event.role === "assistant")).toBe(true);
	});

	test("an image too large for a frame becomes imageOmitted", () => {
		const { events } = replaySubagent([prompt, ...work], false, 1000, 250);
		expect(events.find((event) => event.type === "tool.output")).toMatchObject({
			part: { type: "imageOmitted" },
		});
	});
});
