import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import {
	type ChatAttachment,
	ChatEffort,
	type ChatMcpServer,
	type ChatMcpStatus,
	type ChatModeInfo,
	ChatModelInfo,
	type ChatShellItem,
	isShellCommand,
	MAX_CHAT_MCP_SERVERS,
	MAX_CHAT_MODELS,
	shellCommandText,
} from "@portikus/contracts";
import type { Logger } from "@portikus/observability";
import type {
	CardAnswer,
	CardOutcome,
	ChatAgent,
	ChatEventBody,
	ChatRenameResult,
	ChatSettingsChange,
	ChatSink,
	ContextFigures,
} from "../agent.js";
import { ChatCore } from "../core.js";
import { writeChatSession } from "../session-record.js";
import { runningShell, shellRefusal, withoutKind } from "../shell-command.js";
import { ChatTitle } from "../titles.js";
import {
	AppServerClient,
	type AppServerProcess,
	type AppServerClient as Client,
	type RequestId,
	spawnAppServer,
} from "./app-server.js";
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
import { codexCommands, slashCommand } from "./commands.js";
import {
	REPLAYED_TURNS,
	replayTurns,
	shellItem,
	turnStatus,
	userShell,
} from "./history.js";
import { codexInput } from "./input.js";
import { CodexItemMapper, type ToolRow, toolRow } from "./mapper.js";
import {
	CODEX_MODES,
	CODEX_START_MODE,
	type CodexModeId,
	DEFAULT_WORKSPACE_SANDBOX,
	isCodexMode,
	modePolicy,
	type SandboxPolicy,
} from "./modes.js";
import {
	CommandApprovalRequest,
	DeltaNotification,
	ElicitationRequest,
	ErrorNotification,
	ItemBase,
	ItemNotification,
	McpStartupNotification,
	McpStatusList,
	ModelList,
	NameNotification,
	PlanNotification,
	parsed,
	ResolvedNotification,
	SkillsList,
	TextItem,
	ThreadResult,
	TokenUsageNotification,
	type Turn,
	type TurnError,
	TurnNotification,
	TurnStartResult,
	TurnsList,
	UserInputRequest,
} from "./protocol.js";
import { CodexSubagents } from "./subagents.js";

/** The shared, unmodified Codex CLI (SPEC.md §10.1). */
const CODEX_COMMAND = "codex";

/** How long a `!` command may run before Codex stops it (ADR 0073). */
const SHELL_TIME_LIMIT_MS = 2 * 60 * 1000;

/** Codex's own connector server for ChatGPT apps; not one of the student's servers. */
const CODEX_APPS_SERVER = "codex_apps";

export const SIGN_IN_MESSAGE =
	"Sign in to Codex in a Codex (TUI) tab, or run codex login --device-auth";
const ELICITATION_MESSAGE =
	"An MCP server asked for input. Use a terminal tab to answer it.";
const STOPPED_MESSAGE = "Codex stopped. Send a message to resume.";
const START_FAILED_MESSAGE = "Codex could not start. Send a message to try again.";
const BUSY_MESSAGE = "Wait for Codex to finish, or stop it first.";
const IMPLEMENT_PLAN = "Implement the plan.";

/** The coding-agent states the host posts itself; no Codex hook fires for a question. */
export type PostedState = "needs-input" | "working" | "finished";

export interface CodexHostOptions {
	terminalId: string;
	/**
	 * The Codex thread this tab runs, as `recordChatSession` resolved it; the
	 * terminal id itself means none yet (SPEC.md §10.8).
	 */
	sessionId?: string;
	projectDir: string;
	homeDir: string;
	socketDir: string;
	log: Logger;
	/** Posts the conversation title to the loopback receiver (ADR 0074). */
	postTitle: (title: string | null) => Promise<void>;
	/** Posts the tab's state to the loopback receiver (SPEC.md §10.8). */
	postState: (state: PostedState) => Promise<void>;
	/** For tests only: a stand-in for the app-server process. */
	spawn?: (cwd: string) => AppServerProcess;
}

/** The sink with the two lists a host sends besides models and commands. */
type CodexSink = ChatSink & {
	modes(list: ChatModeInfo[]): void;
	mcp(list: ChatMcpServer[]): void;
};

/** A chat tab's host running Codex through `codex app-server` (SPEC.md §10.8). */
export class CodexChatHost extends ChatCore {
	constructor(options: CodexHostOptions) {
		super(options, new CodexAgent(options));
	}
}

interface Settings {
	model: string;
	effort: string;
	mode: CodexModeId;
}

/** A thread's runtime status as the chat's MCP list words it. */
function mcpStatus(
	runtime: string | null | undefined,
	auth?: string | null,
): ChatMcpStatus {
	switch (runtime) {
		case "connected":
		case "ready":
			return "connected";
		case "failed":
		case "cancelled":
			return "failed";
		case "authenticationRequired":
			return "needsAuth";
		case "disabled":
			return "disabled";
		default:
			return auth === "notLoggedIn" ? "needsAuth" : "starting";
	}
}

/** What an error a turn ended with tells the student. */
function errorText(error: TurnError | null | undefined): string {
	if (error?.codexErrorInfo === "unauthorized") return SIGN_IN_MESSAGE;
	const message = error?.message?.trim();
	return message ? message.slice(0, 500) : "Codex hit an error.";
}

/** The Codex driver behind the chat core: app-server in, chat events out. */
export class CodexAgent implements ChatAgent {
	private sink!: CodexSink;
	private client: Client | null = null;
	private starting: Promise<void> | null = null;
	private stopping = false;
	private threadId: string | null = null;
	private threadName: string | null = null;
	private turnId: string | null = null;
	private turnRunning = false;
	/** Resolves once the running turn's id is known, for a steer. */
	private turnStart: Promise<void> | null = null;
	/** The turn has shown its error already. */
	private turnErrorShown = false;
	/** The plan a Plan turn ended with, which its card asks about. */
	private plan: { id: string; text: string } | null = null;
	/** Messages that wait for the running turn to end, such as a deny reason after Cancel. */
	private afterTurn: string[] = [];
	/** The collaboration mode last sent; Codex keeps it for later turns. */
	private collaboration: "default" | "plan" = "default";
	private mapper = new CodexItemMapper();
	private readonly subagents: CodexSubagents;
	private readonly title: ChatTitle;
	private models: ChatModelInfo[] = [];
	private settings: Settings = { model: "", effort: "", mode: CODEX_START_MODE };
	private workspace: SandboxPolicy = DEFAULT_WORKSPACE_SANDBOX;
	private context: ContextFigures | null = null;
	private skills: SkillsList | null = null;
	private readonly mcp = new Map<string, ChatMcpStatus>();
	/** The `!` command running now; its turn id once Codex starts it. */
	private shell: { item: ChatShellItem; turnId: string | null } | null = null;
	private recording: Promise<void> = Promise.resolve();
	/** Aborted when the conversation ends, which closes its open cards. */
	private ended = new AbortController();
	/** Open cards by the app-server request they answer, so Codex can withdraw one. */
	private readonly requests = new Map<RequestId, AbortController>();

	constructor(private readonly options: CodexHostOptions) {
		this.subagents = new CodexSubagents({
			terminalId: options.terminalId,
			turns: (threadId) => this.recentTurns(threadId).then((page) => page.turns),
		});
		this.title = new ChatTitle(
			{
				sessionTitle: async () => this.threadName,
				renameSession: async (_thread, name) => {
					const client = await this.ready();
					await client.request("thread/name/set", { threadId: this.threadId, name });
					this.threadName = name;
				},
			},
			options.projectDir,
			options.postTitle,
		);
		this.threadId =
			options.sessionId && options.sessionId !== options.terminalId
				? options.sessionId
				: null;
	}

	async start(sink: ChatSink): Promise<void> {
		this.sink = sink as CodexSink;
		this.sink.modes(CODEX_MODES);
		this.publishCommands();
		// The socket opens either way; a send tries again and tells the student why it failed.
		await this.ready().catch(() =>
			this.options.log.warn("codex app-server did not start"),
		);
	}

	async stop(): Promise<void> {
		this.stopping = true;
		this.client?.stop();
		this.client = null;
	}

	/** The app-server, started and on its thread; a stopped one is started again. */
	private async ready(): Promise<Client> {
		if (!this.client?.running) {
			this.starting ??= this.boot().finally(() => {
				this.starting = null;
			});
			await this.starting.catch(() => {
				throw new Error(START_FAILED_MESSAGE);
			});
		}
		if (!this.client) throw new Error(STOPPED_MESSAGE);
		return this.client;
	}

	private async boot(): Promise<void> {
		const { projectDir } = this.options;
		const child = (this.options.spawn ?? ((cwd) => spawnAppServer(CODEX_COMMAND, cwd)))(
			projectDir,
		);
		const client: Client = new AppServerClient(child, {
			notification: (method, params) => {
				if (client === this.client) this.onNotification(method, params);
			},
			request: (id, method, params) => {
				if (client === this.client) this.onRequest(client, id, method, params);
			},
			exit: () => {
				if (client === this.client) this.onExit();
			},
		});
		this.client = client;
		try {
			await this.handshake(client);
		} catch (error) {
			// A half-started app-server is ended quietly; the caller reports the failure.
			this.client = null;
			client.stop();
			throw error;
		}
	}

	private async handshake(client: Client): Promise<void> {
		const init = (await client.request("initialize", {
			clientInfo: { name: "portikus", title: "Portikus", version: "0" },
			// Plan mode and questions sit behind Codex's experimental API.
			capabilities: { experimentalApi: true },
		})) as { userAgent?: unknown } | null;
		client.notify("initialized");
		const version = /\/(\d+\.\d+\.\d+)/.exec(String(init?.userAgent ?? ""))?.[1];
		this.options.log.info({ codex: version ?? "unknown" }, "codex app-server started");
		await this.openThread(client);
		await this.readModels(client);
		this.broadcastSettings();
		void this.readSkills(client, false);
		void this.readMcp(client);
	}

	/** Resume the tab's thread, or start one when it has none Codex can find. */
	private async openThread(client: Client): Promise<void> {
		const policy = modePolicy(this.settings.mode, this.workspace);
		const common = {
			cwd: this.options.projectDir,
			approvalPolicy: policy.approvalPolicy,
			sandbox: policy.sandbox,
			...(this.settings.model ? { model: this.settings.model } : {}),
		};
		let result: ThreadResult | null = null;
		if (this.threadId) {
			result = parsed(
				ThreadResult,
				await client
					.request("thread/resume", {
						threadId: this.threadId,
						...common,
						excludeTurns: true,
					})
					.catch(() => null),
			);
			if (result) this.options.log.info("codex thread resumed");
		}
		if (!result) {
			result = parsed(ThreadResult, await client.request("thread/start", common));
			if (!result) throw new Error("Codex did not start a conversation.");
			this.options.log.info("codex thread started");
		}
		this.adoptThread(result);
	}

	private adoptThread(result: ThreadResult): void {
		const id = result.thread.id;
		if (id !== this.threadId) {
			this.threadId = id;
			// One write at a time, so the record ends at the latest thread.
			this.recording = this.recording
				.then(() => writeChatSession(this.options.homeDir, this.options.terminalId, id))
				.catch(() => this.options.log.warn("could not record the chat's codex thread"));
		}
		this.threadName = result.thread.name ?? null;
		this.settings.model ||= result.model;
		this.settings.effort ||= result.reasoningEffort ?? "";
		const sandbox = result.sandbox as { type?: unknown } | undefined;
		if (sandbox?.type === "workspaceWrite") this.workspace = sandbox as SandboxPolicy;
		void this.title.refresh(id);
	}

	private async readModels(client: Client): Promise<void> {
		let list: ModelList | null = null;
		try {
			list = parsed(
				ModelList,
				await client.request("model/list", { limit: MAX_CHAT_MODELS }),
			);
		} catch {
			// The picker keeps the model the thread runs.
		}
		if (!list) return;
		const models: ChatModelInfo[] = [];
		for (const row of list.data) {
			if (row.hidden) continue;
			const efforts = (row.supportedReasoningEfforts ?? [])
				.map((each) => each.reasoningEffort)
				.filter((effort) => ChatEffort.safeParse(effort).success);
			const model = ChatModelInfo.safeParse({
				value: row.id,
				displayName: row.displayName.slice(0, 100),
				description: (row.description ?? "").slice(0, 300),
				supportsAutoMode: true,
				efforts: efforts.slice(0, 10),
				...(row.defaultReasoningEffort
					? { defaultEffort: row.defaultReasoningEffort }
					: {}),
			});
			if (model.success) models.push(model.data);
		}
		this.models = models.slice(0, MAX_CHAT_MODELS);
		if (!this.settings.effort) {
			this.settings.effort =
				this.modelInfo(this.settings.model)?.defaultEffort ?? "medium";
		}
		this.sink.models(this.models);
	}

	private modelInfo(model: string): ChatModelInfo | undefined {
		return this.models.find((row) => row.value === model);
	}

	/** The student's skills, as `$name` commands; read again when Codex says they changed. */
	private async readSkills(client: Client, forceReload: boolean): Promise<void> {
		try {
			this.skills = parsed(
				SkillsList,
				await client.request("skills/list", {
					cwds: [this.options.projectDir],
					forceReload,
				}),
			);
			this.publishCommands();
		} catch {
			// The fixed commands stay on offer.
		}
	}

	private publishCommands(): void {
		this.sink.commands(codexCommands(this.skills));
	}

	/** The student's MCP servers: names and status only (ADR 0012). */
	private async readMcp(client: Client): Promise<void> {
		const seen = new Map<string, ChatMcpStatus>();
		let cursor: string | null | undefined;
		try {
			for (let page = 0; page < 5; page += 1) {
				const list = parsed(
					McpStatusList,
					await client.request("mcpServerStatus/list", {
						detail: "toolsAndAuthOnly",
						threadId: this.threadId,
						limit: MAX_CHAT_MCP_SERVERS,
						...(cursor ? { cursor } : {}),
					}),
				);
				if (!list) break;
				for (const server of list.data) {
					if (server.name !== CODEX_APPS_SERVER) {
						seen.set(server.name, mcpStatus(server.runtimeStatus, server.authStatus));
					}
				}
				cursor = list.nextCursor;
				if (!cursor) break;
			}
		} catch {
			return;
		}
		this.mcp.clear();
		for (const [name, status] of seen) this.mcp.set(name, status);
		this.publishMcp();
	}

	private publishMcp(): void {
		const servers = [...this.mcp]
			.filter(([name]) => name.length >= 1 && name.length <= 64)
			.slice(0, MAX_CHAT_MCP_SERVERS)
			.map(([name, status]) => ({ name, status }));
		this.sink.mcp(servers);
	}

	private onExit(): void {
		this.client = null;
		this.options.log.info("codex app-server ended");
		this.endConversationState("error");
		if (!this.stopping) this.sink.emit({ type: "error", message: STOPPED_MESSAGE });
	}

	/** Close the cards and subagents of a conversation that is over or replaced. */
	private endConversationState(subagents: "error" | "interrupted"): void {
		this.ended.abort();
		this.ended = new AbortController();
		this.requests.clear();
		this.subagents.ended(subagents);
		if (this.shell) this.finishShell({ ...this.shell.item, state: "done" });
		if (this.turnRunning) this.finishTurn("error", null);
	}

	private onNotification(method: string, params: unknown): void {
		switch (method) {
			case "skills/changed":
				if (this.client) void this.readSkills(this.client, true);
				return;
			case "mcpServer/startupStatus/updated":
				this.mcpChanged(params);
				return;
			case "serverRequest/resolved": {
				const resolved = parsed(ResolvedNotification, params);
				const open = resolved ? this.requests.get(resolved.requestId) : undefined;
				if (resolved && open) {
					this.requests.delete(resolved.requestId);
					open.abort();
				}
				return;
			}
		}
		const threadId = (params as { threadId?: unknown } | null)?.threadId;
		if (typeof threadId !== "string") return;
		// A subagent's events share the stream, tagged with its own thread id.
		if (threadId === this.threadId) this.onThreadEvent(method, params);
		else this.subagents.notification(threadId, method, params);
	}

	private mcpChanged(params: unknown): void {
		const update = parsed(McpStartupNotification, params);
		if (!update || update.name === CODEX_APPS_SERVER) return;
		if (update.threadId && update.threadId !== this.threadId) return;
		const status = mcpStatus(update.status);
		if (this.mcp.get(update.name) === status) return;
		this.mcp.set(update.name, status);
		this.publishMcp();
	}

	private onThreadEvent(method: string, params: unknown): void {
		switch (method) {
			case "turn/started":
				this.turnStarted(params);
				return;
			case "turn/completed":
				this.turnCompleted(params);
				return;
			case "item/started":
			case "item/completed":
				this.itemEvent(method, params);
				return;
			case "item/agentMessage/delta": {
				const delta = parsed(DeltaNotification, params);
				if (delta)
					for (const event of this.mapper.delta(delta.itemId, delta.delta))
						this.sink.emit(event);
				return;
			}
			case "turn/plan/updated": {
				const update = parsed(PlanNotification, params);
				if (update) {
					for (const event of this.mapper.planSteps(update.turnId, update.plan))
						this.sink.emit(event);
				}
				return;
			}
			case "thread/tokenUsage/updated": {
				const usage = parsed(TokenUsageNotification, params)?.tokenUsage;
				if (!usage) return;
				const window = usage.modelContextWindow;
				this.context = {
					usedTokens: Math.max(0, Math.round(usage.last.totalTokens)),
					windowTokens: window && window > 0 ? Math.round(window) : null,
					cache: null,
				};
				this.sink.context(this.context);
				return;
			}
			case "thread/name/updated": {
				const update = parsed(NameNotification, params);
				if (!update) return;
				this.threadName = update.threadName ?? null;
				void this.title.refresh(update.threadId);
				return;
			}
			case "error": {
				const error = parsed(ErrorNotification, params);
				if (!error || error.willRetry) return;
				this.turnErrorShown = true;
				this.sink.emit({ type: "error", message: errorText(error.error) });
			}
		}
	}

	private turnStarted(params: unknown): void {
		const turn = parsed(TurnNotification, params)?.turn;
		if (!turn) return;
		if (this.shell && this.shell.turnId === null && !this.turnRunning) {
			this.shell.turnId = turn.id;
			return;
		}
		this.turnId = turn.id;
		if (!this.turnRunning) this.beginTurn();
	}

	private turnCompleted(params: unknown): void {
		const turn = parsed(TurnNotification, params)?.turn;
		if (!turn) return;
		if (this.shell?.turnId === turn.id) {
			this.finishShell({ ...this.shell.item, state: "done" });
			return;
		}
		if (!this.turnRunning) return;
		this.finishTurn(turnStatus(turn.status), turn.error ?? null);
	}

	private itemEvent(method: string, params: unknown): void {
		const item = parsed(ItemNotification, params)?.item;
		const base = parsed(ItemBase, item);
		if (!base) return;
		const shell = userShell(item);
		if (shell) {
			// Shown as done once its turn ends, so no message reaches Codex mid-turn.
			if (method === "item/completed" && this.shell) {
				this.shell.item = shellItem(this.shell.item.id, shell);
			}
			return;
		}
		// The student's own message was shown when it was sent.
		if (base.type === "userMessage") return;
		if (method === "item/started") {
			for (const event of this.mapper.started(item)) this.sink.emit(event);
			return;
		}
		if (base.type === "plan") {
			const text = parsed(TextItem, item)?.text;
			if (text) this.plan = { id: base.id, text };
		}
		for (const event of this.mapper.completed(item)) this.sink.emit(event);
	}

	private beginTurn(): void {
		this.turnRunning = true;
		this.turnErrorShown = false;
		this.plan = null;
		this.sink.emit({ type: "turn.started", at: Date.now() });
	}

	private finishTurn(
		status: "done" | "interrupted" | "error",
		error: TurnError | null,
	): void {
		this.turnRunning = false;
		this.turnId = null;
		this.turnStart = null;
		if (error && !this.turnErrorShown) {
			this.sink.emit({ type: "error", message: errorText(error) });
		}
		this.sink.emit({ type: "turn.finished", status, at: Date.now() });
		const plan = this.plan;
		this.plan = null;
		if (plan && status === "done") this.askAboutPlan(plan);
		for (const message of this.afterTurn.splice(0)) {
			void this.send(message, []).catch(() => undefined);
		}
	}

	private finishShell(item: ChatShellItem): void {
		this.shell = null;
		this.sink.emit({ type: "shell", ...withoutKind(item) });
	}

	private onRequest(
		client: Client,
		id: RequestId,
		method: string,
		params: unknown,
	): void {
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

	/** The item mapper of the thread a request is about. */
	private mapperOf(threadId: string): CodexItemMapper {
		return threadId === this.threadId ? this.mapper : this.subagents.mapper(threadId);
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
		const withdrawn = new AbortController();
		this.requests.set(requestId, withdrawn);
		const answerCodex = (result: unknown) => {
			if (this.requests.delete(requestId)) client.respond(requestId, result);
		};
		this.sink.openCard(
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
		const row: ToolRow = this.mapperOf(request.threadId).row(request.itemId) ??
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
					void this.deliver(answer.message, answer.optionId !== "cancel");
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
			this.sink.emit({ type: "error", message: ELICITATION_MESSAGE });
			return;
		}
		const row = this.mapperOf(request.threadId).mcpRow(request.serverName, tool);
		const card = mcpCard(row?.id ?? `mcp-${requestId}`, request.serverName, tool, row);
		this.openCard(client, requestId, card, (answer, answerCodex) => {
			const optionId = answer.type === "permission" ? answer.optionId : "decline";
			answerCodex(mcpAnswer(optionId));
			const decision = card.options.find((option) => option.id === optionId)?.decision;
			if (answer.type === "permission" && decision === "denied" && answer.message) {
				void this.deliver(answer.message, true);
			}
			return answer.type === "permission" && decision ? { decision } : {};
		});
	}

	private question(client: Client, requestId: RequestId, params: unknown): void {
		const request = parsed(UserInputRequest, params);
		const card = request ? questionCard(request) : null;
		if (!request || !card) {
			client.respond(requestId, { answers: {} });
			this.sink.emit({
				type: "error",
				message: "Codex asked a question the chat cannot show, so it was skipped.",
			});
			return;
		}
		this.postState("needs-input");
		this.openCard(client, requestId, card, (answer, answerCodex) => {
			// The answers may be secret: they go to Codex and nowhere else.
			answerCodex(
				questionAnswer(request, answer.type === "question" ? answer.answers : {}),
			);
			this.postState("working");
			return {};
		});
	}

	/** A Plan turn ended with a plan: ask whether to carry it out. */
	private askAboutPlan(plan: { id: string; text: string }): void {
		this.postState("needs-input");
		const card = planCard(plan.id, plan.text);
		this.sink.openCard(
			card,
			(answer) => {
				if (answer.type !== "permission") return {};
				const decision = card.options.find(
					(option) => option.id === answer.optionId,
				)?.decision;
				if (answer.optionId === PLAN_OPTION.keepPlanning) {
					if (answer.message) void this.send(answer.message, []).catch(() => undefined);
					else this.postState("finished");
				} else {
					this.settings.mode =
						answer.optionId === PLAN_OPTION.ask ? "untrusted" : "onRequest";
					this.broadcastSettings();
					void this.send(IMPLEMENT_PLAN, []).catch(() => undefined);
				}
				return decision ? { decision } : {};
			},
			this.ended.signal,
		);
	}

	private postState(state: PostedState): void {
		void this.options.postState(state).catch(() => undefined);
	}

	/**
	 * A deny reason, sent as the student's next message: into the running
	 * turn when Codex goes on with it, else once the turn ends.
	 */
	private async deliver(message: string, steerable: boolean): Promise<void> {
		if (this.turnRunning && steerable) {
			try {
				await this.steer(message);
				return;
			} catch {
				// The turn ended first; the message starts the next one.
			}
		}
		if (this.turnRunning) this.afterTurn.push(message);
		else await this.send(message, []).catch(() => undefined);
	}

	async history(_turnRunning: boolean): ReturnType<ChatAgent["history"]> {
		if (!this.threadId || !this.client) {
			return { events: [], truncated: false, context: this.context };
		}
		try {
			const { turns, truncated } = await this.recentTurns(this.threadId);
			return { events: replayTurns(turns), truncated, context: this.context };
		} catch {
			this.options.log.warn("could not read the chat history");
			return { events: [], truncated: false, context: this.context };
		}
	}

	/** A thread's last turns, oldest first, and whether older ones exist. */
	private async recentTurns(
		threadId: string,
	): Promise<{ turns: Turn[]; truncated: boolean }> {
		const client = this.client;
		if (!client) return { turns: [], truncated: false };
		const page = parsed(
			TurnsList,
			await client.request("thread/turns/list", {
				threadId,
				limit: REPLAYED_TURNS,
				sortDirection: "desc",
				itemsView: "full",
			}),
		);
		if (!page) return { turns: [], truncated: false };
		return { turns: [...page.data].reverse(), truncated: Boolean(page.nextCursor) };
	}

	inProgress(): ChatEventBody[] {
		return this.shell ? [{ type: "shell", ...withoutKind(this.shell.item) }] : [];
	}

	rename(title: string): Promise<ChatRenameResult> {
		return this.title.answerRename(this.threadId ?? this.options.terminalId, title);
	}

	/** A subagent is its child thread, watched by that thread's id. */
	watchSubagent(socket: Socket, threadId: string): Promise<void> {
		return this.subagents.watch(socket, threadId);
	}

	unwatchSubagent(socket: Socket, threadId: string): void {
		this.subagents.unwatch(socket, threadId);
	}

	/** Codex keeps its "for this chat" grants itself; there are no rules to revoke. */
	async revokeRule(_rule: string): Promise<void> {}

	async interrupt(): Promise<void> {
		const client = this.client;
		if (!client || !this.threadId) return;
		const turnId = this.shell
			? this.shell.turnId
			: this.turnRunning
				? this.turnId
				: null;
		if (turnId) {
			await client
				.request("turn/interrupt", { threadId: this.threadId, turnId })
				.catch(() => undefined);
		}
	}

	async send(text: string, attachments: ChatAttachment[]): Promise<void> {
		if (this.shell) throw new Error("Wait for the shell command to finish.");
		if (isShellCommand(text)) return this.runShell(shellCommandText(text), attachments);
		const command = attachments.length === 0 ? slashCommand(text) : null;
		if (command) return this.runCommand(command.name, command.rest, text);
		if (this.turnRunning) return this.steer(text, attachments);
		const input = await codexInput(
			this.options.homeDir,
			this.options.projectDir,
			text,
			attachments,
		);
		if (input.length === 0) return;
		const client = await this.ready();
		this.userMessage(text, attachments);
		this.beginTurn();
		const { model, effort, mode } = this.settings;
		const policy = modePolicy(mode, this.workspace);
		const collaboration = mode === "plan" ? "plan" : "default";
		const start = client.request("turn/start", {
			threadId: this.threadId,
			input,
			approvalPolicy: policy.approvalPolicy,
			sandboxPolicy: policy.sandboxPolicy,
			...(model ? { model } : {}),
			...(effort ? { effort } : {}),
			// Sent only on a change, with Codex's own instructions for the mode.
			...(collaboration !== this.collaboration
				? {
						collaborationMode: {
							mode: collaboration,
							settings: {
								model,
								reasoning_effort: effort || null,
								developer_instructions: null,
							},
						},
					}
				: {}),
		});
		this.turnStart = start.then(
			(result) => {
				const turn = parsed(TurnStartResult, result)?.turn;
				if (turn && this.turnRunning) this.turnId ??= turn.id;
			},
			() => undefined,
		);
		try {
			await start;
			this.collaboration = collaboration;
		} catch (error) {
			if (this.turnRunning) this.finishTurn("error", null);
			throw new Error(error instanceof Error ? error.message : "Codex did not start.");
		}
	}

	/** Add a message to the running turn. */
	private async steer(text: string, attachments: ChatAttachment[] = []): Promise<void> {
		const input = await codexInput(
			this.options.homeDir,
			this.options.projectDir,
			text,
			attachments,
		);
		if (input.length === 0) return;
		await this.turnStart;
		const client = this.client;
		if (!client || !this.turnId) throw new Error(BUSY_MESSAGE);
		try {
			await client.request("turn/steer", {
				threadId: this.threadId,
				input,
				expectedTurnId: this.turnId,
			});
		} catch {
			throw new Error("Codex cannot take a message right now. Wait, or stop it first.");
		}
		this.userMessage(text, attachments);
	}

	private userMessage(text: string, attachments: ChatAttachment[]): void {
		this.sink.emit({
			type: "message",
			id: randomUUID(),
			role: "user",
			markdown: text,
			...(attachments.length > 0 ? { attachments } : {}),
		});
	}

	/** Run a `!` command with Codex's own shell command, outside the model (ADR 0073). */
	private async runShell(
		command: string,
		attachments: ChatAttachment[],
	): Promise<void> {
		if (this.turnRunning) {
			throw new Error(
				"A shell command cannot run while Codex is working. Wait, or stop it first.",
			);
		}
		const refused = shellRefusal(command, attachments.length, false);
		if (refused) throw new Error(refused);
		const client = await this.ready();
		const item = runningShell(randomUUID(), command);
		this.shell = { item, turnId: null };
		this.sink.emit({ type: "shell", ...withoutKind(item) });
		try {
			await client.request("thread/shellCommand", {
				threadId: this.threadId,
				command,
				timeoutMs: SHELL_TIME_LIMIT_MS,
			});
		} catch {
			if (this.shell?.item.id === item.id) this.finishShell({ ...item, state: "done" });
			throw new Error("The shell command could not start.");
		}
	}

	/** A slash command the chat runs itself (the fixed list in commands.ts). */
	private async runCommand(name: string, rest: string, typed: string): Promise<void> {
		switch (name) {
			case "model":
				if (!rest) throw new Error("Choose a model with the Model picker.");
				return this.set({ model: rest });
			case "effort":
				if (!rest) throw new Error("Choose an effort with the Effort picker.");
				return this.set({ effort: rest });
			case "permissions": {
				const mode = CODEX_MODES.find(
					(each) =>
						each.id.toLowerCase() === rest.toLowerCase() ||
						each.label.toLowerCase() === rest.toLowerCase(),
				);
				if (!mode) throw new Error("Choose a mode with the Permissions picker.");
				return this.set({ mode: mode.id });
			}
			case "plan":
				await this.set({ mode: "plan" });
				if (rest) await this.send(rest, []);
				return;
			case "rename": {
				if (!rest) throw new Error("Type the new title after /rename.");
				const result = await this.rename(rest);
				if (!result.ok)
					throw new Error(result.message ?? "The chat could not be renamed.");
				return;
			}
			case "mcp":
				return this.readMcp(await this.ready());
		}
		if (this.turnRunning) throw new Error(BUSY_MESSAGE);
		const client = await this.ready();
		if (name === "new" || name === "clear") return this.newConversation(client);
		this.userMessage(typed, []);
		if (name === "compact") {
			await client.request("thread/compact/start", { threadId: this.threadId });
			return;
		}
		await client.request("review/start", {
			threadId: this.threadId,
			target: rest
				? { type: "custom", instructions: rest }
				: { type: "uncommittedChanges" },
		});
	}

	/** `/new` and `/clear`: a fresh thread, recorded so Resume continues it. */
	private async newConversation(client: Client): Promise<void> {
		const policy = modePolicy(this.settings.mode, this.workspace);
		const result = parsed(
			ThreadResult,
			await client.request("thread/start", {
				cwd: this.options.projectDir,
				approvalPolicy: policy.approvalPolicy,
				sandbox: policy.sandbox,
				...(this.settings.model ? { model: this.settings.model } : {}),
			}),
		);
		if (!result) throw new Error("Codex did not start a new conversation.");
		const old = this.threadId;
		if (old)
			void client
				.request("thread/unsubscribe", { threadId: old })
				.catch(() => undefined);
		this.endConversationState("interrupted");
		this.mapper = new CodexItemMapper();
		this.context = null;
		this.collaboration = "default";
		this.title.reset();
		this.adoptThread(result);
		this.sink.conversationReset(null);
		void this.readMcp(client);
	}

	async set(change: ChatSettingsChange): Promise<void> {
		const next = { ...this.settings };
		if (change.model !== undefined) {
			next.model = change.model;
			const efforts = this.modelInfo(change.model)?.efforts;
			if (efforts && !efforts.includes(next.effort)) {
				next.effort =
					this.modelInfo(change.model)?.defaultEffort ?? efforts[0] ?? next.effort;
			}
		}
		if (change.effort !== undefined) {
			const efforts = this.modelInfo(next.model)?.efforts;
			if (efforts && !efforts.includes(change.effort)) {
				throw new Error("This model does not offer that effort.");
			}
			next.effort = change.effort;
		}
		if (change.mode !== undefined) {
			if (!isCodexMode(change.mode))
				throw new Error("Codex has no such permission mode.");
			next.mode = change.mode;
		}
		this.settings = next;
		this.broadcastSettings();
	}

	private broadcastSettings(): void {
		const { model, effort, mode } = this.settings;
		if (!model) return;
		this.sink.settings({ agent: "codex", model, effort: effort || "medium", mode });
	}
}
