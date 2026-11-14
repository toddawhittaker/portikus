import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import {
	type ChatAttachment,
	type ChatModelInfo,
	CODEX_DEFAULT_MODE,
	isShellCommand,
	MAX_CHAT_MODELS,
	shellCommandText,
} from "@portikus/contracts";
import type { Logger } from "@portikus/observability";
import type {
	ChatAgent,
	ChatEventBody,
	ChatRenameResult,
	ChatSettingsChange,
	ChatSink,
	ContextFigures,
} from "../agent.js";
import { ChatCore, type ChatCoreOptions } from "../core.js";
import type { Handoff } from "../handoff.js";
import { writeChatSession } from "../session-record.js";
import { shellRefusal } from "../shell-command.js";
import { ChatTitle } from "../titles.js";
import { REPLAY_TURNS } from "../wire.js";
import {
	AppServerClient,
	type AppServerProcess,
	type AppServerClient as Client,
	spawnAppServer,
} from "./app-server.js";
import { codexCommands, slashCommand } from "./commands.js";
import { CodexHandoff, codexTranscript } from "./handoff.js";
import { replayTurns, turnStatus, userShell } from "./history.js";
import { type CodexInput, codexInput } from "./input.js";
import { CodexItemMapper } from "./mapper.js";
import { CodexMcp } from "./mcp.js";
import { CODEX_MODES, DEFAULT_WORKSPACE_SANDBOX, type SandboxPolicy } from "./modes.js";
import {
	DeltaNotification,
	ErrorNotification,
	ItemBase,
	ItemNotification,
	ModelList,
	NameNotification,
	PlanNotification,
	parsed,
	SkillsList,
	TextItem,
	ThreadResult,
	TokenUsageNotification,
	type Turn,
	type TurnError,
	TurnNotification,
	TurnStartResult,
	TurnsList,
} from "./protocol.js";
import { CodexRequests, type PostedState } from "./requests.js";
import {
	type Collaboration,
	changedSettings,
	modelInfos,
	type Settings,
	threadParams,
	turnStartParams,
} from "./settings.js";
import { CodexShell } from "./shell.js";
import { codexSignInUpdate, readCodexSignIn } from "./sign-in.js";
import { CodexSubagents } from "./subagents.js";

export type { PostedState };

/** The shared, unmodified Codex CLI (SPEC.md §10.1). */
const CODEX_COMMAND = "codex";

export const SIGN_IN_MESSAGE =
	"Sign in to Codex in a Codex (TUI) tab, or run codex login --device-auth";
const STOPPED_MESSAGE = "Codex stopped. Send a message to resume.";
const START_FAILED_MESSAGE = "Codex could not start. Send a message to try again.";
const BUSY_MESSAGE = "Wait for Codex to finish, or stop it first.";

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
	swap?: ChatCoreOptions["swap"];
}

/** A chat tab's host running Codex through `codex app-server` (SPEC.md §10.8). */
export class CodexChatHost extends ChatCore {
	constructor(options: CodexHostOptions) {
		super(options, new CodexAgent(options), "codex");
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
	private sink!: ChatSink;
	private client: Client | null = null;
	private starting: Promise<void> | null = null;
	private stopping = false;
	private threadId: string | null = null;
	private threadName: string | null = null;
	private turnId: string | null = null;
	private turnRunning = false;
	/** A send is reading its attachments before its turn starts; a second send steers. */
	private sending: Promise<void> | null = null;
	/** Resolves once the running turn's id is known, for a steer. */
	private turnStart: Promise<void> | null = null;
	/** The turn has shown its error already. */
	private turnErrorShown = false;
	/** The plan a Plan turn ended with, which its card asks about. */
	private plan: { id: string; text: string } | null = null;
	/** Messages that wait for the running turn to end, such as a deny reason after Cancel. */
	private afterTurn: string[] = [];
	/** The collaboration mode last sent; Codex keeps it for later turns. */
	private collaboration: Collaboration = "default";
	private mapper = new CodexItemMapper();
	private readonly subagents: CodexSubagents;
	private readonly requests: CodexRequests;
	private readonly mcp: CodexMcp;
	private readonly shell: CodexShell;
	private readonly title: ChatTitle;
	private models: ChatModelInfo[] = [];
	private settings: Settings = { model: "", effort: "", mode: CODEX_DEFAULT_MODE };
	private workspace: SandboxPolicy = DEFAULT_WORKSPACE_SANDBOX;
	private context: ContextFigures | null = null;
	private readonly handoff = new CodexHandoff(() => ({
		client: this.client,
		threadId: this.threadId,
	}));
	private skills: SkillsList | null = null;
	private recording: Promise<void> = Promise.resolve();
	constructor(private readonly options: CodexHostOptions) {
		this.requests = new CodexRequests({
			sink: () => this.sink,
			mapperOf: (threadId) => this.mapperOf(threadId),
			deliver: (message, steerable) => this.deliver(message, steerable),
			send: (message) => this.send(message, []),
			setMode: (mode) => {
				this.settings.mode = mode;
				this.broadcastSettings();
			},
			postState: (state) => options.postState(state),
		});
		this.mcp = new CodexMcp(
			() => this.sink,
			() => this.threadId,
		);
		this.shell = new CodexShell(() => this.sink);
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
		this.sink = sink;
		this.sink.modes(CODEX_MODES);
		this.publishCommands();
		// The socket opens either way; a send tries again and tells the student why it failed.
		await this.ready().catch(() =>
			this.options.log.warn("codex app-server did not start"),
		);
	}

	async stop(): Promise<void> {
		this.stopping = true;
		const client = this.client;
		// Cleared first, so the exit it causes is not taken for a crash.
		this.client = null;
		client?.stop();
	}

	/** The app-server, started and on its thread; a stopped one is started again. */
	private async ready(): Promise<Client> {
		if (this.stopping) throw new Error(STOPPED_MESSAGE);
		if (!this.client?.running) {
			this.starting ??= this.boot().finally(() => {
				this.starting = null;
			});
			await this.starting.catch(() => {
				throw new Error(START_FAILED_MESSAGE);
			});
		}
		if (!this.client || this.stopping) throw new Error(STOPPED_MESSAGE);
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
				if (client === this.client) this.requests.onRequest(client, id, method, params);
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
		void this.mcp.read(client);
		void this.checkSignIn();
	}

	/** A send never waits on it; an app-server that cannot start gives unknown. */
	async checkSignIn(): Promise<void> {
		const client = await this.ready().catch(() => null);
		this.sink.signIn(client ? await readCodexSignIn(client) : "unknown");
	}

	/** Resume the tab's thread, or start one when it has none Codex can find. */
	private async openThread(client: Client): Promise<void> {
		const common = threadParams(this.options.projectDir, this.settings, this.workspace);
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
		this.handoff.fresh = !result;
		if (!result) {
			result = parsed(ThreadResult, await client.request("thread/start", common));
			if (!result) throw new Error("Codex did not start a conversation.");
			this.options.log.info("codex thread started");
		}
		this.adoptThread(result);
		await this.handoff.inject();
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
		this.models = modelInfos(list);
		if (!this.settings.effort) {
			this.settings.effort =
				this.models.find((row) => row.value === this.settings.model)?.defaultEffort ??
				"medium";
		}
		this.sink.models(this.models);
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

	private onExit(): void {
		this.client = null;
		this.options.log.info("codex app-server ended");
		this.endConversationState("error");
		if (!this.stopping) this.sink.emit({ type: "error", message: STOPPED_MESSAGE });
	}

	/** Close the cards and subagents of a conversation that is over or replaced. */
	private endConversationState(subagents: "error" | "interrupted"): void {
		this.requests.end();
		this.subagents.ended(subagents);
		this.shell.end();
		if (this.turnRunning) this.finishTurn("error", null);
	}

	private onNotification(method: string, params: unknown): void {
		switch (method) {
			case "skills/changed":
				if (this.client) void this.readSkills(this.client, true);
				return;
			case "mcpServer/startupStatus/updated":
				this.mcp.changed(params);
				return;
			case "serverRequest/resolved":
				this.requests.resolved(params);
				return;
			case "account/updated": {
				const state = codexSignInUpdate(params);
				if (state) this.sink.signIn(state);
				return;
			}
		}
		const threadId = (params as { threadId?: unknown } | null)?.threadId;
		if (typeof threadId !== "string") return;
		// A subagent's events share the stream, tagged with its own thread id.
		if (threadId === this.threadId) this.onThreadEvent(method, params);
		else this.subagents.notification(threadId, method, params);
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
				this.turnFailed(error.error);
			}
		}
	}

	private turnStarted(params: unknown): void {
		const turn = parsed(TurnNotification, params)?.turn;
		if (!turn) return;
		if (this.shell.claimsTurn(turn.id, this.turnRunning)) return;
		this.turnId = turn.id;
		if (!this.turnRunning) this.beginTurn();
	}

	private turnCompleted(params: unknown): void {
		const turn = parsed(TurnNotification, params)?.turn;
		if (!turn) return;
		if (this.shell.endsWith(turn.id)) return;
		if (!this.turnRunning) return;
		this.finishTurn(turnStatus(turn.status), turn.error ?? null);
	}

	private itemEvent(method: string, params: unknown): void {
		const item = parsed(ItemNotification, params)?.item;
		const base = parsed(ItemBase, item);
		if (!base) return;
		const shell = userShell(item);
		if (shell) {
			if (method === "item/completed") this.shell.completedItem(shell);
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
		if (error && !this.turnErrorShown) this.turnFailed(error);
		this.sink.emit({ type: "turn.finished", status, at: Date.now() });
		const plan = this.plan;
		this.plan = null;
		if (plan && status === "done") this.requests.askAboutPlan(plan);
		for (const message of this.afterTurn.splice(0)) {
			void this.send(message, []).catch(() => undefined);
		}
	}

	/** Show a turn's error; one that says the student is signed out also shows the warning. */
	private turnFailed(error: TurnError | null | undefined): void {
		if (error?.codexErrorInfo === "unauthorized") this.sink.signIn("signedOut");
		this.sink.emit({ type: "error", message: errorText(error) });
	}

	/** The item mapper of the thread a request is about. */
	private mapperOf(threadId: string): CodexItemMapper {
		return threadId === this.threadId ? this.mapper : this.subagents.mapper(threadId);
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
		// An app-server that stopped is started again, so an attach still shows the conversation.
		await this.ready().catch(() => null);
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
				limit: REPLAY_TURNS,
				sortDirection: "desc",
				itemsView: "full",
			}),
		);
		if (!page) return { turns: [], truncated: false };
		return { turns: [...page.data].reverse(), truncated: Boolean(page.nextCursor) };
	}

	inProgress(): ChatEventBody[] {
		return this.shell.inProgress();
	}

	adoptHandoff(handoff: Handoff): Promise<number> {
		return this.handoff.adopt(handoff, this.context?.windowTokens ?? null);
	}

	async transcript(): Promise<ChatEventBody[]> {
		const client = await this.ready();
		return this.threadId ? codexTranscript(client, this.threadId) : [];
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
		const turnId = this.shell.running
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
		if (this.shell.running) throw new Error("Wait for the shell command to finish.");
		if (isShellCommand(text)) return this.runShell(shellCommandText(text), attachments);
		const command = attachments.length === 0 ? slashCommand(text) : null;
		if (command) return this.runCommand(command.name, command.rest, text);
		if (this.turnRunning) return this.steer(text, attachments);
		while (this.sending) {
			// An earlier send is still starting its turn; this one joins it.
			await this.sending;
			if (this.turnRunning) return this.steer(text, attachments);
		}
		const started = this.startTurn(text, attachments);
		const sending = started.then(
			() => undefined,
			() => undefined,
		);
		this.sending = sending;
		try {
			await started;
		} finally {
			if (this.sending === sending) this.sending = null;
		}
	}

	private input(text: string, attachments: ChatAttachment[]): Promise<CodexInput[]> {
		return codexInput(this.options.homeDir, this.options.projectDir, text, attachments);
	}

	private async startTurn(text: string, attachments: ChatAttachment[]): Promise<void> {
		const input = await this.input(text, attachments);
		if (input.length === 0) return;
		const client = await this.ready();
		this.userMessage(text, attachments);
		this.beginTurn();
		const collaboration = this.settings.mode === "plan" ? "plan" : "default";
		const start = client.request(
			"turn/start",
			turnStartParams(
				this.threadId,
				input,
				this.settings,
				this.workspace,
				collaboration,
				this.collaboration,
			),
		);
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
		const input = await this.input(text, attachments);
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
		if (this.turnRunning || this.sending) {
			throw new Error(
				"A shell command cannot run while Codex is working. Wait, or stop it first.",
			);
		}
		const refused = shellRefusal(command, attachments.length, false);
		if (refused) throw new Error(refused);
		await this.shell.run(await this.ready(), this.threadId, command);
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
				return this.mcp.read(await this.ready());
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
		const result = parsed(
			ThreadResult,
			await client.request(
				"thread/start",
				threadParams(this.options.projectDir, this.settings, this.workspace),
			),
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
		void this.mcp.read(client);
	}

	async set(change: ChatSettingsChange): Promise<void> {
		this.settings = changedSettings(this.settings, change, this.models);
		this.broadcastSettings();
	}

	private broadcastSettings(): void {
		const { model, effort, mode } = this.settings;
		if (!model) return;
		this.sink.settings({ agent: "codex", model, effort: effort || "medium", mode });
	}
}
