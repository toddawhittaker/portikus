import { readFileSync } from "node:fs";
import type { SDKMessage, SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import {
	ChatServerEvent,
	MAX_CHAT_COMMANDS,
	MAX_CHAT_IMAGE_BYTES,
	MAX_CHAT_SERVER_FRAME_BYTES,
} from "@portikus/contracts";
import { describe, expect, test } from "vitest";
import {
	type ChatEventBody,
	ClaudeMessageMapper,
	cardForTool,
	chatCommands,
	imagePart,
	limitsFromUsage,
	MAX_CARD_INPUT_BYTES,
	mergeRateLimits,
	PERMISSION_OPTION,
	permissionResult,
	questionResult,
	shortenedInput,
	toolResultParts,
} from "./claude-adapter.js";

/**
 * Frames recorded from Claude Code 2.1.319 through the Agent SDK with
 * Haiku (test-fixtures/record.mjs): a Bash call, a Read of a PNG, then an
 * AskUserQuestion answered with a note.
 */
const recorded = readFileSync(
	new URL("./test-fixtures/claude-turns.jsonl", import.meta.url),
	"utf8",
)
	.trim()
	.split("\n")
	.map((line) => JSON.parse(line) as SDKMessage);

function replay(): ChatEventBody[] {
	const mapper = new ClaudeMessageMapper();
	return recorded.flatMap((message) => mapper.map(message));
}

describe("mapping recorded SDK frames", () => {
	const events = replay();

	test("every event fits the contract once stamped", () => {
		for (const event of events) {
			expect(
				ChatServerEvent.safeParse({ ...event, sessionId: crypto.randomUUID(), seq: 1 })
					.success,
			).toBe(true);
		}
	});

	test("tool calls start, report output and finish in order", () => {
		const bash = events.filter(
			(event) => "id" in event && event.id === "toolu_fixture_0001",
		);
		expect(bash.map((event) => event.type)).toEqual([
			"tool.started",
			"tool.output",
			"tool.finished",
		]);
		expect(bash[0]).toMatchObject({
			name: "Bash",
			title: "Print hello-portikus test string",
			input: { command: "echo hello-portikus" },
		});
		expect(bash[1]).toMatchObject({ part: { type: "text", text: "hello-portikus" } });
		expect(bash[2]).toMatchObject({ isError: false });
	});

	test("an image a tool returns arrives as an image part", () => {
		const output = events.find(
			(event) => event.type === "tool.output" && event.id === "toolu_fixture_0002",
		);
		expect(output).toMatchObject({ part: { type: "image", mediaType: "image/png" } });
	});

	test("text streams as deltas and lands as one Markdown message per reply", () => {
		const deltas = events.filter((event) => event.type === "text.delta");
		const messages = events.filter((event) => event.type === "message");
		expect(messages.map((event) => event.markdown)).toEqual([
			"Done",
			"Blue, with the note: navy please.",
		]);
		const last = messages[1] as Extract<ChatEventBody, { type: "message" }>;
		expect(
			deltas
				.filter((event) => event.messageId === last.id)
				.map((event) => event.text)
				.join(""),
		).toBe(last.markdown);
	});

	test("the question tool shows as a started tool", () => {
		expect(
			events.some(
				(event) => event.type === "tool.started" && event.name === "AskUserQuestion",
			),
		).toBe(true);
	});

	test("the recorded rate limit event carries no top-level figure, so it fills nothing", () => {
		const event = recorded.find(
			(message) => message.type === "rate_limit_event",
		) as Extract<SDKMessage, { type: "rate_limit_event" }>;
		expect(mergeRateLimits({}, event.rate_limit_info)).toEqual({});
	});
});

describe("tool output parts", () => {
	test("SVG is never shown as an image", () => {
		expect(
			imagePart({
				type: "image",
				source: { type: "base64", media_type: "image/svg+xml", data: "PHN2Zz4=" },
			}),
		).toEqual({ type: "text", text: "[image in a format the chat does not show]" });
	});

	test("an image over the cap is omitted", () => {
		const data = "A".repeat(Math.ceil((MAX_CHAT_IMAGE_BYTES + 3) / 3) * 4);
		expect(
			imagePart({
				type: "image",
				source: { type: "base64", media_type: "image/png", data },
			}),
		).toEqual({ type: "imageOmitted", mediaType: "image/png" });
	});

	test("a plain string result is one text part", () => {
		expect(toolResultParts("ok")).toEqual([{ type: "text", text: "ok" }]);
	});
});

describe("rate limits", () => {
	test("the overage-included weekly window counts as the seven-day window", () => {
		expect(
			mergeRateLimits({}, {
				status: "allowed",
				rateLimitType: "seven_day_overage_included",
				utilization: 0.4237,
				resetsAt: 1794200000,
			} as SDKRateLimitInfo),
		).toEqual({ seven_day: { used_percentage: 42.4, resets_at: 1794200000 } });
	});

	test("a later seven-day event replaces the figure, capped at 100", () => {
		const first = mergeRateLimits({}, {
			status: "allowed",
			rateLimitType: "seven_day",
			utilization: 0.5,
			resetsAt: 1794200000,
		} as SDKRateLimitInfo);
		expect(
			mergeRateLimits(first, {
				status: "allowed",
				rateLimitType: "seven_day",
				utilization: 1.4,
				resetsAt: 1800000000,
			} as SDKRateLimitInfo),
		).toEqual({ seven_day: { used_percentage: 100, resets_at: 1800000000 } });
	});

	test("five-hour, per-model and figure-less events change nothing", () => {
		const known = { seven_day: { used_percentage: 5, resets_at: 1794200000 } };
		for (const info of [
			{ rateLimitType: "five_hour", utilization: 0.4, resetsAt: 1794200000 },
			{ rateLimitType: "seven_day_opus", utilization: 0.4, resetsAt: 1794200000 },
			{ rateLimitType: "seven_day" },
			{ rateLimitType: "seven_day", utilization: -1, resetsAt: 1794200000 },
		]) {
			expect(
				mergeRateLimits(known, { status: "allowed", ...info } as SDKRateLimitInfo),
			).toBe(known);
		}
	});
});

describe("limitsFromUsage", () => {
	const usage = (rateLimits: unknown, available = true) =>
		({ rate_limits_available: available, rate_limits: rateLimits }) as never;

	test("takes the seven-day window, utilization as given and the reset in epoch seconds", () => {
		expect(
			limitsFromUsage(
				usage({
					five_hour: { utilization: 90, resets_at: "2026-11-30T01:00:00Z" },
					seven_day: { utilization: 41.26, resets_at: "2026-12-01T09:00:00Z" },
				}),
			),
		).toEqual({ seven_day: { used_percentage: 41.3, resets_at: 1796115600 } });
	});

	test("returns nothing when plan limits do not apply or the window is unusable", () => {
		expect(limitsFromUsage(usage(null, false))).toEqual({});
		expect(
			limitsFromUsage(
				usage(
					{ seven_day: { utilization: 1, resets_at: "2026-12-01T09:00:00Z" } },
					false,
				),
			),
		).toEqual({});
		expect(limitsFromUsage(usage({}))).toEqual({});
		expect(limitsFromUsage(usage({ seven_day: null }))).toEqual({});
		expect(
			limitsFromUsage(usage({ seven_day: { utilization: null, resets_at: null } })),
		).toEqual({});
		expect(
			limitsFromUsage(usage({ seven_day: { utilization: 3, resets_at: "soon" } })),
		).toEqual({});
	});
});

describe("chatCommands", () => {
	test("marks menu commands and the SDK's terminal ones, and tidies names and hints", () => {
		expect(
			chatCommands(
				[
					{ name: "/compact", description: "Shrink", argumentHint: "[focus]" },
					{ name: "model", description: "Pick a model", argumentHint: "" },
					{ name: "statusline", description: "Set up", argumentHint: "" },
					{ name: "compact", description: "Duplicate", argumentHint: "" },
					{ name: "", description: "No name", argumentHint: "" },
				],
				new Set(["statusline"]),
			),
		).toEqual([
			{
				name: "compact",
				description: "Shrink",
				argumentHint: "[focus]",
				terminalOnly: false,
			},
			{ name: "model", description: "Pick a model", terminalOnly: true },
			{ name: "statusline", description: "Set up", terminalOnly: true },
		]);
	});

	test("lists no more than the contract allows", () => {
		const many = Array.from({ length: MAX_CHAT_COMMANDS + 20 }, (_, i) => ({
			name: `c${i}`,
			description: "x".repeat(300),
			argumentHint: "",
		}));
		const listed = chatCommands(many);
		expect(listed).toHaveLength(MAX_CHAT_COMMANDS);
		expect(listed[0]?.description).toHaveLength(200);
	});
});

const question = {
	question: "Which colour?",
	header: "Colour",
	multiSelect: false,
	options: [
		{ label: "Red", description: "warm" },
		{ label: "Blue", description: "cool" },
	],
};
const multi = {
	...question,
	question: "Which toppings?",
	header: "Toppings",
	multiSelect: true,
};

describe("cards", () => {
	test("a card for a huge input fits a frame, shortened visibly, and the tool keeps the full input", () => {
		const content = "x".repeat(12 * 1024 * 1024);
		const input = { file_path: "big.txt", content };
		const card = cardForTool("Write", input, { toolUseID: "toolu_big" });
		const frame = JSON.stringify({
			...card,
			type: "permission.requested",
			sessionId: "5d0f4a7e-0a51-4b8e-9d0e-6c3f1b2a9e10",
			seq: 1,
		});
		expect(Buffer.byteLength(frame)).toBeLessThanOrEqual(MAX_CARD_INPUT_BYTES + 1024);
		expect(Buffer.byteLength(frame)).toBeLessThan(MAX_CHAT_SERVER_FRAME_BYTES);
		const shown = card.type === "permission" ? (card.input as typeof input) : null;
		expect(shown?.file_path).toBe("big.txt");
		expect(shown?.content.endsWith("… (shortened)")).toBe(true);
		expect(
			permissionResult(PERMISSION_OPTION.allowOnce, input, { toolUseID: "t" }),
		).toEqual({ behavior: "allow", updatedInput: input });
	});

	test("a tool call with a huge input starts with it shortened, so its frame is not dropped", () => {
		const events = new ClaudeMessageMapper().map({
			type: "assistant",
			message: {
				id: "msg_big",
				content: [
					{
						type: "tool_use",
						id: "toolu_w",
						name: "Write",
						input: { file_path: "big.txt", content: "z".repeat(12 * 1024 * 1024) },
					},
				],
			},
		} as never);
		const started = events.find((e) => e.type === "tool.started");
		expect(Buffer.byteLength(JSON.stringify(started))).toBeLessThan(
			MAX_CARD_INPUT_BYTES + 1024,
		);
		expect(
			(started as unknown as { input: { content: string } }).input.content.endsWith(
				"… (shortened)",
			),
		).toBe(true);
	});

	test("a small input is shown whole, and many short strings still fit", () => {
		expect(shortenedInput({ command: "ls" })).toEqual({ command: "ls" });
		const many = { items: Array.from({ length: 2000 }, () => "y".repeat(200)) };
		expect(
			Buffer.byteLength(JSON.stringify(shortenedInput(many, 64 * 1024))),
		).toBeLessThanOrEqual(64 * 1024);
	});

	test("AskUserQuestion becomes a question card keyed by the tool call", () => {
		expect(
			cardForTool("AskUserQuestion", { questions: [question] }, { toolUseID: "t1" }),
		).toEqual({
			type: "question",
			id: "t1",
			questions: [question],
		});
	});

	test("a question the contract cannot hold falls back to a permission card", () => {
		const card = cardForTool("AskUserQuestion", { questions: [] }, { toolUseID: "t1" });
		expect(card.type).toBe("permission");
	});

	test("ExitPlanMode shows the plan on a permission card", () => {
		const card = cardForTool("ExitPlanMode", { plan: "1. do it" }, { toolUseID: "t2" });
		expect(card).toMatchObject({
			type: "permission",
			toolName: "ExitPlanMode",
			input: { plan: "1. do it" },
		});
	});

	test("Always allow is offered only when the SDK suggests a rule", () => {
		const suggestion = {
			type: "addRules" as const,
			rules: [{ toolName: "Bash", ruleContent: "ls" }],
			behavior: "allow" as const,
			destination: "session" as const,
		};
		const ids = (ask: Parameters<typeof cardForTool>[2]) => {
			const card = cardForTool("Bash", { command: "ls" }, ask);
			return card.type === "permission" ? card.options.map((option) => option.id) : [];
		};
		expect(ids({ toolUseID: "a" })).toEqual(["allow", "deny"]);
		expect(ids({ toolUseID: "a", suggestions: [suggestion] })).toEqual([
			"allow",
			"always",
			"deny",
		]);
		expect(
			ids({ toolUseID: "a", suggestions: [suggestion], suppressAlwaysAllowRule: true }),
		).toEqual(["allow", "deny"]);
		expect(
			permissionResult(
				PERMISSION_OPTION.allowAlways,
				{ command: "ls" },
				{
					toolUseID: "a",
					suggestions: [suggestion],
				},
			),
		).toEqual({
			// The host holds session rules itself so they can be revoked.
			behavior: "allow",
			updatedInput: { command: "ls" },
		});
		expect(permissionResult("deny", {}, { toolUseID: "a" }).behavior).toBe("deny");
	});
});

describe("question answers", () => {
	const input = { questions: [question, multi] };

	test("picks are answers, and a note beside a pick is an annotation", () => {
		expect(
			questionResult(
				input,
				[question, multi],
				{ "Which colour?": "Blue", "Which toppings?": "Cheese, Olives" },
				{ "Which colour?": " navy please " },
			),
		).toEqual({
			behavior: "allow",
			updatedInput: {
				...input,
				answers: { "Which colour?": "Blue", "Which toppings?": "Cheese, Olives" },
				annotations: { "Which colour?": { notes: "navy please" } },
			},
		});
	});

	test("Other text with nothing picked is the answer", () => {
		expect(
			questionResult(input, [question, multi], {}, { "Which colour?": "Green" }),
		).toEqual({
			behavior: "allow",
			updatedInput: { ...input, answers: { "Which colour?": "Green" } },
		});
	});

	test("a skipped question is marked skipped when the session allows it", () => {
		expect(
			questionResult(input, [question, multi], { "Which colour?": "Blue" }, {}, true),
		).toEqual({
			behavior: "allow",
			updatedInput: {
				...input,
				answers: { "Which colour?": "Blue" },
				annotations: { "Which toppings?": { unanswered: "skipped" } },
			},
		});
	});

	test("without the capability a skipped question is only left out", () => {
		expect(
			questionResult(input, [question, multi], { "Which colour?": "Blue" }, {}, false),
		).toEqual({
			behavior: "allow",
			updatedInput: { ...input, answers: { "Which colour?": "Blue" } },
		});
	});
});

describe("subagent messages", () => {
	test("a subagent's tool calls and results stay out of the top level, as on replay", () => {
		const mapper = new ClaudeMessageMapper();
		const parent = "toolu_task";
		expect(
			mapper.map({
				type: "assistant",
				parent_tool_use_id: parent,
				message: {
					id: "msg_sub",
					content: [{ type: "tool_use", id: "toolu_sub", name: "Read", input: {} }],
				},
			} as never),
		).toEqual([]);
		expect(
			mapper.map({
				type: "user",
				parent_tool_use_id: parent,
				message: {
					role: "user",
					content: [{ type: "tool_result", tool_use_id: "toolu_sub", content: "x" }],
				},
			} as never),
		).toEqual([]);
		expect(
			mapper.map({
				type: "assistant",
				parent_tool_use_id: null,
				message: {
					id: "msg_top",
					content: [{ type: "tool_use", id: "toolu_top", name: "Read", input: {} }],
				},
			} as never),
		).toHaveLength(1);
	});
});
