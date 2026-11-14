import { CODEX_DEFAULT_MODE } from "@portikus/contracts";
import type { CardAnswer, CardOutcome, ChatSink } from "../agent.js";
import { ELICITATION_NOTICE } from "../mcp-status.js";
import type { AppServerClient as Client, RequestId } from "./app-server.js";
import {
	approvalCard,
	approvalOptions,
	mcpAnswer,
	mcpCard,
	PLAN_OPTION,
	planCard,
	questionAnswer,
	questionCard,
} from "./cards.js";
import { type CodexItemMapper, planRow, type ToolRow, toolRow } from "./mapper.js";
import type { CodexModeId } from "./modes.js";
import {
	CommandApprovalRequest,
	ElicitationRequest,
	parsed,
	ResolvedNotification,
	UserInputRequest,
} from "./protocol.js";

const IMPLEMENT_PLAN = "Implement the plan.";

/** The coding-agent states the host posts itself; no Codex hook fires for a question. */
export type PostedState = "needs-input" | "working" | "finished";

/** What the cards need of the agent that owns them. */
export interface RequestsHost {
	sink(): ChatSink;
	/** The item mapper of the thread a request is about. */
	mapperOf(threadId: string): CodexItemMapper;
	/** A deny reason, sent as the student's next message. */
	deliver(message: string, steerable: boolean): Promise<void>;
	/** A message a card's answer asks to send. */
	send(message: string): Promise<void>;
	/** The mode an accepted plan runs in. */
	setMode(mode: CodexModeId): void;
	postState(state: PostedState): Promise<void>;
}

/**
 * The cards Codex's app-server requests raise (SPEC.md §10.8): approvals,
 * MCP tool approvals, questions, and the plan card a Plan turn ends with.
 */
export class CodexRequests {
	/** Aborted when the conversation ends, which closes its open cards. */
	private ended = new AbortController();
	/** Open cards by the app-server request they answer, so Codex can withdraw one. */
	private readonly open = new Map<
		RequestId,
		{ cardId: string; withdrawn: AbortController }
	>();

	constructor(private readonly host: RequestsHost) {}

	/** Close the cards of a conversation that is over or replaced. */
	end(): void {
		this.ended.abort();
		this.ended = new AbortController();
		this.open.clear();
	}

	/** Codex withdrew a request: its card closes without an answer. */
	resolved(params: unknown): void {
		const resolved = parsed(ResolvedNotification, params);
		const open = resolved ? this.open.get(resolved.requestId) : undefined;
		if (resolved && open) {
			this.open.delete(resolved.requestId);
			open.withdrawn.abort();
		}
	}

	onRequest(client: Client, id: RequestId, method: string, params: unknown): void {
		switch (method) {
			case "item/commandExecution/requestApproval":
				this.approval(client, id, params, "commandExecution");
				return;
			case "item/fileChange/requestApproval":
				this.approval(client, id, params, "fileChange");
				return;
			case "item/tool/requestUserInput":
				this.question(client, id, params);
				return;
			case "mcpServer/elicitation/request":
				this.elicitation(client, id, params);
				return;
			case "item/tool/call":
				client.respond(id, { contentItems: [], success: false });
				return;
			case "item/permissions/requestApproval":
				client.respond(id, { permissions: {}, scope: "turn" });
				return;
			case "currentTime/read":
				client.respond(id, { currentTimeAt: Math.floor(Date.now() / 1000) });
				return;
			default:
				client.respondError(id, -32601, "Not supported by this client.");
				return;
		}
	}

	/**
	 * Show a card for an app-server request and answer the request with the
	 * student's choice. A card Codex withdraws closes without an answer.
	 */
	private openCard(
		client: Client,
		requestId: RequestId,
		card: Parameters<ChatSink["openCard"]>[0],
		settle: (answer: CardAnswer, answerCodex: (result: unknown) => void) => CardOutcome,
	): void {
		// A card shows one request per id: an older one for the same item is declined first.
		for (const open of [...this.open.values()]) {
			if (open.cardId === card.id) open.withdrawn.abort();
		}
		const withdrawn = new AbortController();
		this.open.set(requestId, { cardId: card.id, withdrawn });
		const answerCodex = (result: unknown) => {
			if (this.open.delete(requestId)) client.respond(requestId, result);
		};
		this.host
			.sink()
			.openCard(
				card,
				(answer) => settle(answer, answerCodex),
				AbortSignal.any([withdrawn.signal, this.ended.signal]),
			);
	}

	private approval(
		client: Client,
		requestId: RequestId,
		params: unknown,
		kind: "commandExecution" | "fileChange",
	): void {
		const request = parsed(CommandApprovalRequest, params);
		if (!request) {
			client.respond(requestId, { decision: "decline" });
			return;
		}
		const row: ToolRow = this.host.mapperOf(request.threadId).row(request.itemId) ??
			toolRow({
				...(params as object),
				type: kind,
				id: request.itemId,
				status: "inProgress",
			}) ?? {
				id: request.itemId,
				name: kind,
				title: kind === "fileChange" ? "files" : "a command",
				input: {},
			};
		const options = approvalOptions(
			kind === "commandExecution" ? (request.availableDecisions ?? []) : undefined,
		);
		const deny =
			options.find((option) => option.decision === "denied")?.id ?? "decline";
		this.openCard(
			client,
			requestId,
			approvalCard(row, options),
			(answer, answerCodex) => {
				if (answer.type !== "permission") {
					answerCodex({ decision: deny });
					return {};
				}
				answerCodex({ decision: answer.optionId });
				const decision = options.find(
					(option) => option.id === answer.optionId,
				)?.decision;
				if (decision === "denied" && answer.message) {
					void this.host.deliver(answer.message, answer.optionId !== "cancel");
				}
				return decision ? { decision } : {};
			},
		);
	}

	private elicitation(client: Client, requestId: RequestId, params: unknown): void {
		const request = parsed(ElicitationRequest, params);
		const tool = request?._meta?.tool_name;
		if (request?._meta?.codex_approval_kind !== "mcp_tool_call" || !tool) {
			client.respond(requestId, { action: "decline", content: null, _meta: null });
			this.host.sink().emit({ type: "error", message: ELICITATION_NOTICE });
			return;
		}
		const taken = new Set([...this.open.values()].map((open) => open.cardId));
		const row = this.host
			.mapperOf(request.threadId)
			.mcpRow(request.serverName, tool, request._meta?.tool_params, taken);
		const card = mcpCard(row?.id ?? `mcp-${requestId}`, request.serverName, tool, row);
		this.openCard(client, requestId, card, (answer, answerCodex) => {
			const optionId = answer.type === "permission" ? answer.optionId : "decline";
			answerCodex(mcpAnswer(optionId));
			const decision = card.options.find((option) => option.id === optionId)?.decision;
			if (answer.type === "permission" && decision === "denied" && answer.message) {
				void this.host.deliver(answer.message, true);
			}
			return answer.type === "permission" && decision ? { decision } : {};
		});
	}

	private question(client: Client, requestId: RequestId, params: unknown): void {
		const request = parsed(UserInputRequest, params);
		const card = request ? questionCard(request) : null;
		if (!request || !card) {
			client.respond(requestId, { answers: {} });
			this.host.sink().emit({
				type: "error",
				message: "Codex asked a question the chat cannot show, so it was skipped.",
			});
			return;
		}
		this.postState("needs-input");
		const ended = this.ended.signal;
		this.openCard(client, requestId, card, (answer, answerCodex) => {
			// The answers may be secret: they go to Codex and nowhere else.
			answerCodex(
				questionAnswer(request, answer.type === "question" ? answer.answers : {}),
			);
			if (answer.type === "question") this.postState("working");
			else if (ended.aborted) this.postState("finished");
			return {};
		});
	}

	/** A Plan turn ended with a plan: ask whether to carry it out. */
	askAboutPlan(plan: { id: string; text: string }): void {
		const sink = this.host.sink();
		this.postState("needs-input");
		// The card's own row, so its decision has a row to land on.
		sink.emit(planRow(plan.id, plan.text));
		const card = planCard(plan.id, plan.text);
		sink.openCard(
			card,
			(answer) => {
				sink.emit({ type: "tool.finished", id: plan.id, isError: false });
				if (answer.type !== "permission") {
					this.postState("finished");
					return {};
				}
				const decision = card.options.find(
					(option) => option.id === answer.optionId,
				)?.decision;
				if (answer.optionId === PLAN_OPTION.keepPlanning && !answer.message) {
					this.postState("finished");
				} else if (answer.optionId === PLAN_OPTION.keepPlanning) {
					this.postState("working");
					void this.host.send(answer.message ?? "").catch(() => undefined);
				} else {
					this.postState("working");
					this.host.setMode(
						answer.optionId === PLAN_OPTION.ask ? "untrusted" : CODEX_DEFAULT_MODE,
					);
					void this.host.send(IMPLEMENT_PLAN).catch(() => undefined);
				}
				return decision ? { decision } : {};
			},
			this.ended.signal,
		);
	}

	private postState(state: PostedState): void {
		void this.host.postState(state).catch(() => undefined);
	}
}
