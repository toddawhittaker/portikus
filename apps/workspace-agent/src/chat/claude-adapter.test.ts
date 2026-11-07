import { readFileSync } from "node:fs";
import type { SDKMessage, SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import {
	ChatServerEvent,
	MAX_CHAT_IMAGE_BYTES,
	MAX_CHAT_SERVER_FRAME_BYTES,
} from "@portikus/contracts";
import { describe, expect, test } from "vitest";
import {
	type ChatEventBody,
	ClaudeMessageMapper,
	cardForTool,
	imagePart,
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

	test("the recorded rate limit event fills the seven-day window", () => {
		const event = recorded.find(
			(message) => message.type === "rate_limit_event",
		) as Extract<SDKMessage, { type: "rate_limit_event" }>;
		expect(mergeRateLimits({}, event.rate_limit_info)).toEqual({
			seven_day: { used_percentage: 60, resets_at: 1800000000 },
		});
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
	test("a later event for the other window keeps the first", () => {
		const first = mergeRateLimits({}, {
			status: "allowed",
			rateLimitType: "five_hour",
			utilization: 0.4237,
			resetsAt: 1794200000,
		} as SDKRateLimitInfo);
		const both = mergeRateLimits(first, {
			status: "allowed",
			rateLimitType: "seven_day",
			utilization: 1.4,
			resetsAt: 1800000000,
		} as SDKRateLimitInfo);
		expect(both).toEqual({
			five_hour: { used_percentage: 42.4, resets_at: 1794200000 },
			seven_day: { used_percentage: 100, resets_at: 1800000000 },
		});
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
			behavior: "allow",
			updatedInput: { command: "ls" },
			updatedPermissions: [suggestion],
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
});
