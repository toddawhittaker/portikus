import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import type {
	PermissionMode,
	PermissionResult,
	Query,
	SDKMessage,
	SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
	CHAT_START_SETTINGS,
	type ChatAttachment,
	type ChatEffort,
	type ChatOpenCard,
	type ChatPermissionMode,
	type ChatQuestion,
	type ChatShellItem,
	chatStartMode,
	isShellCommand,
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
} from "./agent.js";
import { userContent } from "./attachments.js";
import {
	type ClaudeLimitWindows,
	ClaudeMessageMapper,
	cardForTool,
	PERMISSION_OPTION,
	permissionResult,
	questionResult,
	type ToolAsk,
	UNANSWERED_CAPABILITY,
} from "./claude-adapter.js";
import {
	ContextTracker,
	fromTranscript,
	windowFromModelUsage,
} from "./context-usage.js";
import { ChatCore } from "./core.js";
import { decisionForOption } from "./decisions.js";
import { InputQueue } from "./input-queue.js";
import { ModelList } from "./model-list.js";
import { splitSuggestions } from "./permission-rules.js";
import { PlanUsage } from "./plan-usage.js";
import { type ChatSdk, realSdk } from "./sdk.js";
import { writeChatSession } from "./session-record.js";
import { SessionRules } from "./session-rules.js";
import {
	runningShell,
	runShellCommand,
	shellRefusal,
	shellTranscript,
	withoutKind,
} from "./shell-command.js";
import { SlashCommandList } from "./slash-commands.js";
import { replayHistory } from "./snapshot.js";
import { SubagentStreams } from "./subagents.js";
import { ChatTitle } from "./titles.js";

/** The longest the host waits to read the model list before it opens its socket. */
const MODELS_WAIT_MS = 3000;

/** The shared, unmodified Claude Code binary (SPEC.md §10.1). */
const CLAUDE_PATH = "/opt/portikus/coding-agents/bin/claude";

export interface ChatHostOptions {
	terminalId: string;
	/**
	 * The Claude session this tab runs, as `recordChatSession` resolved it;
	 * absent means the terminal id (SPEC.md §10.8).
	 */
	sessionId?: string;
	/** The chat's project directory, also Claude's working directory. */
	projectDir: string;
	homeDir: string;
	socketDir: string;
	log: Logger;
	/** Posts plan limits to the loopback receiver (SPEC.md §10.1). */
	postLimits: (windows: ClaudeLimitWindows) => Promise<void>;
	/** Posts the conversation title to the loopback receiver (ADR 0074). */
	postTitle: (title: string | null) => Promise<void>;
	/** For tests only: another Claude Code binary. */
	claudePath?: string;
	/** For tests only: a stand-in for the SDK. */
	sdk?: ChatSdk;
	/** For tests only: the `!` command time limit. */
	shellTimeoutMs?: number;
}

export type { ChatSdk };

/** A chat tab's host running Claude through the Agent SDK (ADR 0069). */
export class ChatHost extends ChatCore {
	constructor(options: ChatHostOptions) {
		super(options, new ClaudeAgent(options));
	}
}

/** The Claude driver behind the chat core: the Agent SDK in, chat events out. */
class ClaudeAgent implements ChatAgent {
	private sink!: ChatSink;
	private readonly sdk: ChatSdk;
	private session: Query | null = null;
	/** A session being started, shared so concurrent sends start only one. */
	private starting: Promise<void> | null = null;
	private input: InputQueue | null = null;
	/** Aborted when the session ends, which closes its open cards. */
	private ended = new AbortController();
	private mapper = new ClaudeMessageMapper();
	private turnRunning = false;
	private interrupting = false;
	/** The `!` command running now, for an attachment that arrives mid-run. */
	private shell: ChatShellItem | null = null;
	private shellStop: AbortController | null = null;
	/** A message is being read in, so a `!` waits as for a turn. */
	private sending = false;
	/** Each transcript append still owes an empty result, which ends no turn. */
	private quietResults = 0;
	/** Appends kept back while a turn runs, so they never land mid-turn (ADR 0073). */
	private heldAppends: SDKUserMessage[] = [];
	private readonly planUsage: PlanUsage;
	private readonly title: ChatTitle;
	private readonly commands = new SlashCommandList((commands) =>
		this.sink.commands(commands),
	);
	private context = new ContextTracker();
	/** The session's init said a skipped question may be marked so. */
	private reportSkipped = false;
	private readonly modelList = new ModelList((models) => this.sink.models(models));
	private settings: { model: string; effort: ChatEffort; mode: ChatPermissionMode } = {
		...CHAT_START_SETTINGS,
	};

	private readonly rules = new SessionRules(
		async (rules) => {
			await this.session?.applyFlagSettings({
				permissions:
					rules.length > 0 ? { allow: rules.map((held) => held.rule) } : null,
			});
		},
		() => this.sink.rules(this.rules.held),
	);

	/** The Claude session in force; /clear moves the tab to a new one. */
	private sessionId: string;
	private readonly subagents: SubagentStreams;

	constructor(private readonly options: ChatHostOptions) {
		this.sdk = options.sdk ?? realSdk;
		this.subagents = new SubagentStreams({
			sdk: this.sdk,
			projectDir: options.projectDir,
			terminalId: options.terminalId,
			sessionId: () => this.sessionId,
		});
		this.planUsage = new PlanUsage(options.postLimits);
		this.title = new ChatTitle(this.sdk, options.projectDir, options.postTitle);
		this.sessionId = options.sessionId ?? options.terminalId;
	}

	async start(sink: ChatSink): Promise<void> {
		this.sink = sink;
		this.broadcastSettings();
		await this.ensureSession();
		// The socket opens once the model list is read (or has taken too long), so a
		// first attach gets the list ahead of the settings that use it.
		await this.modelList.settled(MODELS_WAIT_MS);
	}

	/** Stop Claude. The transcript stays. */
	async stop(): Promise<void> {
		this.session?.close();
		this.session = null;
	}

	private ensureSession(): Promise<void> {
		if (this.session) return Promise.resolve();
		this.starting ??= this.startSession().finally(() => {
			this.starting = null;
		});
		return this.starting;
	}

	private async startSession(): Promise<void> {
		const { projectDir } = this.options;
		const sessionId = this.sessionId;
		const exists = await this.sdk
			.sessionExists(sessionId, projectDir)
			.catch(() => false);
		const input = new InputQueue();
		const ended = new AbortController();
		// Leave CLAUDE_CODE_ENTRYPOINT at the SDK's own value: Claude Code treats
		// an unrecognized label as a print (-p) session, which bills a classifier
		// call on every auto-mode tool use and rejects Console API credits.
		const session = this.sdk.query({
			prompt: input,
			options: {
				cwd: projectDir,
				// `claude --resume <session id>` in a terminal continues this chat;
				// after /clear the id is the new session's.
				...(exists ? { resume: sessionId } : { sessionId }),
				pathToClaudeCodeExecutable: this.options.claudePath ?? CLAUDE_PATH,
				includePartialMessages: true,
				// A subagent's whole conversation, for its read-only view.
				forwardSubagentText: true,
				effort: this.settings.effort,
				permissionMode: this.settings.mode,
				// The picker offers bypass, so the SDK must allow switching to it.
				allowDangerouslySkipPermissions: true,
				...(this.settings.model === "default" ? {} : { model: this.settings.model }),
				canUseTool: (toolName, toolInput, ask) =>
					this.ask(toolName, toolInput, ask, ended.signal),
				// Claude Code's own messages may quote the student's work.
				stderr: () => undefined,
			},
		});
		this.session = session;
		this.input = input;
		this.ended = ended;
		this.mapper = new ClaudeMessageMapper();
		this.quietResults = 0;
		this.rules.reset();
		void this.pump(session);
		void this.refreshCommands(session);
		void this.refreshPlanUsage(session);
		void this.refreshWindow(session, undefined);
		void this.refreshModels(session);
		void this.title.refresh(sessionId);
	}

	/** Raise a card and wait for its answer; the card closes when the ask is withdrawn. */
	private ask(
		toolName: string,
		input: Record<string, unknown>,
		ask: ToolAsk & { signal: AbortSignal },
		ended: AbortSignal,
	): Promise<PermissionResult> {
		const card = cardForTool(toolName, input, ask);
		return new Promise<PermissionResult>((resolve) => {
			this.sink.openCard(
				card,
				(answer) => this.settleCard(card, input, ask, answer, ended, resolve),
				AbortSignal.any([ask.signal, ended]),
			);
		});
	}

	private settleCard(
		card: ChatOpenCard,
		input: Record<string, unknown>,
		ask: ToolAsk,
		answer: CardAnswer,
		ended: AbortSignal,
		resolve: (result: PermissionResult) => void,
	): CardOutcome | Promise<CardOutcome> {
		if (answer.type === "closed") {
			resolve({
				behavior: "deny",
				message: ended.aborted ? "The session ended." : "Cancelled.",
			});
			return {};
		}
		if (answer.type === "question") {
			const questions = card.type === "question" ? card.questions : [];
			resolve(
				questionResult(
					input,
					questions as ChatQuestion[],
					answer.answers,
					answer.notes,
					this.reportSkipped,
				),
			);
			return {};
		}
		const { optionId } = answer;
		const result = () =>
			resolve(permissionResult(optionId, input, ask, { message: answer.message }));
		if (optionId !== PERMISSION_OPTION.allowAlways || !ask.suggestions) {
			result();
			return { decision: decisionForOption(optionId) };
		}
		// Always allow grants the session rules before Claude goes on.
		return this.rules
			.grant(splitSuggestions(ask.suggestions).sessionRules)
			.then(
				(): CardOutcome => ({ decision: decisionForOption(optionId) }),
				// The student chose to allow, so the tool still runs this once.
				(): CardOutcome => ({
					decision: "allowed",
					error:
						"Allowed this once. The Always allow rule could not be saved, so Claude will ask again next time.",
				}),
			)
			.finally(result);
	}

	/**
	 * Read the models Claude Code offers. A new chat on a model without
	 * Auto starts at Ask, not Auto (SPEC.md §10.8).
	 */
	private async refreshModels(session: Query): Promise<void> {
		const models = await this.modelList.refresh(
			() => session.supportedModels(),
			() => this.session === session,
		);
		if (!models || this.settings.mode !== CHAT_START_SETTINGS.mode) return;
		const mode = chatStartMode(models, this.settings.model);
		if (mode === this.settings.mode) return;
		await session.setPermissionMode(mode).catch(() => undefined);
		this.settings.mode = mode;
		this.broadcastSettings();
	}

	/** A main-thread request finished: tell every attachment how full the context is. */
	private requestMade(message: SDKMessage): void {
		if (message.type !== "assistant") return;
		const next = this.context.request(message, Date.now());
		if (next) this.sink.context(next);
	}

	/**
	 * Read the context window from the SDK, or from the result's
	 * `modelUsage` when the SDK cannot say. A failure keeps the last figure.
	 */
	private async refreshWindow(
		session: Query,
		modelUsage: Record<string, { contextWindow?: number }> | undefined,
	): Promise<void> {
		let window: number | null = null;
		try {
			const usage = await session.getContextUsage({ detail: "summary" });
			window = usage.maxTokens > 0 ? usage.maxTokens : null;
		} catch {
			// Older SDKs and some sessions cannot answer.
		}
		window ??= windowFromModelUsage(modelUsage, this.context.lastModel);
		if (this.session !== session || window === null) return;
		const next = this.context.window(window);
		if (next) this.sink.context(next);
	}

	private refreshPlanUsage(session: Query): Promise<void> {
		return this.planUsage.refresh(session, () => this.session === session);
	}

	/** Read the command descriptions, falling back to the names init gave. */
	private refreshCommands(session: Query): Promise<void> {
		return this.commands.refresh(
			() => session.supportedCommands(),
			() => this.session === session,
		);
	}

	private async pump(session: Query): Promise<void> {
		try {
			for await (const message of session) this.handle(message);
			this.options.log.info("claude session ended");
		} catch {
			this.options.log.warn("claude session failed");
		}
		if (this.session !== session) return;
		this.session = null;
		this.input = null;
		this.ended.abort();
		this.subagents.ended();
		if (this.turnRunning) this.finishTurn("error");
		this.sink.emit({
			type: "error",
			message: "Claude Code stopped. Send a message to resume.",
		});
	}

	private handle(message: SDKMessage): void {
		this.followSession(message);
		if (this.subagents.handle(message)) return;
		if (this.handleControl(message)) return;
		if (message.type === "stream_event" && !this.turnRunning) this.beginTurn();
		this.requestMade(message);
		for (const event of this.mapper.map(message)) this.sink.emit(event);
	}

	/** Messages about the session rather than the conversation; true when handled. */
	private handleControl(message: SDKMessage): boolean {
		if (message.type === "system" && message.subtype === "init") {
			this.sessionStarted(message);
			return true;
		}
		// Always allow can switch the mode mid-turn; the picker shows the mode in force.
		if (message.type === "system" && message.subtype === "status") {
			if (message.permissionMode) this.modeChanged(message.permissionMode);
			return true;
		}
		if (message.type === "system" && message.subtype === "commands_changed") {
			if (this.session) this.commands.changed(message.commands);
			return true;
		}
		if (message.type === "rate_limit_event") {
			this.planUsage.rateLimit(message.rate_limit_info);
			return true;
		}
		if (message.type === "result") {
			this.resultArrived(message);
			return true;
		}
		return false;
	}

	private resultArrived(message: Extract<SDKMessage, { type: "result" }>): void {
		// `/rename` and Claude Code's own summary change the title with no event.
		void this.title.refresh(this.sessionId);
		// A transcript append's empty result ends no turn (ADR 0073).
		if (this.quietResults > 0 && message.num_turns === 0) {
			this.quietResults -= 1;
			return;
		}
		const status = this.interrupting
			? "interrupted"
			: message.is_error
				? "error"
				: "done";
		this.finishTurn(status);
		if (this.session) {
			void this.refreshPlanUsage(this.session);
			void this.refreshWindow(this.session, message.modelUsage);
		}
	}

	private sessionStarted(message: Extract<SDKMessage, { subtype: "init" }>): void {
		this.options.log.info(
			{ claudeCode: message.claude_code_version },
			"claude session started",
		);
		this.reportSkipped = message.capabilities?.includes(UNANSWERED_CAPABILITY) ?? false;
		this.commands.initKnown(message.slash_commands, message.terminal_slash_commands);
		if (this.session) void this.refreshCommands(this.session);
		this.settings.mode =
			message.permissionMode === "dontAsk" ? "default" : message.permissionMode;
		this.broadcastSettings();
	}

	private followSession(message: SDKMessage): void {
		const reported = "session_id" in message ? message.session_id : undefined;
		if (reported && reported !== this.sessionId) this.sessionChanged(reported);
	}

	/**
	 * Claude Code moved to a new session, as /clear does. The tab's record
	 * follows it so Resume and a restarted host continue it (SPEC.md §10.8).
	 */
	private sessionChanged(sessionId: string): void {
		this.sessionId = sessionId;
		void writeChatSession(
			this.options.homeDir,
			this.options.terminalId,
			sessionId,
		).catch(() => this.options.log.warn("could not record the new chat session"));
		this.mapper = new ClaudeMessageMapper();
		this.context.figures = null;
		this.title.reset();
		void this.title.refresh(sessionId);
		this.subagents.reset();
		this.sink.conversationReset(this.context.current());
	}

	private modeChanged(mode: PermissionMode): void {
		const shown = mode === "dontAsk" ? "default" : mode;
		if (shown === this.settings.mode) return;
		this.settings.mode = shown;
		this.broadcastSettings();
	}

	private beginTurn(): void {
		this.turnRunning = true;
		this.interrupting = false;
		this.sink.emit({ type: "turn.started", at: Date.now() });
	}

	private finishTurn(status: "done" | "interrupted" | "error"): void {
		this.turnRunning = false;
		this.interrupting = false;
		this.sink.emit({ type: "turn.finished", status, at: Date.now() });
		this.flushAppends();
	}

	private flushAppends(): void {
		for (const message of this.heldAppends.splice(0)) {
			this.quietResults += 1;
			this.input?.push(message);
		}
	}

	/**
	 * The transcript's replay, and the context figures: the ones known now,
	 * else read from the transcript. An unreadable transcript replays nothing.
	 */
	async history(turnRunning: boolean): ReturnType<ChatAgent["history"]> {
		let replay: ReturnType<typeof replayHistory> = { events: [], truncated: false };
		let context = this.context.figures;
		try {
			const messages = await this.sdk.sessionMessages(
				this.sessionId,
				this.options.projectDir,
			);
			replay = replayHistory(messages, turnRunning);
			context ??= fromTranscript(messages, this.context.windowTokens);
		} catch {
			this.options.log.warn("could not read the chat transcript");
		}
		// What is not known yet arrives as its own event once Claude Code answers.
		if (this.session && !this.modelList.current) void this.refreshModels(this.session);
		if (this.session && this.context.windowTokens === null) {
			void this.refreshWindow(this.session, undefined);
		}
		return { ...replay, context: context ?? this.context.current() };
	}

	/** A `!` command still running; its "done" event follows. */
	inProgress(): ChatEventBody[] {
		return this.shell ? [{ type: "shell", ...withoutKind(this.shell) }] : [];
	}

	watchSubagent(socket: Socket, id: string): Promise<void> {
		return this.subagents.watch(socket, id);
	}

	unwatchSubagent(socket: Socket, id: string): void {
		this.subagents.unwatch(socket, id);
	}

	rename(title: string): Promise<ChatRenameResult> {
		return this.title.answerRename(this.sessionId, title);
	}

	revokeRule(rule: string): Promise<void> {
		return this.rules.revoke(rule);
	}

	async interrupt(): Promise<void> {
		this.shellStop?.abort();
		if (this.session && this.turnRunning) {
			this.interrupting = true;
			await this.session.interrupt();
		}
	}

	async send(text: string, attachments: ChatAttachment[]): Promise<void> {
		if (this.shell) throw new Error("Wait for the shell command to finish.");
		if (isShellCommand(text)) return this.runShell(shellCommandText(text), attachments);
		this.sending = true;
		try {
			await this.sendMessage(text, attachments);
		} finally {
			this.sending = false;
		}
	}

	private async sendMessage(text: string, attachments: ChatAttachment[]) {
		const content = await userContent(
			this.options.homeDir,
			this.options.projectDir,
			text,
			attachments,
		);
		if (content.length === 0) return;
		await this.ensureSession();
		const uuid = randomUUID();
		this.input?.push({
			type: "user",
			message: { role: "user", content },
			parent_tool_use_id: null,
			uuid,
		} as SDKUserMessage);
		this.sink.emit({
			type: "message",
			id: uuid,
			role: "user",
			markdown: text,
			...(attachments.length > 0 ? { attachments } : {}),
		});
		if (!this.turnRunning) this.beginTurn();
	}

	/**
	 * Run a `!` command with no model, then add it and its output to the
	 * transcript without starting a turn, so Claude reads both with the next
	 * message (ADR 0073). Neither is logged.
	 */
	private async runShell(
		command: string,
		attachments: ChatAttachment[],
	): Promise<void> {
		const busy = this.turnRunning || this.sending;
		const refused = shellRefusal(command, attachments.length, busy);
		if (refused) throw new Error(refused);
		const id = randomUUID();
		this.shell = runningShell(id, command);
		this.sink.emit({ type: "shell", ...withoutKind(this.shell) });
		let done: ChatShellItem = { ...this.shell, state: "done" };
		this.shellStop = new AbortController();
		try {
			await this.ensureSession();
			const run = await runShellCommand(command, {
				cwd: this.options.projectDir,
				timeoutMs: this.options.shellTimeoutMs,
				signal: this.shellStop.signal,
			});
			this.heldAppends.push(...shellTranscript(id, command, run));
			if (!this.turnRunning) this.flushAppends();
			const { output, exitCode, truncated } = run;
			done = { ...done, output, exitCode, truncated };
		} finally {
			this.shell = null;
			this.shellStop = null;
			this.sink.emit({ type: "shell", ...withoutKind(done) });
		}
	}

	async set(change: ChatSettingsChange): Promise<void> {
		const session = this.session;
		if (change.model !== undefined) {
			await session?.setModel(change.model);
			this.settings.model = change.model;
			// Another model may have another context window.
			if (session) void this.refreshWindow(session, undefined);
		}
		if (change.effort !== undefined) {
			await session?.applyFlagSettings({ effortLevel: change.effort });
			this.settings.effort = change.effort;
		}
		// A model without Auto takes the chat to Ask, as a new chat on it starts.
		const mode =
			change.mode ??
			(change.model !== undefined && this.settings.mode === "auto"
				? chatStartMode(this.modelList.current ?? [], change.model)
				: undefined);
		if (mode !== undefined) {
			await session?.setPermissionMode(mode);
			this.settings.mode = mode;
		}
		this.broadcastSettings();
	}

	private broadcastSettings(): void {
		this.sink.settings({ agent: "claude", ...this.settings });
	}
}
