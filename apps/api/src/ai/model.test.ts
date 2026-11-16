import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	type AiMessage,
	type AiTool,
	createModelClient,
	ModelError,
	type ModelPart,
	type ModelSettings,
	type StepRequest,
	toModelError,
} from "./model.js";

const KEY = "sk-our-key-1234";
const OPENAI: ModelSettings = {
	kind: "openai-compatible",
	baseUrl: "https://models.example.edu/v1",
	apiKey: KEY,
	model: "gpt-test",
};
const ANTHROPIC: ModelSettings = {
	kind: "anthropic",
	baseUrl: "https://claude.example.edu/v1",
	apiKey: KEY,
	model: "claude-test",
};

const TOOLS: AiTool[] = [
	{
		name: "users_list",
		description: "List users.",
		inputSchema: { type: "object", properties: { limit: { type: "number" } } },
	},
	{
		name: "health_read",
		description: "Read health.",
		inputSchema: { type: "object", properties: {} },
	},
];

type Captured = { url: string; headers: Headers; body: unknown };

/** A fake outbound fetch: records each request and answers with the next response. */
function fakeFetch(
	...responses: Array<Response | (() => Response | Promise<Response>)>
) {
	const captured: Captured[] = [];
	const fn = vi.fn(async (url: string, init: RequestInit) => {
		captured.push({
			url,
			headers: new Headers(init.headers),
			body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
		});
		const next = responses.shift();
		if (next === undefined) throw new Error("no more responses");
		return typeof next === "function" ? next() : next;
	});
	return { fn, captured };
}

function sseBody(events: string[]): string {
	return events.join("");
}

function openAiSse(chunks: object[]): Response {
	return new Response(
		sseBody([
			...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`),
			"data: [DONE]\n\n",
		]),
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

function anthropicSse(
	events: Array<{ type: string } & Record<string, unknown>>,
): Response {
	return new Response(
		sseBody(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)),
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

function chunk(delta: object, finish: string | null = null): object {
	return {
		id: "c1",
		object: "chat.completion.chunk",
		created: 1,
		model: "gpt-test",
		choices: [{ index: 0, delta, finish_reason: finish }],
	};
}

const OPENAI_TOOL_CALL_STREAM = [
	chunk({ role: "assistant", content: "Hel" }),
	chunk({ content: "lo" }),
	chunk({
		tool_calls: [
			{
				index: 0,
				id: "call_1",
				type: "function",
				function: { name: "users_list", arguments: "" },
			},
		],
	}),
	chunk({ tool_calls: [{ index: 0, function: { arguments: '{"lim' } }] }),
	chunk({ tool_calls: [{ index: 0, function: { arguments: 'it": 5}' } }] }),
	chunk({}, "tool_calls"),
	{
		id: "c1",
		object: "chat.completion.chunk",
		created: 1,
		model: "gpt-test",
		choices: [],
		usage: {
			prompt_tokens: 40,
			completion_tokens: 7,
			prompt_tokens_details: { cached_tokens: 30 },
		},
	},
];

const ANTHROPIC_TOOL_CALL_STREAM = [
	{
		type: "message_start",
		message: {
			id: "msg_1",
			type: "message",
			role: "assistant",
			model: "claude-test",
			content: [],
			stop_reason: null,
			stop_sequence: null,
			usage: {
				input_tokens: 10,
				output_tokens: 1,
				cache_creation_input_tokens: 100,
				cache_read_input_tokens: 50,
			},
		},
	},
	{
		type: "content_block_start",
		index: 0,
		content_block: { type: "thinking", thinking: "" },
	},
	{
		type: "content_block_delta",
		index: 0,
		delta: { type: "thinking_delta", thinking: "hmm" },
	},
	{
		type: "content_block_delta",
		index: 0,
		delta: { type: "signature_delta", signature: "sig" },
	},
	{ type: "content_block_stop", index: 0 },
	{ type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
	{
		type: "content_block_delta",
		index: 1,
		delta: { type: "text_delta", text: "Let me " },
	},
	{
		type: "content_block_delta",
		index: 1,
		delta: { type: "text_delta", text: "look." },
	},
	{ type: "content_block_stop", index: 1 },
	{
		type: "content_block_start",
		index: 2,
		content_block: { type: "tool_use", id: "toolu_1", name: "users_list", input: {} },
	},
	{
		type: "content_block_delta",
		index: 2,
		delta: { type: "input_json_delta", partial_json: '{"lim' },
	},
	{
		type: "content_block_delta",
		index: 2,
		delta: { type: "input_json_delta", partial_json: 'it": 5}' },
	},
	{ type: "content_block_stop", index: 2 },
	{
		type: "message_delta",
		delta: { stop_reason: "tool_use", stop_sequence: null },
		usage: { output_tokens: 20 },
	},
	{ type: "message_stop" },
];

const HISTORY: AiMessage[] = [
	{ role: "user", text: "Who is enrolled?" },
	{
		role: "assistant",
		text: "Checking.",
		toolCalls: [{ id: "call_0", name: "health_read", input: {} }],
	},
	{
		role: "tool",
		results: [
			{
				id: "call_0",
				name: "health_read",
				text: "Refused by the person.",
				isError: true,
			},
		],
	},
];

function request(overrides: Partial<StepRequest> = {}): StepRequest {
	return {
		system: "You are the Portikus assistant.",
		messages: HISTORY,
		tools: TOOLS,
		maxOutputTokens: 1000,
		signal: new AbortController().signal,
		...overrides,
	};
}

async function collect(parts: AsyncIterable<ModelPart>): Promise<ModelPart[]> {
	const out: ModelPart[] = [];
	for await (const part of parts) out.push(part);
	return out;
}

async function stepError(parts: AsyncIterable<ModelPart>): Promise<ModelError> {
	try {
		await collect(parts);
	} catch (error) {
		expect(error).toBeInstanceOf(ModelError);
		return error as ModelError;
	}
	throw new Error("the step did not fail");
}

const SENTINELS = {
	ANTHROPIC_API_KEY: "sentinel-anthropic-key",
	ANTHROPIC_BASE_URL: "https://sentinel-anthropic.invalid/v1",
	OPENAI_API_KEY: "sentinel-openai-key",
	OPENAI_BASE_URL: "https://sentinel-openai.invalid/v1",
	AI_GATEWAY_API_KEY: "sentinel-gateway-key",
};

const globalFetch = vi.fn(async () => {
	throw new Error("the global fetch must not be used");
});

beforeEach(() => {
	for (const [name, value] of Object.entries(SENTINELS)) vi.stubEnv(name, value);
	vi.stubGlobal("fetch", globalFetch);
});

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	globalFetch.mockClear();
});

function expectOnlyOurs(captured: Captured[], base: string) {
	expect(captured.length).toBeGreaterThan(0);
	for (const c of captured) {
		expect(c.url.startsWith(`${base}/`)).toBe(true);
		const headerText = [...c.headers.entries()]
			.map(([k, v]) => `${k}: ${v}`)
			.join("\n");
		expect(headerText).toContain(KEY);
		for (const sentinel of Object.values(SENTINELS)) {
			expect(headerText).not.toContain(sentinel);
			expect(JSON.stringify(c.body ?? null)).not.toContain(sentinel);
		}
	}
	expect(globalFetch).not.toHaveBeenCalled();
}

describe("openai-compatible", () => {
	test("streams text as it arrives and yields a tool call assembled from its pieces", async () => {
		const { fn, captured } = fakeFetch(openAiSse(OPENAI_TOOL_CALL_STREAM));
		const parts = await collect(createModelClient(OPENAI, fn).step(request()));
		expect(parts).toEqual([
			{ type: "text", text: "Hel" },
			{ type: "text", text: "lo" },
			{ type: "tool-call", id: "call_1", name: "users_list", input: { limit: 5 } },
			{
				type: "finish",
				usage: { input: 40, output: 7, cacheRead: 30, cacheWrite: 0 },
			},
		]);
		expect(captured).toHaveLength(1);
		expect(captured[0]?.url).toBe("https://models.example.edu/v1/chat/completions");
	});

	test("sends only our key to our address, whatever the environment holds", async () => {
		const { fn, captured } = fakeFetch(openAiSse(OPENAI_TOOL_CALL_STREAM));
		await collect(createModelClient(OPENAI, fn).step(request()));
		expectOnlyOurs(captured, OPENAI.baseUrl);
		expect(captured[0]?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
	});

	test("asks for usage and sends no provider-specific fields", async () => {
		const { fn, captured } = fakeFetch(openAiSse(OPENAI_TOOL_CALL_STREAM));
		await collect(createModelClient(OPENAI, fn).step(request()));
		const body = captured[0]?.body as Record<string, unknown>;
		expect(Object.keys(body).sort()).toEqual(
			[
				"max_tokens",
				"messages",
				"model",
				"stream",
				"stream_options",
				"tool_choice",
				"tools",
			].sort(),
		);
		expect(body.stream_options).toEqual({ include_usage: true });
		expect(body.tool_choice).toBe("auto");
		expect(body.model).toBe("gpt-test");
		expect(body.max_tokens).toBe(1000);
		expect(JSON.stringify(body)).not.toMatch(/reasoning|thinking|cache_control/);
	});

	test("sends the system prompt, the history and the tools in Chat Completions form", async () => {
		const { fn, captured } = fakeFetch(openAiSse(OPENAI_TOOL_CALL_STREAM));
		await collect(createModelClient(OPENAI, fn).step(request()));
		const body = captured[0]?.body as { messages: unknown[]; tools: unknown[] };
		expect(body.messages).toEqual([
			{ role: "system", content: "You are the Portikus assistant." },
			{ role: "user", content: "Who is enrolled?" },
			{
				role: "assistant",
				content: "Checking.",
				tool_calls: [
					{
						id: "call_0",
						type: "function",
						function: { name: "health_read", arguments: "{}" },
					},
				],
			},
			{ role: "tool", tool_call_id: "call_0", content: "Refused by the person." },
		]);
		expect(body.tools).toEqual([
			{
				type: "function",
				function: {
					name: "users_list",
					description: "List users.",
					parameters: { type: "object", properties: { limit: { type: "number" } } },
				},
			},
			{
				type: "function",
				function: {
					name: "health_read",
					description: "Read health.",
					parameters: { type: "object", properties: {} },
				},
			},
		]);
	});

	test("lists models from GET {base}/models", async () => {
		const { fn, captured } = fakeFetch(
			Response.json({
				object: "list",
				data: [{ id: "gpt-a" }, { id: "gpt-b" }, { other: 1 }],
			}),
		);
		expect(await createModelClient(OPENAI, fn).listModels()).toEqual([
			"gpt-a",
			"gpt-b",
		]);
		expect(captured[0]?.url).toBe("https://models.example.edu/v1/models");
		expectOnlyOurs(captured, OPENAI.baseUrl);
	});

	test("listModels is null when the route is missing, fails, or answers in another shape", async () => {
		const answers = [
			new Response("not found", { status: 404 }),
			new Response("{not json", { status: 200 }),
			Response.json({ models: [] }),
			() => {
				throw new TypeError("fetch failed");
			},
		];
		for (const answer of answers) {
			const { fn } = fakeFetch(answer);
			expect(await createModelClient(OPENAI, fn).listModels()).toBeNull();
		}
	});
});

describe("openai itself", () => {
	const REAL_OPENAI: ModelSettings = {
		...OPENAI,
		baseUrl: "https://api.openai.com/v1",
	};

	function responsesSse(
		events: Array<{ type: string } & Record<string, unknown>>,
	): Response {
		return new Response(
			sseBody(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)),
			{ status: 200, headers: { "content-type": "text/event-stream" } },
		);
	}

	const FUNCTION_CALL = {
		type: "function_call",
		id: "fc_1",
		call_id: "call_1",
		name: "users_list",
		arguments: "",
		status: "in_progress",
	};

	const RESPONSES_TOOL_CALL_STREAM = () =>
		responsesSse([
			{
				type: "response.created",
				response: { id: "resp_1", created_at: 1, model: "gpt-test" },
			},
			{ type: "response.output_item.added", output_index: 0, item: FUNCTION_CALL },
			{
				type: "response.function_call_arguments.delta",
				item_id: "fc_1",
				output_index: 0,
				delta: '{"limit": 5}',
			},
			{
				type: "response.output_item.done",
				output_index: 0,
				item: { ...FUNCTION_CALL, arguments: '{"limit": 5}', status: "completed" },
			},
			{
				type: "response.completed",
				response: {
					usage: {
						input_tokens: 40,
						input_tokens_details: { cached_tokens: 30 },
						output_tokens: 7,
						output_tokens_details: { reasoning_tokens: 0 },
					},
				},
			},
		]);

	test("uses the Responses API with max_output_tokens and nothing stored", async () => {
		const { fn, captured } = fakeFetch(RESPONSES_TOOL_CALL_STREAM());
		const parts = await collect(createModelClient(REAL_OPENAI, fn).step(request()));
		expect(parts).toEqual([
			{ type: "tool-call", id: "call_1", name: "users_list", input: { limit: 5 } },
			{
				type: "finish",
				usage: { input: 40, output: 7, cacheRead: 30, cacheWrite: 0 },
			},
		]);
		expectOnlyOurs(captured, REAL_OPENAI.baseUrl);
		expect(captured[0]?.url).toBe("https://api.openai.com/v1/responses");
		const body = captured[0]?.body as Record<string, unknown>;
		expect(body).not.toHaveProperty("max_tokens");
		expect(body).not.toHaveProperty("max_completion_tokens");
		expect(body.max_output_tokens).toBe(1000);
		expect(body.store).toBe(false);
	});

	test("sends a tool result back as a function_call_output item", async () => {
		const { fn, captured } = fakeFetch(RESPONSES_TOOL_CALL_STREAM());
		const messages: AiMessage[] = [
			{ role: "user", text: "list users" },
			{
				role: "assistant",
				text: "",
				toolCalls: [{ id: "call_1", name: "users_list", input: { limit: 5 } }],
			},
			{
				role: "tool",
				results: [{ id: "call_1", name: "users_list", text: "[]" }],
			},
		];
		await collect(createModelClient(REAL_OPENAI, fn).step(request({ messages })));
		const body = captured[0]?.body as { input: Array<Record<string, unknown>> };
		expect(body.input).toContainEqual(
			expect.objectContaining({
				type: "function_call",
				call_id: "call_1",
				name: "users_list",
			}),
		);
		expect(body.input).toContainEqual({
			type: "function_call_output",
			call_id: "call_1",
			output: "[]",
		});
	});
});

describe("anthropic", () => {
	test("streams text, drops reasoning, assembles the tool call and reports cache usage", async () => {
		const { fn, captured } = fakeFetch(anthropicSse(ANTHROPIC_TOOL_CALL_STREAM));
		const parts = await collect(createModelClient(ANTHROPIC, fn).step(request()));
		expect(parts).toEqual([
			{ type: "text", text: "Let me " },
			{ type: "text", text: "look." },
			{ type: "tool-call", id: "toolu_1", name: "users_list", input: { limit: 5 } },
			{
				type: "finish",
				usage: { input: 160, output: 20, cacheRead: 50, cacheWrite: 100 },
			},
		]);
		expect(captured[0]?.url).toBe("https://claude.example.edu/v1/messages");
	});

	test("sends only our key to our address, never ANTHROPIC_API_KEY or ANTHROPIC_BASE_URL", async () => {
		const { fn, captured } = fakeFetch(anthropicSse(ANTHROPIC_TOOL_CALL_STREAM));
		await collect(createModelClient(ANTHROPIC, fn).step(request()));
		expectOnlyOurs(captured, ANTHROPIC.baseUrl);
		expect(captured[0]?.headers.get("x-api-key")).toBe(KEY);
	});

	test("marks the system prompt and the tool list for prompt caching", async () => {
		const { fn, captured } = fakeFetch(anthropicSse(ANTHROPIC_TOOL_CALL_STREAM));
		await collect(createModelClient(ANTHROPIC, fn).step(request()));
		const body = captured[0]?.body as {
			system: Array<{ text: string; cache_control?: unknown }>;
			tools: Array<{ name: string; cache_control?: unknown }>;
			thinking?: unknown;
		};
		expect(body.system).toEqual([
			{
				type: "text",
				text: "You are the Portikus assistant.",
				cache_control: { type: "ephemeral" },
			},
		]);
		expect(body.tools.map((t) => [t.name, t.cache_control])).toEqual([
			["users_list", undefined],
			["health_read", { type: "ephemeral" }],
		]);
		expect(body.thinking).toBeUndefined();
	});

	test("lists models with the Anthropic headers", async () => {
		const { fn, captured } = fakeFetch(
			Response.json({ data: [{ id: "claude-a", type: "model" }], has_more: false }),
		);
		expect(await createModelClient(ANTHROPIC, fn).listModels()).toEqual(["claude-a"]);
		expect(captured[0]?.url).toBe("https://claude.example.edu/v1/models?limit=1000");
		expect(captured[0]?.headers.get("x-api-key")).toBe(KEY);
		expect(captured[0]?.headers.get("anthropic-version")).toBe("2023-06-01");
		expectOnlyOurs(captured, ANTHROPIC.baseUrl);
	});
});

describe("errors", () => {
	const SECRET_BODY = `{"error":{"message":"key ${KEY} is invalid; internal detail xyzzy"}}`;
	const cases: Array<[number, string]> = [
		[401, "auth"],
		[403, "auth"],
		[429, "rate-limited"],
		[500, "other"],
		[404, "other"],
	];

	for (const settings of [OPENAI, ANTHROPIC]) {
		for (const [status, code] of cases) {
			test(`${settings.kind}: status ${status} becomes ${code}, with no key or body in the message`, async () => {
				const { fn } = fakeFetch(
					new Response(SECRET_BODY, {
						status,
						headers: { "content-type": "application/json" },
					}),
				);
				const error = await stepError(createModelClient(settings, fn).step(request()));
				expect(error.code).toBe(code);
				expect(error.message).not.toContain(KEY);
				expect(error.message).not.toContain("xyzzy");
				expect(error.cause).toBeUndefined();
			});
		}

		test(`${settings.kind}: a network or proxy failure becomes unreachable`, async () => {
			const { fn } = fakeFetch(() => {
				throw new Error(`Proxy response (403) !== 200 when HTTP Tunneling ${KEY}`);
			});
			const error = await stepError(createModelClient(settings, fn).step(request()));
			expect(error.code).toBe("unreachable");
			expect(error.message).not.toContain(KEY);
		});

		test(`${settings.kind}: an unreadable reply becomes bad-response`, async () => {
			const { fn } = fakeFetch(
				new Response("data: {not json\n\n", {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				}),
			);
			const error = await stepError(createModelClient(settings, fn).step(request()));
			expect(error.code).toBe("bad-response");
		});

		test(`${settings.kind}: aborting mid-stream stops the step with aborted`, async () => {
			const controller = new AbortController();
			const encoder = new TextEncoder();
			const first =
				settings.kind === "anthropic"
					? sseBody(
							ANTHROPIC_TOOL_CALL_STREAM.slice(0, 7).map(
								(e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`,
							),
						)
					: `data: ${JSON.stringify(chunk({ role: "assistant", content: "Hel" }))}\n\n`;
			const { fn } = fakeFetch(
				() =>
					new Response(
						new ReadableStream({
							start(c) {
								c.enqueue(encoder.encode(first));
								controller.signal.addEventListener("abort", () =>
									c.error(new DOMException("aborted", "AbortError")),
								);
							},
						}),
						{ status: 200, headers: { "content-type": "text/event-stream" } },
					),
			);
			const parts: ModelPart[] = [];
			const step = createModelClient(settings, fn).step(
				request({ signal: controller.signal }),
			);
			const error = await (async () => {
				try {
					for await (const part of step) {
						parts.push(part);
						controller.abort();
					}
				} catch (e) {
					return e as ModelError;
				}
				throw new Error("the step did not fail");
			})();
			expect(parts[0]?.type).toBe("text");
			expect(error).toBeInstanceOf(ModelError);
			expect(error.code).toBe("aborted");
		});

		test(`${settings.kind}: a signal aborted before the call never succeeds`, async () => {
			const controller = new AbortController();
			controller.abort();
			const { fn } = fakeFetch(async () => {
				throw new DOMException("aborted", "AbortError");
			});
			const error = await stepError(
				createModelClient(settings, fn).step(request({ signal: controller.signal })),
			);
			expect(error.code).toBe("aborted");
		});
	}

	test("anthropic: an error event after the reply starts keeps its kind", async () => {
		const { fn } = fakeFetch(
			anthropicSse([
				...ANTHROPIC_TOOL_CALL_STREAM.slice(0, 7),
				{
					type: "error",
					error: { type: "rate_limit_error", message: `slow down ${KEY}` },
				},
			]),
		);
		const parts: ModelPart[] = [];
		const step = createModelClient(ANTHROPIC, fn).step(request());
		const error = await stepError(
			(async function* () {
				for await (const part of step) {
					parts.push(part);
					yield part;
				}
			})(),
		);
		expect(parts).toEqual([{ type: "text", text: "Let me " }]);
		expect(error.code).toBe("rate-limited");
		expect(error.message).not.toContain(KEY);
	});

	test("toModelError keeps a ModelError and turns anything unknown into other", () => {
		const original = new ModelError("rate-limited");
		expect(toModelError(new Error("wrapped", { cause: original }))).toBe(original);
		expect(toModelError("a string").code).toBe("other");
		expect(toModelError(new Error(`secret ${KEY}`)).message).not.toContain(KEY);
	});
});
