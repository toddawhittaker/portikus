import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { OutboundFetch } from "@portikus/observability";
import {
	APICallError,
	type JSONSchema7,
	jsonSchema,
	type LanguageModel,
	type LanguageModelUsage,
	type ModelMessage,
	streamText,
	type ToolSet,
	tool,
} from "ai";

// The only module that imports the AI SDK. Everything else uses these types,
// so an SDK major upgrade, or a rewrite on another client, stays in this file.

// The SDK prints warnings to the console by default; nothing from a model
// call is logged (STACK.md section 15, ADR 0012).
globalThis.AI_SDK_LOG_WARNINGS = false;

export type ModelSettings = {
	kind: "openai-compatible" | "anthropic";
	baseUrl: string;
	apiKey: string;
	model: string;
};

export type AiTool = {
	name: string;
	description: string;
	inputSchema: JSONSchema7;
};

type AiToolCall = { id: string; name: string; input: unknown };

/** A tool's result as the model reads it: output, an error, or a person's refusal. */
type AiToolResult = {
	id: string;
	name: string;
	text: string;
	isError?: boolean;
};

export type AiMessage =
	| { role: "user"; text: string }
	| { role: "assistant"; text: string; toolCalls: AiToolCall[] }
	| { role: "tool"; results: AiToolResult[] };

type ModelUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
};

export type ModelPart =
	| { type: "text"; text: string }
	| ({ type: "tool-call" } & AiToolCall)
	| { type: "finish"; usage: ModelUsage };

export type StepRequest = {
	system: string;
	messages: AiMessage[];
	tools: AiTool[];
	maxOutputTokens: number;
	signal: AbortSignal;
};

export interface ModelClient {
	/** One model call. Never runs a tool and never loops; the caller decides what runs. */
	step(req: StepRequest): AsyncIterable<ModelPart>;
	/** The server's model names, or null when it has no list route or the call fails. */
	listModels(): Promise<string[] | null>;
}

export type ModelErrorCode =
	| "auth"
	| "rate-limited"
	| "unreachable"
	| "bad-response"
	| "aborted"
	| "other";

const ERROR_MESSAGES: Record<ModelErrorCode, string> = {
	auth: "The model server refused the key.",
	"rate-limited": "The model server is rate limiting requests.",
	unreachable: "The model server could not be reached.",
	"bad-response": "The model server sent a reply that could not be read.",
	aborted: "The model call was stopped.",
	other: "The model call failed.",
};

/** A model failure. The message is fixed per code: never the key, never a reply body. */
export class ModelError extends Error {
	readonly code: ModelErrorCode;

	constructor(code: ModelErrorCode) {
		super(ERROR_MESSAGES[code]);
		this.name = "ModelError";
		this.code = code;
	}
}

const ANTHROPIC_VERSION = "2023-06-01";
const LIST_MODELS_TIMEOUT_MS = 10_000;
// Anthropic caches the prompt prefix up to each marked block.
const ANTHROPIC_CACHE = { anthropic: { cacheControl: { type: "ephemeral" } } } as const;

function sdkFetch(outbound: OutboundFetch): typeof globalThis.fetch {
	return async (input, init) => {
		const url =
			typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		try {
			return await outbound(url, init ?? {});
		} catch (error) {
			if (init?.signal?.aborted) throw error;
			// Network failures and proxy refusals; the original is dropped so
			// nothing from the request travels with the error.
			throw new ModelError("unreachable");
		}
	};
}

// OpenAI itself goes through its Responses API: current models refuse max_tokens,
// and refuse tools on Chat Completions. Other compatible servers keep Chat Completions.
function isOpenAi(s: ModelSettings): boolean {
	return (
		s.kind === "openai-compatible" && new URL(s.baseUrl).hostname === "api.openai.com"
	);
}

function languageModel(
	s: ModelSettings,
	fetch: typeof globalThis.fetch,
): LanguageModel {
	// Model objects only, with the key and address passed in: a plain string id
	// would route through Vercel's gateway, and the Anthropic adapter would
	// otherwise read ANTHROPIC_API_KEY and ANTHROPIC_BASE_URL.
	if (s.kind === "anthropic") {
		return createAnthropic({ baseURL: s.baseUrl, apiKey: s.apiKey, fetch })(s.model);
	}
	if (isOpenAi(s)) {
		return createOpenAI({ baseURL: s.baseUrl, apiKey: s.apiKey, fetch }).responses(
			s.model,
		);
	}
	return createOpenAICompatible({
		name: "openai-compatible",
		baseURL: s.baseUrl,
		apiKey: s.apiKey,
		includeUsage: true,
		fetch,
	}).chatModel(s.model);
}

function toolSet(tools: AiTool[], anthropic: boolean): ToolSet {
	const set: ToolSet = {};
	tools.forEach((t, index) => {
		set[t.name] = tool({
			description: t.description,
			inputSchema: jsonSchema(t.inputSchema),
			// Marking the last tool caches the whole tool list.
			...(anthropic && index === tools.length - 1
				? { providerOptions: ANTHROPIC_CACHE }
				: {}),
		});
	});
	return set;
}

function modelMessages(messages: AiMessage[]): ModelMessage[] {
	return messages.map((m): ModelMessage => {
		if (m.role === "user") return { role: "user", content: m.text };
		if (m.role === "assistant") {
			return {
				role: "assistant",
				content: [
					...(m.text ? [{ type: "text" as const, text: m.text }] : []),
					...m.toolCalls.map((c) => ({
						type: "tool-call" as const,
						toolCallId: c.id,
						toolName: c.name,
						input: c.input,
					})),
				],
			};
		}
		return {
			role: "tool",
			content: m.results.map((r) => ({
				type: "tool-result" as const,
				toolCallId: r.id,
				toolName: r.name,
				output: r.isError
					? { type: "error-text" as const, value: r.text }
					: { type: "text" as const, value: r.text },
			})),
		};
	});
}

function usage(u: LanguageModelUsage): ModelUsage {
	return {
		input: u.inputTokens ?? 0,
		output: u.outputTokens ?? 0,
		cacheRead: u.inputTokenDetails?.cacheReadTokens ?? 0,
		cacheWrite: u.inputTokenDetails?.cacheWriteTokens ?? 0,
	};
}

function statusCode(status: number): ModelErrorCode {
	if (status === 401 || status === 403) return "auth";
	if (status === 429) return "rate-limited";
	return "other";
}

const BAD_RESPONSE_ERRORS = new Set([
	"AI_JSONParseError",
	"AI_TypeValidationError",
	"AI_InvalidResponseDataError",
	"AI_EmptyResponseBodyError",
	"AI_NoContentGeneratedError",
]);

function httpStatus(error: Error): number | undefined {
	const status = (error as { statusCode?: unknown }).statusCode;
	return typeof status === "number" ? status : undefined;
}

/**
 * Turns anything the SDK throws or streams into a ModelError, keeping nothing
 * of the original. `fallback` is the code for an error nothing else explains.
 */
export function toModelError(
	error: unknown,
	signal?: AbortSignal,
	fallback: ModelErrorCode = "other",
): ModelError {
	if (signal?.aborted) return new ModelError("aborted");
	let current: unknown = error;
	for (let depth = 0; current instanceof Error && depth < 5; depth++) {
		if (current instanceof ModelError) return current;
		if (current.name === "AbortError") return new ModelError("aborted");
		const status = httpStatus(current);
		if (status !== undefined) return new ModelError(statusCode(status));
		if (BAD_RESPONSE_ERRORS.has(current.name)) return new ModelError("bad-response");
		current = current.cause;
	}
	if (APICallError.isInstance(error)) return new ModelError("unreachable");
	return new ModelError(fallback);
}

async function* runStep(
	s: ModelSettings,
	fetch: typeof globalThis.fetch,
	req: StepRequest,
): AsyncIterable<ModelPart> {
	const anthropic = s.kind === "anthropic";
	const result = streamText({
		model: languageModel(s, fetch),
		system: anthropic
			? { role: "system", content: req.system, providerOptions: ANTHROPIC_CACHE }
			: req.system,
		messages: modelMessages(req.messages),
		tools: toolSet(req.tools, anthropic),
		maxOutputTokens: req.maxOutputTokens,
		// OpenAI would otherwise keep the conversation on its side.
		...(isOpenAi(s) ? { providerOptions: { openai: { store: false } } } : {}),
		abortSignal: req.signal,
		// One request per step; retrying is the caller's choice.
		maxRetries: 0,
		// The default handler logs the error, which can carry a reply body.
		onError: () => {},
	});
	try {
		for await (const part of result.fullStream) {
			switch (part.type) {
				case "text-delta":
					if (part.text) yield { type: "text", text: part.text };
					break;
				case "tool-call":
					yield {
						type: "tool-call",
						id: part.toolCallId,
						name: part.toolName,
						input: part.input,
					};
					break;
				case "finish":
					yield { type: "finish", usage: usage(part.totalUsage) };
					break;
				case "abort":
					throw new ModelError("aborted");
				case "error":
					// An error inside the stream that carries no status is a reply
					// the adapter could not parse.
					throw toModelError(part.error, req.signal, "bad-response");
				default:
					// Tool-input pieces, reasoning, step markers: not ours to pass on.
					break;
			}
		}
	} catch (error) {
		throw toModelError(error, req.signal);
	}
}

async function listModels(
	s: ModelSettings,
	fetch: typeof globalThis.fetch,
): Promise<string[] | null> {
	const base = s.baseUrl.replace(/\/+$/, "");
	const headers: Record<string, string> =
		s.kind === "anthropic"
			? { "x-api-key": s.apiKey, "anthropic-version": ANTHROPIC_VERSION }
			: { authorization: `Bearer ${s.apiKey}` };
	const url = s.kind === "anthropic" ? `${base}/models?limit=1000` : `${base}/models`;
	try {
		const response = await fetch(url, {
			method: "GET",
			headers,
			signal: AbortSignal.timeout(LIST_MODELS_TIMEOUT_MS),
		});
		if (!response.ok) {
			await response.body?.cancel();
			return null;
		}
		const body = (await response.json()) as { data?: unknown };
		if (!Array.isArray(body.data)) return null;
		const ids = body.data
			.map((entry) => (entry as { id?: unknown } | null)?.id)
			.filter((id): id is string => typeof id === "string");
		return ids;
	} catch {
		return null;
	}
}

export function createModelClient(
	s: ModelSettings,
	outbound: OutboundFetch,
): ModelClient {
	const fetch = sdkFetch(outbound);
	return {
		step: (req) => runStep(s, fetch, req),
		listModels: () => listModels(s, fetch),
	};
}
