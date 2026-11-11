import { randomUUID } from "node:crypto";
import { chmod, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import type {
	PermissionMode,
	PermissionResult,
	Query,
	SDKMessage,
	SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
	CHAT_START_SETTINGS,
	ChatClientMessage,
	type ChatClientMessage as ChatClientMessageType,
	type ChatCommand,
	type ChatEffort,
	type ChatMessage,
	type ChatModelInfo,
	type ChatOpenCard,
	type ChatPermissionMode,
	type ChatQuestion,
	type ChatShellItem,
	chatStartMode,
	isShellCommand,
	MAX_ATTACHMENTS_PER_TERMINAL,
	MAX_CHAT_CLIENT_FRAME_BYTES,
	MAX_CHAT_SERVER_FRAME_BYTES,
	shellCommandText,
} from "@portikus/contracts";
import type { Logger } from "@portikus/observability";
import { userContent } from "./attachments.js";
import {
	type ChatEventBody,
	type ClaudeLimitWindows,
	ClaudeMessageMapper,
	cardForTool,
	PERMISSION_OPTION,
	type PermissionAnswerExtras,
	permissionResult,
	questionResult,
	type ToolAsk,
	UNANSWERED_CAPABILITY,
} from "./claude-adapter.js";
import {
	type ContextFigures,
	ContextTracker,
	fromTranscript,
	windowFromModelUsage,
} from "./context-usage.js";
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
import { buildSnapshot, replayHistory } from "./snapshot.js";
import { chatSocketPath, privateDirectory, readLines, writeLine } from "./wire.js";

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
	/** For tests only: another Claude Code binary. */
	claudePath?: string;
	/** For tests only: a stand-in for the SDK. */
	sdk?: ChatSdk;
	/** For tests only: the `!` command time limit. */
	shellTimeoutMs?: number;
}

interface OpenCard {
	card: ChatOpenCard;
	input: Record<string, unknown>;
	ask: ToolAsk;
	settle: (result: PermissionResult) => void;
}

interface Client {
	socket: Socket;
	/**
	 * Live events held, unnumbered, until this client's snapshot and replay
	 * have gone; they are numbered as they are flushed.
	 */
	held: ChatEventBody[] | null;
}

/**
 * One chat tab's host (SPEC.md §10.2, §10.8). It runs the
 * Agent SDK in tmux session `pk-<id>`, so it outlives a workspace-agent
 * restart, and serves each browser attachment, relayed by the agent, as
 * one connection on a Unix socket only the workspace user can open.
 */
export type { ChatSdk };

export class ChatHost {
	private readonly clients = new Set<Client>();
	private readonly cards = new Map<string, OpenCard>();
	private readonly sdk: ChatSdk;
	private server: Server | null = null;
	private session: Query | null = null;
	/** A session being started, shared so concurrent sends start only one. */
	private starting: Promise<void> | null = null;
	private input: InputQueue | null = null;
	private mapper = new ClaudeMessageMapper();
	private seq = 0;
	private turnRunning = false;
	private interrupting = false;
	/** The assistant text streamed so far in this turn, for a snapshot. */
	private partial: { id: string; text: string } | null = null;
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
	private readonly commands = new SlashCommandList((commands) =>
		this.broadcast(this.commandsEvent(commands)),
	);
	private context = new ContextTracker();
	/** The session's init said a skipped question may be marked so. */
	private reportSkipped = false;
	private readonly modelList = new ModelList((models) =>
		this.broadcast(this.modelsEvent(models)),
	);
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
		() => this.broadcast(this.rulesEvent()),
	);

	/** The Claude session in force; /clear moves the tab to a new one. */
	private sessionId: string;

	constructor(private readonly options: ChatHostOptions) {
		this.sdk = options.sdk ?? realSdk;
		this.planUsage = new PlanUsage(options.postLimits);
		this.sessionId = options.sessionId ?? options.terminalId;
	}

	get socketPath(): string {
		return chatSocketPath(this.options.socketDir, this.options.terminalId);
	}

	/** Listen on the socket and start Claude. */
	async start(): Promise<void> {
		await privateDirectory(this.options.socketDir);
		await unlink(this.socketPath).catch(() => undefined);
		await this.ensureSession();
		// The socket opens once the model list is read (or has taken too long), so a
		// first attach gets the list ahead of the settings that use it.
		await this.modelList.settled(MODELS_WAIT_MS);
		const server = createServer((socket) => {
			void this.attach(socket);
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(this.socketPath, () => resolve());
		});
		await chmod(this.socketPath, 0o600);
		this.server = server;
		this.options.log.info("chat host listening");
	}

	/** Stop Claude and close every attachment. The transcript stays. */
	async stop(): Promise<void> {
		this.session?.close();
		this.session = null;
		for (const client of this.clients) client.socket.destroy();
		this.clients.clear();
		await new Promise<void>((resolve) => {
			if (!this.server) return resolve();
			this.server.close(() => resolve());
		});
		await unlink(this.socketPath).catch(() => undefined);
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
		const session = this.sdk.query({
			prompt: input,
			options: {
				cwd: projectDir,
				// `claude --resume <session id>` in a terminal continues this chat;
				// after /clear the id is the new session's.
				...(exists ? { resume: sessionId } : { sessionId }),
				pathToClaudeCodeExecutable: this.options.claudePath ?? CLAUDE_PATH,
				includePartialMessages: true,
				effort: this.settings.effort,
				permissionMode: this.settings.mode,
				// The picker offers bypass, so the SDK must allow switching to it.
				allowDangerouslySkipPermissions: true,
				...(this.settings.model === "default" ? {} : { model: this.settings.model }),
				canUseTool: (toolName, toolInput, ask) =>
					this.askCard(toolName, toolInput, ask),
				// Claude Code's own messages may quote the student's work.
				stderr: () => undefined,
			},
		});
		this.session = session;
		this.input = input;
		this.mapper = new ClaudeMessageMapper();
		this.quietResults = 0;
		this.rules.reset();
		void this.pump(session);
		void this.refreshCommands(session);
		void this.refreshPlanUsage(session);
		void this.refreshWindow(session, undefined);
		void this.refreshModels(session);
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

	private modelsEvent(models: ChatModelInfo[]): ChatEventBody {
		return { type: "models", models };
	}

	/** A main-thread request finished: tell every attachment how full the context is. */
	private requestMade(message: SDKMessage): void {
		if (message.type !== "assistant") return;
		const next = this.context.request(message, Date.now());
		if (next) this.broadcast(this.contextEvent(next));
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
		if (next) this.broadcast(this.contextEvent(next));
	}

	private contextEvent(context: ContextFigures): ChatEventBody {
		return { type: "context", ...context, now: Date.now() };
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

	private commandsEvent(commands: ChatCommand[]): ChatEventBody {
		return { type: "commands", commands };
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
		for (const [id, open] of this.cards) {
			open.settle({ behavior: "deny", message: "The session ended." });
			this.cards.delete(id);
			this.broadcast({ type: "card.resolved", id });
		}
		if (this.turnRunning) this.finishTurn("error");
		this.broadcast({
			type: "error",
			message: "Claude Code stopped. Send a message to resume.",
		});
	}

	private handle(message: SDKMessage): void {
		this.followSession(message);
		if (message.type === "system" && message.subtype === "init") {
			this.sessionStarted(message);
			return;
		}
		// Always allow can switch the mode mid-turn; the picker shows the mode in force.
		if (message.type === "system" && message.subtype === "status") {
			if (message.permissionMode) this.modeChanged(message.permissionMode);
			return;
		}
		if (message.type === "system" && message.subtype === "commands_changed") {
			if (this.session) this.commands.changed(message.commands);
			return;
		}
		if (message.type === "rate_limit_event") {
			this.planUsage.rateLimit(message.rate_limit_info);
			return;
		}
		if (message.type === "result") {
			this.resultArrived(message);
			return;
		}
		if (message.type === "stream_event" && !this.turnRunning) this.beginTurn();
		this.requestMade(message);
		for (const event of this.mapper.map(message)) {
			if (event.type === "text.delta") {
				const text = this.partial?.id === event.messageId ? this.partial.text : "";
				this.partial = { id: event.messageId, text: text + event.text };
			} else if (event.type === "message" && this.partial?.id === event.id) {
				this.partial = null;
			}
			this.broadcast(event);
		}
	}

	private resultArrived(message: Extract<SDKMessage, { type: "result" }>): void {
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
	 * follows it so Resume and a restarted host continue it, and every
	 * attachment gets a fresh, empty snapshot (SPEC.md §10.8).
	 */
	private sessionChanged(sessionId: string): void {
		this.sessionId = sessionId;
		void writeChatSession(
			this.options.homeDir,
			this.options.terminalId,
			sessionId,
		).catch(() => this.options.log.warn("could not record the new chat session"));
		this.mapper = new ClaudeMessageMapper();
		this.partial = null;
		this.context.figures = null;
		const context = this.context.current();
		for (const client of this.clients) {
			// Mid-attach, its replay is of the old session; it reattaches.
			if (client.held) {
				client.socket.destroy();
				continue;
			}
			const snapshot = buildSnapshot({
				sessionId: this.options.terminalId,
				seq: this.seq,
				cards: [...this.cards.values()].map((open) => open.card),
				turnRunning: this.turnRunning,
				truncated: false,
			});
			writeLine(client.socket, JSON.stringify(snapshot));
			writeLine(client.socket, this.frame(this.settingsEvent()));
			writeLine(client.socket, this.frame(this.rulesEvent()));
			if (context) writeLine(client.socket, this.frame(this.contextEvent(context)));
		}
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
		this.broadcast({ type: "turn.started", at: Date.now() });
	}

	private finishTurn(status: "done" | "interrupted" | "error"): void {
		this.turnRunning = false;
		this.interrupting = false;
		this.partial = null;
		this.broadcast({ type: "turn.finished", status, at: Date.now() });
		this.flushAppends();
	}

	private flushAppends(): void {
		for (const message of this.heldAppends.splice(0)) {
			this.quietResults += 1;
			this.input?.push(message);
		}
	}

	/**
	 * Raise a card and wait, with no time limit, for the first answer from
	 * any attachment. An aborted call clears the card.
	 */
	private askCard(
		toolName: string,
		input: Record<string, unknown>,
		ask: ToolAsk & { signal: AbortSignal },
	): Promise<PermissionResult> {
		const card = cardForTool(toolName, input, ask);
		return new Promise<PermissionResult>((resolve) => {
			const settle = (result: PermissionResult) => {
				ask.signal.removeEventListener("abort", onAbort);
				resolve(result);
			};
			const onAbort = () => {
				if (!this.cards.delete(card.id)) return;
				this.broadcast({ type: "card.resolved", id: card.id });
				resolve({ behavior: "deny", message: "Cancelled." });
			};
			ask.signal.addEventListener("abort", onAbort);
			this.cards.set(card.id, { card, input, ask, settle });
			this.broadcast(
				card.type === "question"
					? { type: "question.requested", id: card.id, questions: card.questions }
					: { ...card, type: "permission.requested" },
			);
		});
	}

	/** First answer wins; a late or unknown answer is ignored. */
	private answer(
		id: string,
		result: (open: OpenCard) => PermissionResult | null,
	): void {
		const open = this.cards.get(id);
		if (!open) return;
		const decided = result(open);
		if (!decided) return;
		this.cards.delete(id);
		open.settle(decided);
		this.broadcast({ type: "card.resolved", id });
	}

	/**
	 * Like `answer`, but Always allow first grants the session rules, so the
	 * card is claimed before the wait and a second answer cannot also win.
	 */
	private async answerPermission(
		id: string,
		optionId: string,
		extras: PermissionAnswerExtras,
	): Promise<void> {
		const open = this.cards.get(id);
		if (open?.card.type !== "permission") return;
		if (!open.card.options.some((option) => option.id === optionId)) return;
		this.cards.delete(id);
		try {
			if (optionId === PERMISSION_OPTION.allowAlways && open.ask.suggestions) {
				await this.rules.grant(splitSuggestions(open.ask.suggestions).sessionRules);
			}
		} catch {
			// The student chose to allow, so the tool still runs this once.
			throw new Error(
				"Allowed this once. The Always allow rule could not be saved, so Claude will ask again next time.",
			);
		} finally {
			open.settle(permissionResult(optionId, open.input, open.ask, extras));
			this.broadcast({ type: "card.resolved", id });
		}
	}

	private async attach(socket: Socket): Promise<void> {
		if (this.clients.size >= MAX_ATTACHMENTS_PER_TERMINAL) {
			writeLine(
				socket,
				this.frame({ type: "error", message: "Too many open chat views." }),
			);
			socket.end();
			return;
		}
		const client: Client = { socket, held: [] };
		this.clients.add(client);
		socket.on("close", () => this.clients.delete(client));
		socket.on("error", () => socket.destroy());
		readLines(socket, MAX_CHAT_CLIENT_FRAME_BYTES, (line) => {
			void this.onLine(client, line);
		});
		this.options.log.info({ attachments: this.clients.size }, "chat attached");

		// The state as of now; anything that changes during the read below
		// arrives as a held event after the replay.
		const partial = this.partial;
		const cards = [...this.cards.values()].map((open) => open.card);
		const turnRunning = this.turnRunning;
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
		context ??= this.context.current();
		// What is not known yet arrives as its own event once Claude Code answers.
		if (this.session && !this.modelList.current) void this.refreshModels(this.session);
		if (this.session && this.context.windowTokens === null) {
			void this.refreshWindow(this.session, undefined);
		}
		const snapshot = buildSnapshot({
			sessionId: this.options.terminalId,
			seq: this.seq,
			cards,
			turnRunning,
			truncated: replay.truncated,
		});
		writeLine(socket, JSON.stringify(snapshot));
		for (const event of replay.events) writeLine(socket, this.frame(event));
		// The reply streaming now, as one delta that later deltas append to.
		if (partial) {
			writeLine(
				socket,
				this.frame({ type: "text.delta", messageId: partial.id, text: partial.text }),
			);
		}
		// A `!` command still running; its "done" event follows.
		const shell = this.shell;
		if (
			shell &&
			!replay.events.some((event) => event.type === "shell" && event.id === shell.id)
		) {
			writeLine(socket, this.frame({ type: "shell", ...withoutKind(shell) }));
		}
		const held = client.held ?? [];
		client.held = null;
		for (const event of held) {
			const line = this.fitted(event);
			if (line !== null) writeLine(socket, line);
		}
		const models = this.modelList.current;
		if (models && !held.some((event) => event.type === "models")) {
			writeLine(socket, this.frame(this.modelsEvent(models)));
		}
		writeLine(socket, this.frame(this.settingsEvent()));
		writeLine(socket, this.frame(this.rulesEvent()));
		const commands = this.commands.current;
		if (commands) writeLine(socket, this.frame(this.commandsEvent(commands)));
		// A figure that arrived during the read was already sent, held.
		if (context && !held.some((event) => event.type === "context")) {
			writeLine(socket, this.frame(this.contextEvent(context)));
		}
	}

	private async onLine(client: Client, line: string): Promise<void> {
		let parsed: ChatClientMessageType;
		try {
			const result = ChatClientMessage.safeParse(JSON.parse(line));
			if (!result.success) throw new Error("bad frame");
			parsed = result.data;
		} catch {
			client.socket.destroy();
			return;
		}
		try {
			await this.onMessage(parsed);
		} catch (error) {
			const message = error instanceof Error ? error.message : "That did not work.";
			writeLine(client.socket, this.frame({ type: "error", message }));
		}
	}

	private async onMessage(message: ChatClientMessageType): Promise<void> {
		switch (message.type) {
			case "send":
				return this.send(message.text, message.attachments);
			case "permission.answer":
				return this.answerPermission(message.id, message.optionId, {
					message: message.message,
				});
			case "rule.revoke":
				return this.rules.revoke(message.rule);
			case "question.answer":
				return this.answer(message.id, (open) =>
					open.card.type === "question"
						? questionResult(
								open.input,
								open.card.questions as ChatQuestion[],
								message.answers,
								message.notes,
								this.reportSkipped,
							)
						: null,
				);
			case "interrupt":
				this.shellStop?.abort();
				if (this.session && this.turnRunning) {
					this.interrupting = true;
					await this.session.interrupt();
				}
				return;
			case "set":
				await this.applySettings(message);
				return;
		}
	}

	private async send(
		text: string,
		attachments: ChatMessage["attachments"] = [],
	): Promise<void> {
		if (this.shell) throw new Error("Wait for the shell command to finish.");
		if (isShellCommand(text)) return this.runShell(shellCommandText(text), attachments);
		this.sending = true;
		try {
			await this.sendMessage(text, attachments);
		} finally {
			this.sending = false;
		}
	}

	private async sendMessage(
		text: string,
		attachments: ChatMessage["attachments"] = [],
	) {
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
		this.broadcast({
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
		attachments: NonNullable<ChatMessage["attachments"]>,
	): Promise<void> {
		const busy = this.turnRunning || this.sending;
		const refused = shellRefusal(command, attachments.length, busy);
		if (refused) throw new Error(refused);
		const id = randomUUID();
		this.shell = runningShell(id, command);
		this.broadcast({ type: "shell", ...withoutKind(this.shell) });
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
			this.broadcast({ type: "shell", ...withoutKind(done) });
		}
	}

	private async applySettings(change: {
		model?: string;
		effort?: ChatEffort;
		mode?: ChatPermissionMode;
	}): Promise<void> {
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
		if (change.mode !== undefined) {
			await session?.setPermissionMode(change.mode);
			this.settings.mode = change.mode;
		}
		this.broadcastSettings();
	}

	private rulesEvent(): ChatEventBody {
		return { type: "rules", rules: this.rules.held };
	}

	private settingsEvent(): ChatEventBody {
		return { type: "settings", agent: "claude", ...this.settings };
	}

	private broadcastSettings(): void {
		this.broadcast(this.settingsEvent());
	}

	private frame(event: ChatEventBody): string {
		this.seq += 1;
		return JSON.stringify({
			...event,
			sessionId: this.options.terminalId,
			seq: this.seq,
		});
	}

	private broadcast(event: ChatEventBody): void {
		let line: string | null | undefined;
		for (const client of this.clients) {
			if (client.held) {
				client.held.push(event);
				continue;
			}
			if (line === undefined) line = this.fitted(event);
			if (line !== null) writeLine(client.socket, line);
		}
	}

	/**
	 * The event as one numbered frame, or null when it is larger than a
	 * frame: it cannot be relayed, and the transcript keeps it. Images over
	 * the cap never get here; the adapter has made them `imageOmitted`.
	 */
	private fitted(event: ChatEventBody): string | null {
		const line = this.frame(event);
		return Buffer.byteLength(line, "utf8") <= MAX_CHAT_SERVER_FRAME_BYTES ? line : null;
	}
}
