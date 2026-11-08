import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import {
	getSessionInfo,
	getSessionMessages,
	type PermissionMode,
	type PermissionResult,
	type Query,
	query,
	type SDKMessage,
	type SDKUserMessage,
	type SessionMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
	CHAT_START_EFFORT,
	ChatClientMessage,
	type ChatClientMessage as ChatClientMessageType,
	type ChatEffort,
	type ChatMessage,
	type ChatOpenCard,
	type ChatPermissionMode,
	type ChatQuestion,
	type ChatSessionRule,
	MAX_ATTACHMENTS_PER_TERMINAL,
	MAX_CHAT_CLIENT_FRAME_BYTES,
	MAX_CHAT_SERVER_FRAME_BYTES,
} from "@portikus/contracts";
import type { Logger } from "@portikus/observability";
import { userContent } from "./attachments.js";
import {
	type ChatEventBody,
	type ClaudeLimitWindows,
	ClaudeMessageMapper,
	cardForTool,
	mergeRateLimits,
	PERMISSION_OPTION,
	permissionResult,
	questionResult,
	type ToolAsk,
	UNANSWERED_CAPABILITY,
} from "./claude-adapter.js";
import { splitSuggestions } from "./permission-rules.js";
import { buildSnapshot, replayHistory } from "./snapshot.js";
import { chatSocketPath, readLines, writeLine } from "./wire.js";

/** The shared, unmodified Claude Code binary (SPEC.md §10.1). */
const CLAUDE_PATH = "/opt/portikus/coding-agents/bin/claude";

/**
 * Named explicitly so the composer always shows the effort in force; the
 * SDK reports no effort of its own.
 */

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
	/** Posts plan limits to the loopback receiver (SPEC.md §10.8). */
	postLimits: (windows: ClaudeLimitWindows) => Promise<void>;
	/** For tests only: another Claude Code binary. */
	claudePath?: string;
	/** For tests only: a stand-in for the SDK. */
	sdk?: ChatSdk;
}

/** The three SDK calls the host makes, so tests can stand in for them. */
export interface ChatSdk {
	query: typeof query;
	sessionExists: (id: string, dir: string) => Promise<boolean>;
	sessionMessages: (id: string, dir: string) => Promise<SessionMessage[]>;
}

const realSdk: ChatSdk = {
	query,
	sessionExists: async (id, dir) => (await getSessionInfo(id, { dir })) !== undefined,
	sessionMessages: (id, dir) => getSessionMessages(id, { dir }),
};

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

/** Streaming input for the SDK: messages are pushed as the student sends them. */
class InputQueue implements AsyncIterable<SDKUserMessage> {
	private readonly items: SDKUserMessage[] = [];
	private wake: (() => void) | null = null;

	push(message: SDKUserMessage): void {
		this.items.push(message);
		this.wake?.();
		this.wake = null;
	}

	async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
		for (;;) {
			const next = this.items.shift();
			if (next) {
				yield next;
				continue;
			}
			await new Promise<void>((resolve) => {
				this.wake = resolve;
			});
		}
	}
}

/**
 * One chat tab's host (SPEC.md §10.2, §10.8). It runs the
 * Agent SDK in tmux session `pk-<id>`, so it outlives a workspace-agent
 * restart, and serves each browser attachment, relayed by the agent, as
 * one connection on a Unix socket only the workspace user can open.
 */
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
	private limits: ClaudeLimitWindows = {};
	/** The session's init said a skipped question may be marked so. */
	private reportSkipped = false;
	private settings: { model: string; effort: ChatEffort; mode: ChatPermissionMode } = {
		model: "default",
		effort: CHAT_START_EFFORT,
		mode: "default",
	};

	/** Rules granted with Always allow for this Claude process only. */
	private sessionRules: ChatSessionRule[] = [];
	private rulesQueue: Promise<void> = Promise.resolve();

	constructor(private readonly options: ChatHostOptions) {
		this.sdk = options.sdk ?? realSdk;
	}

	private get sessionId(): string {
		return this.options.sessionId ?? this.options.terminalId;
	}

	get socketPath(): string {
		return chatSocketPath(this.options.socketDir, this.options.terminalId);
	}

	/** Listen on the socket and start Claude. */
	async start(): Promise<void> {
		await privateDirectory(this.options.socketDir);
		await unlink(this.socketPath).catch(() => undefined);
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
		await this.ensureSession();
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
				// `claude --resume <session id>` in a terminal continues this chat.
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
		// A new Claude process starts with none of the old one's session rules.
		if (this.sessionRules.length > 0) {
			this.sessionRules = [];
			this.broadcast(this.rulesEvent());
		}
		void this.pump(session);
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
		if (message.type === "system" && message.subtype === "init") {
			this.options.log.info(
				{ claudeCode: message.claude_code_version },
				"claude session started",
			);
			this.reportSkipped =
				message.capabilities?.includes(UNANSWERED_CAPABILITY) ?? false;
			this.settings.model = message.model || this.settings.model;
			this.settings.mode =
				message.permissionMode === "dontAsk" ? "default" : message.permissionMode;
			this.broadcastSettings();
			return;
		}
		// Always allow can switch the mode mid-turn; the picker shows the mode in force.
		if (message.type === "system" && message.subtype === "status") {
			if (message.permissionMode) this.modeChanged(message.permissionMode);
			return;
		}
		if (message.type === "rate_limit_event") {
			this.limits = mergeRateLimits(this.limits, message.rate_limit_info);
			void this.options.postLimits(this.limits).catch(() => undefined);
			return;
		}
		if (message.type === "result") {
			const status = this.interrupting
				? "interrupted"
				: message.is_error
					? "error"
					: "done";
			this.finishTurn(status);
			return;
		}
		if (message.type === "stream_event" && !this.turnRunning) this.beginTurn();
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
	private async answerPermission(id: string, optionId: string): Promise<void> {
		const open = this.cards.get(id);
		if (open?.card.type !== "permission") return;
		if (!open.card.options.some((option) => option.id === optionId)) return;
		this.cards.delete(id);
		try {
			if (optionId === PERMISSION_OPTION.allowAlways && open.ask.suggestions) {
				await this.grantRules(splitSuggestions(open.ask.suggestions).sessionRules);
			}
		} catch {
			// The student chose to allow, so the tool still runs this once.
			throw new Error(
				"Allowed this once. The Always allow rule could not be saved, so Claude will ask again next time.",
			);
		} finally {
			open.settle(permissionResult(optionId, open.input, open.ask));
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
		try {
			replay = replayHistory(
				await this.sdk.sessionMessages(this.sessionId, this.options.projectDir),
				turnRunning,
			);
		} catch {
			this.options.log.warn("could not read the chat transcript");
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
		const held = client.held ?? [];
		client.held = null;
		for (const event of held) {
			const line = this.fitted(event);
			if (line !== null) writeLine(socket, line);
		}
		writeLine(socket, this.frame(this.settingsEvent()));
		writeLine(socket, this.frame(this.rulesEvent()));
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
				return this.answerPermission(message.id, message.optionId);
			case "rule.revoke":
				return this.revokeRule(message.rule);
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

	private async applySettings(change: {
		model?: string;
		effort?: ChatEffort;
		mode?: ChatPermissionMode;
	}): Promise<void> {
		const session = this.session;
		if (change.model !== undefined) {
			await session?.setModel(change.model);
			this.settings.model = change.model;
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

	private grantRules(rules: ChatSessionRule[]): Promise<void> {
		return this.changeRules((held) => {
			const added = rules.filter(
				(rule) => !held.some((existing) => existing.rule === rule.rule),
			);
			return added.length === 0 ? null : [...held, ...added];
		});
	}

	private revokeRule(rule: string): Promise<void> {
		return this.changeRules((held) =>
			held.some((existing) => existing.rule === rule)
				? held.filter((existing) => existing.rule !== rule)
				: null,
		);
	}

	/**
	 * Socket lines are handled concurrently, so rule changes queue here and
	 * each computes its list from the one before it. The flag settings layer
	 * holds the session rules: each call replaces the whole `permissions`
	 * object and null clears it, so a revoke takes effect at once.
	 */
	private changeRules(
		next: (held: ChatSessionRule[]) => ChatSessionRule[] | null,
	): Promise<void> {
		const step = this.rulesQueue.then(async () => {
			const rules = next(this.sessionRules);
			if (rules === null) return;
			await this.session?.applyFlagSettings({
				permissions:
					rules.length > 0 ? { allow: rules.map((held) => held.rule) } : null,
			});
			this.sessionRules = rules;
			this.broadcast(this.rulesEvent());
		});
		this.rulesQueue = step.catch(() => undefined);
		return step;
	}

	private rulesEvent(): ChatEventBody {
		return { type: "rules", rules: this.sessionRules };
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

/**
 * Make the socket directory, or check the one there: a real directory, the
 * workspace user's own, mode 0700 (SPEC.md §24.1).
 */
async function privateDirectory(dir: string): Promise<void> {
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const info = await lstat(dir);
	if (!info.isDirectory() || info.uid !== process.getuid?.()) {
		throw new Error("the chat socket directory is not the workspace user's own");
	}
	await chmod(dir, 0o700);
}
