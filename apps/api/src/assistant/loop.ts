import { randomUUID } from "node:crypto";
import type { AssistantUnavailableReason } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { Logger } from "@portikus/observability";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import {
	type AiMessage,
	type ModelClient,
	ModelError,
	type StepRequest,
} from "../ai/model.js";
import type { OpenedModel, ReadyAiSettings } from "../ai/settings.js";
import type { StepUsage } from "../ai/usage.js";
import { operationByName } from "../catalog/index.js";
import {
	type OperationInputValues,
	type RunCaller,
	runOperation,
} from "../catalog/run.js";
import { toolResult } from "../mcp/result.js";
import { chargeStep, LIMIT_TEXT, MAX_STEPS_PER_MESSAGE, spentLimit } from "./budget.js";
import {
	type ApprovalRisk,
	approvalCard,
	cardDecision,
	confirmTextFor,
	decide,
	REFUSED_TEXT,
} from "./cards.js";
import type { AssistantHub } from "./hub.js";
import {
	claimApproval,
	countPending,
	insertApproval,
	loadEvents,
	nameConversation,
	pendingApproval,
	type StoredEvent,
	touchConversation,
} from "./store.js";
import {
	assistantTools,
	RUN_TOOL,
	resolveCall,
	systemPrompt,
	type ToolCaller,
	textOf,
} from "./tools.js";

/**
 * The assistant's own loop (SPEC.md section 20.4): one model step at a time.
 * Read operations run at once as the person; a change or destructive one
 * stops at an approval card and the turn ends. Model messages are rebuilt
 * from the stored events before every step. Nothing from a prompt, reply,
 * tool input or result is logged; only ids, counts and codes.
 */

/** Room for a long answer; a step that reaches it ends with what it has. */
const MAX_OUTPUT_TOKENS = 4096;

const NOT_ENABLED_TEXT: Record<AssistantUnavailableReason, string> = {
	off: "The assistant is not enabled: it is turned off for this site.",
	incomplete:
		"The assistant is not enabled: its provider, address or model is not set.",
	"no-key": "The assistant is not enabled: it has no AI key yet.",
	"key-unreadable": "The assistant is not enabled: its saved AI key no longer opens.",
	notice:
		"The assistant is not enabled: an administrator has not accepted the privacy notice.",
	"monthly-cap":
		"The assistant is not enabled: this month's token allowance is used up. It works again next month.",
};

export function notEnabledMessage(reason: AssistantUnavailableReason): string {
	return NOT_ENABLED_TEXT[reason];
}

const BUSY_TEXT =
	"The assistant is still working on the last message. Wait for it, or stop it, before sending another.";
const ANSWER_FIRST_TEXT = "Answer the approval card first, then send your message.";
const FAILED_TEXT = "Something went wrong, and the assistant stopped.";
const NOT_FINISHED_TEXT = JSON.stringify({
	code: "INTERRUPTED",
	message: "This call did not finish.",
});

/** Who a turn runs for: the conversation, its owner's role, and the socket's session. */
export type TurnCaller = {
	conversationId: string;
	userId: string;
	tools: ToolCaller;
	run: Extract<RunCaller, { kind: "assistant" }>;
};

export type LoopDeps = {
	app: FastifyInstance;
	db: Kysely<Database>;
	hub: AssistantHub;
	log: Logger;
	openModel: () => Promise<OpenedModel>;
};

/**
 * The model's messages, rebuilt from the stored wire events: a person's
 * message, each step's text and tool calls, and the results of those calls.
 * A call with no result (a stopped turn) reads as not finished, since every
 * call needs one.
 */
export function rebuildMessages(events: readonly StoredEvent[]): AiMessage[] {
	const results = new Map<string, { text: string; isError: boolean }>();
	for (const event of events) {
		if (event.type === "tool.output" && event.part.type === "text") {
			const sofar = results.get(event.id);
			results.set(event.id, {
				text: (sofar?.text ?? "") + event.part.text,
				isError: sofar?.isError ?? false,
			});
		} else if (event.type === "tool.finished") {
			results.set(event.id, {
				text: results.get(event.id)?.text ?? "",
				isError: event.isError,
			});
		}
	}

	const messages: AiMessage[] = [];
	let step: Extract<AiMessage, { role: "assistant" }> | null = null;
	for (const event of events) {
		if (event.type === "message" && event.role === "user") {
			messages.push({ role: "user", text: event.markdown });
			step = null;
		} else if (event.type === "message") {
			step = { role: "assistant", text: event.markdown, toolCalls: [] };
			messages.push(step);
		} else if (event.type === "tool.started") {
			if (!step) {
				step = { role: "assistant", text: "", toolCalls: [] };
				messages.push(step);
			}
			step.toolCalls.push({ id: event.id, name: event.name, input: event.input });
		} else {
			// A step's calls are stored together right after its text.
			step = null;
		}
	}

	return messages.flatMap((message): AiMessage[] => {
		if (message.role !== "assistant" || message.toolCalls.length === 0)
			return [message];
		return [
			message,
			{
				role: "tool",
				results: message.toolCalls.map((call) => ({
					id: call.id,
					name: call.name,
					...(results.get(call.id) ?? { text: NOT_FINISHED_TEXT, isError: true }),
				})),
			},
		];
	});
}

/** Model steps since the person's last message. */
function stepsSinceMessage(messages: readonly AiMessage[]): number {
	let steps = 0;
	for (let at = messages.length - 1; at >= 0; at--) {
		const message = messages[at];
		if (message?.role === "user") break;
		if (message?.role === "assistant") steps++;
	}
	return steps;
}

/** The tool block's title: the operation's description when the call names one. */
function callTitle(call: { name: string; input: unknown }, caller: ToolCaller): string {
	if (call.name === RUN_TOOL) {
		const name = (call.input as { operation?: unknown } | null)?.operation;
		const found = typeof name === "string" ? operationByName(name) : undefined;
		return found?.operation.description ?? call.name;
	}
	return (
		assistantTools(caller).named.get(call.name)?.operation.description ?? call.name
	);
}

type JsonInput = Extract<StoredEvent, { type: "tool.started" }>["input"];

function asJson(value: unknown): JsonInput {
	try {
		return JSON.parse(JSON.stringify(value ?? {}));
	} catch {
		return {};
	}
}

type ToolCall = { id: string; name: string; input: unknown };

type OpenModel = Extract<OpenedModel, { client: unknown }>;

type StepOutcome = {
	messageId: string;
	text: string;
	calls: ToolCall[];
	usage: StepUsage | null;
	failure: ModelError | null;
};

export function createAssistantLoop(deps: LoopDeps) {
	const { app, db, hub, log } = deps;

	const emit = (id: string, event: StoredEvent) => hub.emit(id, event);
	const say = (id: string, markdown: string) =>
		emit(id, { type: "message", id: randomUUID(), role: "assistant", markdown });
	const finish = (id: string, status: "done" | "interrupted" | "error") =>
		emit(id, { type: "turn.finished", status, at: Date.now() });
	const output = async (id: string, callId: string, text: string, isError: boolean) => {
		await emit(id, { type: "tool.output", id: callId, part: { type: "text", text } });
		await emit(id, { type: "tool.finished", id: callId, isError });
	};

	/** Run an operation as the socket's session and give the model the route's answer. */
	async function runAs(
		caller: TurnCaller,
		callId: string,
		operation: string,
		input: OperationInputValues,
	): Promise<void> {
		const result = toolResult(
			await runOperation(app, db, caller.run, operation, input),
		);
		await output(
			caller.conversationId,
			callId,
			textOf(result),
			result.isError === true,
		);
	}

	/** Answer one call, run it, or draw its card; true when it waits for a person. */
	async function handleCall(caller: TurnCaller, call: ToolCall): Promise<boolean> {
		const id = caller.conversationId;
		const resolved = resolveCall(call, caller.tools);
		if (resolved.kind === "answer") {
			await output(id, call.id, resolved.text, resolved.isError);
			return false;
		}
		const { operation, input } = resolved;
		if (operation.risk === "read") {
			await runAs(caller, call.id, operation.name, input);
			return false;
		}
		const risky = operation as typeof operation & { risk: ApprovalRisk };
		await insertApproval(db, {
			conversationId: id,
			toolCallId: call.id,
			operation: operation.name,
			input,
			risk: risky.risk,
			confirmText: confirmTextFor(operation),
		});
		await emit(id, approvalCard(call.id, risky, input));
		return true;
	}

	/** Why the turn must stop before another step, as the text to say; null to go on. */
	async function stopBeforeStep(
		id: string,
		messages: readonly AiMessage[],
		settings: ReadyAiSettings,
	): Promise<string | null> {
		if (stepsSinceMessage(messages) >= MAX_STEPS_PER_MESSAGE) return LIMIT_TEXT.steps;
		const spent = await spentLimit(db, id, settings);
		if (!spent) return null;
		log.info({ conversationId: id, limit: spent }, "assistant limit reached");
		return LIMIT_TEXT[spent];
	}

	/** One model call, its text streamed to the sockets as it comes. */
	async function streamStep(
		id: string,
		client: ModelClient,
		request: StepRequest,
	): Promise<StepOutcome> {
		const out: StepOutcome = {
			messageId: randomUUID(),
			text: "",
			calls: [],
			usage: null,
			failure: null,
		};
		try {
			for await (const part of client.step(request)) {
				if (part.type === "text") {
					out.text += part.text;
					await emit(id, {
						type: "text.delta",
						messageId: out.messageId,
						text: part.text,
					});
				} else if (part.type === "tool-call") {
					out.calls.push({ id: part.id, name: part.name, input: part.input });
				} else {
					out.usage = part.usage;
				}
			}
		} catch (error) {
			out.failure =
				error instanceof ModelError
					? error
					: new ModelError(request.signal.aborted ? "aborted" : "other");
		}
		return out;
	}

	/** Count, store and report one finished step; true when it failed and the turn is over. */
	async function settleStep(
		caller: TurnCaller,
		step: StepOutcome,
		model: string,
	): Promise<boolean> {
		const id = caller.conversationId;
		if (step.usage) {
			await chargeStep(db, {
				conversationId: id,
				userId: caller.userId,
				model,
				usage: step.usage,
			});
		}
		if (step.text !== "") {
			await emit(id, {
				type: "message",
				id: step.messageId,
				role: "assistant",
				markdown: step.text,
			});
		}
		if (!step.failure) return false;
		if (step.failure.code === "aborted") {
			await finish(id, "interrupted");
			return true;
		}
		log.warn(
			{ conversationId: id, code: step.failure.code },
			"assistant model step failed",
		);
		await emit(id, { type: "error", message: step.failure.message });
		await finish(id, "error");
		return true;
	}

	/** Show a step's calls, then answer, run or ask about each; how the turn goes on. */
	async function runCalls(
		caller: TurnCaller,
		calls: ToolCall[],
		signal: AbortSignal,
	): Promise<"done" | "interrupted" | "continue"> {
		const id = caller.conversationId;
		for (const call of calls) {
			await emit(id, {
				type: "tool.started",
				id: call.id,
				name: call.name,
				title: callTitle(call, caller.tools),
				input: asJson(call.input),
			});
		}
		let waiting = false;
		for (const call of calls) {
			if (signal.aborted) break;
			if (await handleCall(caller, call)) waiting = true;
		}
		if (signal.aborted) return "interrupted";
		return waiting || calls.length === 0 ? "done" : "continue";
	}

	/** Model steps until a reply with no calls, a card, a limit, a stop or a failure. */
	async function runSteps(
		caller: TurnCaller,
		opened: OpenModel,
		signal: AbortSignal,
	): Promise<void> {
		const id = caller.conversationId;
		const { client, settings } = opened;
		const { tools } = assistantTools(caller.tools);
		const system = systemPrompt(caller.tools);
		for (;;) {
			const messages = rebuildMessages((await loadEvents(db, id)).map((e) => e.event));
			const stop = await stopBeforeStep(id, messages, settings);
			if (stop !== null) {
				await say(id, stop);
				await finish(id, "done");
				return;
			}
			const step = await streamStep(id, client, {
				system,
				messages,
				tools,
				maxOutputTokens: MAX_OUTPUT_TOKENS,
				signal,
			});
			if (await settleStep(caller, step, settings.model)) return;
			const next = await runCalls(caller, step.calls, signal);
			if (next !== "continue") {
				await finish(id, next);
				return;
			}
		}
	}

	/** Run `work` as the conversation's one turn; refuse when one is running. */
	async function asTurn(
		caller: TurnCaller,
		work: (signal: AbortSignal) => Promise<void>,
	): Promise<void> {
		const id = caller.conversationId;
		const turn = hub.beginTurn(id);
		if (!turn) {
			await emit(id, { type: "error", message: BUSY_TEXT });
			return;
		}
		try {
			await work(turn.signal);
		} catch (error) {
			log.error(
				{ conversationId: id, error: error instanceof Error ? error.name : "unknown" },
				"assistant turn failed",
			);
			await emit(id, { type: "error", message: FAILED_TEXT }).catch(() => {});
			if (hub.isRunning(id)) await finish(id, "error").catch(() => {});
		} finally {
			hub.endTurn(id);
		}
	}

	/** Open the model, or say why the assistant cannot answer; null then. */
	async function openOrRefuse(id: string): Promise<OpenModel | null> {
		const opened = await deps.openModel();
		if ("unavailable" in opened) {
			await emit(id, { type: "error", message: notEnabledMessage(opened.unavailable) });
			return null;
		}
		return opened;
	}

	return {
		/** A person's message: store it and run the model on it. */
		send(caller: TurnCaller, text: string): Promise<void> {
			return asTurn(caller, async (signal) => {
				const id = caller.conversationId;
				if ((await countPending(db, id)) > 0) {
					await emit(id, { type: "error", message: ANSWER_FIRST_TEXT });
					return;
				}
				const opened = await openOrRefuse(id);
				if (!opened) return;
				await emit(id, { type: "turn.started", at: Date.now() });
				await emit(id, {
					type: "message",
					id: randomUUID(),
					role: "user",
					markdown: text,
				});
				await nameConversation(db, id, text);
				await touchConversation(db, id);
				await runSteps(caller, opened, signal);
			});
		},

		/**
		 * A person's answer to a card. The claim is atomic, so a second tab or
		 * a replay runs nothing. An approved call runs as this socket's
		 * session, so a sign-out or a lost role since the card was drawn is
		 * enforced by the route.
		 */
		answer(
			caller: TurnCaller,
			answer: { id: string; optionId: string; confirmation?: string | undefined },
		): Promise<void> {
			return asTurn(caller, async (signal) => {
				const id = caller.conversationId;
				const row = await pendingApproval(db, id, answer.id);
				if (!row) return;
				const status = decide(answer, row.confirm_text);
				const claimed = await claimApproval(db, id, answer.id, status);
				if (!claimed) return;
				await touchConversation(db, id);
				await emit(id, { type: "turn.started", at: Date.now() });
				await emit(id, {
					type: "card.resolved",
					id: answer.id,
					decision: cardDecision(status),
				});
				if (status === "approved") {
					await runAs(
						caller,
						answer.id,
						claimed.operation,
						claimed.input as OperationInputValues,
					);
				} else {
					await output(id, answer.id, REFUSED_TEXT, true);
				}
				if ((await countPending(db, id)) > 0) {
					await finish(id, "done");
					return;
				}
				const opened = await openOrRefuse(id);
				if (!opened) {
					await finish(id, "error");
					return;
				}
				await runSteps(caller, opened, signal);
			});
		},

		interrupt(caller: TurnCaller): void {
			hub.interrupt(caller.conversationId);
		},
	};
}
