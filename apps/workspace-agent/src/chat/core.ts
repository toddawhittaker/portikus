import { chmod, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import {
	ChatClientMessage,
	type ChatClientMessage as ChatClientMessageType,
	type ChatCommand,
	type ChatMcpServer,
	type ChatModeInfo,
	type ChatModelInfo,
	type ChatOpenCard,
	type ChatServerEvent,
	type ChatSessionRule,
	MAX_ATTACHMENTS_PER_TERMINAL,
	MAX_CHAT_CLIENT_FRAME_BYTES,
	MAX_CHAT_SERVER_FRAME_BYTES,
} from "@portikus/contracts";
import type { Logger } from "@portikus/observability";
import type {
	ChatAgent,
	ChatEventBody,
	ChatSettings,
	ChatSink,
	ContextFigures,
} from "./agent.js";
import { OpenCards } from "./open-cards.js";
import { chatSocketPath, privateDirectory, readLines, writeLine } from "./wire.js";

export interface ChatCoreOptions {
	terminalId: string;
	socketDir: string;
	log: Logger;
}

interface Client {
	socket: Socket;
	/**
	 * Live events held, unnumbered, until this client's snapshot and replay
	 * have gone; they are numbered as they are flushed.
	 */
	held: ChatEventBody[] | null;
	/** The subagent this attachment watches last; one watch per attachment. */
	watching: string | null;
}

/**
 * One chat tab's host (SPEC.md §10.2, §10.8), whatever the agent. It runs
 * in tmux session `pk-<id>`, so it outlives a workspace-agent restart, and
 * serves each browser attachment, relayed by the agent, as one connection
 * on a Unix socket only the workspace user can open. The agent's driver
 * does the rest (ADR 0069).
 */
export class ChatCore {
	private readonly clients = new Set<Client>();
	private readonly cards = new OpenCards((event) => this.broadcast(event));
	private server: Server | null = null;
	private seq = 0;
	private turnRunning = false;
	/** The assistant text streamed so far in this turn, for an attach. */
	private partial: { id: string; text: string } | null = null;
	private models: ChatModelInfo[] | null = null;
	private settings: ChatSettings | null = null;
	private commands: ChatCommand[] | null = null;
	private modes: ChatModeInfo[] | null = null;
	private mcp: ChatMcpServer[] | null = null;
	private rules: ChatSessionRule[] = [];

	private readonly sink: ChatSink = {
		emit: (event) => this.relay(event),
		models: (models) => {
			if (same(models, this.models)) return;
			this.models = models;
			this.broadcast({ type: "models", models });
		},
		settings: (settings) => {
			this.settings = settings;
			this.broadcast({ type: "settings", ...settings });
		},
		commands: (commands) => {
			if (same(commands, this.commands)) return;
			this.commands = commands;
			this.broadcast({ type: "commands", commands });
		},
		modes: (modes) => {
			if (same(modes, this.modes)) return;
			this.modes = modes;
			this.broadcast({ type: "modes", modes });
		},
		mcp: (servers) => {
			if (same(servers, this.mcp)) return;
			this.mcp = servers;
			this.broadcast({ type: "mcp", servers });
		},
		context: (figures) => this.broadcast(this.contextEvent(figures)),
		rules: (rules) => {
			this.rules = rules;
			this.broadcast({ type: "rules", rules });
		},
		openCard: (card, settle, signal) => this.cards.open(card, settle, signal),
		conversationReset: (context) => this.conversationReset(context),
	};

	constructor(
		private readonly options: ChatCoreOptions,
		private readonly agent: ChatAgent,
	) {}

	get socketPath(): string {
		return chatSocketPath(this.options.socketDir, this.options.terminalId);
	}

	/** Start the agent, then listen on the socket. */
	async start(): Promise<void> {
		await privateDirectory(this.options.socketDir);
		await unlink(this.socketPath).catch(() => undefined);
		await this.agent.start(this.sink);
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

	/** Stop the agent and close every attachment. The conversation stays. */
	async stop(): Promise<void> {
		await this.agent.stop();
		for (const client of this.clients) client.socket.destroy();
		this.clients.clear();
		await new Promise<void>((resolve) => {
			if (!this.server) return resolve();
			this.server.close(() => resolve());
		});
		await unlink(this.socketPath).catch(() => undefined);
	}

	/** Broadcast one event, keeping the turn's state and streaming reply for late attachers. */
	private relay(event: ChatEventBody): void {
		if (event.type === "turn.started") {
			this.turnRunning = true;
		} else if (event.type === "turn.finished") {
			this.turnRunning = false;
			this.partial = null;
		} else if (event.type === "text.delta") {
			const text = this.partial?.id === event.messageId ? this.partial.text : "";
			this.partial = { id: event.messageId, text: text + event.text };
		} else if (event.type === "message" && this.partial?.id === event.id) {
			this.partial = null;
		}
		this.broadcast(event);
	}

	private conversationReset(context: ContextFigures | null): void {
		this.partial = null;
		this.cards.clearDecisions();
		for (const client of this.clients) {
			// Mid-attach, its replay is of the old conversation; it reattaches.
			if (client.held) {
				client.socket.destroy();
				continue;
			}
			writeLine(
				client.socket,
				JSON.stringify(this.snapshot(this.cards.current, this.turnRunning, false)),
			);
			if (this.settings)
				writeLine(client.socket, this.frame(this.settingsEvent(this.settings)));
			writeLine(client.socket, this.frame({ type: "rules", rules: this.rules }));
			if (context) writeLine(client.socket, this.frame(this.contextEvent(context)));
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
		const client: Client = { socket, held: [], watching: null };
		this.clients.add(client);
		socket.on("close", () => {
			this.clients.delete(client);
			if (client.watching) this.agent.unwatchSubagent(socket, client.watching);
		});
		socket.on("error", () => socket.destroy());
		readLines(socket, MAX_CHAT_CLIENT_FRAME_BYTES, (line) => {
			void this.onLine(client, line);
		});
		this.options.log.info({ attachments: this.clients.size }, "chat attached");

		// The state as of now; anything that changes during the read below
		// arrives as a held event after the replay.
		const partial = this.partial;
		const cards = this.cards.current;
		const turnRunning = this.turnRunning;
		const history = await this.agent.history(turnRunning);
		writeLine(
			socket,
			JSON.stringify(this.snapshot(cards, turnRunning, history.truncated)),
		);
		const replayed = [...history.events, ...this.cards.replayDecisions(history.events)];
		for (const event of replayed) this.write(socket, event);
		this.sendInProgress(socket, partial, history.events);
		const held = client.held ?? [];
		client.held = null;
		for (const event of held) this.write(socket, event);
		const models = this.models;
		if (models && !held.some((event) => event.type === "models")) {
			writeLine(socket, this.frame({ type: "models", models }));
		}
		const modes = this.modes;
		if (modes && !held.some((event) => event.type === "modes")) {
			writeLine(socket, this.frame({ type: "modes", modes }));
		}
		if (this.settings) writeLine(socket, this.frame(this.settingsEvent(this.settings)));
		writeLine(socket, this.frame({ type: "rules", rules: this.rules }));
		const commands = this.commands;
		if (commands) writeLine(socket, this.frame({ type: "commands", commands }));
		const servers = this.mcp;
		if (servers && !held.some((event) => event.type === "mcp")) {
			writeLine(socket, this.frame({ type: "mcp", servers }));
		}
		// A figure that arrived during the read was already sent, held.
		const context = history.context;
		if (context && !held.some((event) => event.type === "context")) {
			writeLine(socket, this.frame(this.contextEvent(context)));
		}
	}

	/**
	 * What the history cannot hold: the reply streaming now, as one delta
	 * that later deltas append to, then what the agent has running that the
	 * history does not already show.
	 */
	private sendInProgress(
		socket: Socket,
		partial: { id: string; text: string } | null,
		history: readonly ChatEventBody[],
	): void {
		if (partial) {
			this.write(socket, {
				type: "text.delta",
				messageId: partial.id,
				text: partial.text,
			});
		}
		const shown = new Set(history.map(keyOf));
		for (const event of this.agent.inProgress()) {
			const key = keyOf(event);
			if (key === null || !shown.has(key)) this.write(socket, event);
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
			await this.onMessage(client, parsed);
		} catch (error) {
			const message = error instanceof Error ? error.message : "That did not work.";
			writeLine(client.socket, this.frame({ type: "error", message }));
		}
	}

	private async onMessage(
		client: Client,
		message: ChatClientMessageType,
	): Promise<void> {
		switch (message.type) {
			case "subagent.watch":
				client.watching = message.toolUseId;
				return this.agent.watchSubagent(client.socket, message.toolUseId);
			case "subagent.unwatch":
				return this.agent.unwatchSubagent(client.socket, message.toolUseId);
			case "rename": {
				// The asker alone hears the answer: a broadcast `error` could be another's.
				const result = await this.agent.rename(message.title);
				return writeLine(client.socket, JSON.stringify(result));
			}
			case "send":
				return this.agent.send(message.text, message.attachments ?? []);
			case "permission.answer":
				return this.cards.answer(message.id, {
					type: "permission",
					optionId: message.optionId,
					message: message.message,
				});
			case "question.answer":
				return this.cards.answer(message.id, {
					type: "question",
					answers: message.answers,
					notes: message.notes,
				});
			case "rule.revoke":
				return this.agent.revokeRule(message.rule);
			case "interrupt":
				return this.agent.interrupt();
			case "set": {
				const { type: _, ...change } = message;
				return this.agent.set(change);
			}
			case "agent.switch":
				throw new Error("Switching agents is not available yet.");
			default:
				return assertHandled(message);
		}
	}

	private snapshot(
		cards: readonly ChatOpenCard[],
		turnRunning: boolean,
		truncated: boolean,
	): Extract<ChatServerEvent, { type: "snapshot" }> {
		return {
			type: "snapshot",
			sessionId: this.options.terminalId,
			seq: this.seq,
			cards: [...cards],
			turnRunning,
			truncated,
		};
	}

	private settingsEvent(settings: ChatSettings): ChatEventBody {
		return { type: "settings", ...settings };
	}

	private contextEvent(context: ContextFigures): ChatEventBody {
		return { type: "context", ...context, now: Date.now() };
	}

	private frame(event: ChatEventBody): string {
		this.seq += 1;
		return JSON.stringify({
			...event,
			sessionId: this.options.terminalId,
			seq: this.seq,
		});
	}

	/** Write one event to one attachment if it fits a frame; the core owns the cap for every driver. */
	private write(socket: Socket, event: ChatEventBody): void {
		const line = this.fitted(event);
		if (line !== null) writeLine(socket, line);
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
	 * frame: it cannot be relayed, and the agent's own record keeps it.
	 * Images over the cap never get here; the driver has made them
	 * `imageOmitted`.
	 */
	private fitted(event: ChatEventBody): string | null {
		const line = this.frame(event);
		return Buffer.byteLength(line, "utf8") <= MAX_CHAT_SERVER_FRAME_BYTES ? line : null;
	}
}

/** Whether a driver's list is the one already held, compared by content. */
function same(list: unknown, held: unknown): boolean {
	return JSON.stringify(list) === JSON.stringify(held);
}

/** Compile-time proof that onMessage handles every client message; a new one fails the build here. */
function assertHandled(_message: never): never {
	throw new Error("That message is not supported.");
}

/** An event's type and id, or null for an event with no id. */
function keyOf(event: ChatEventBody): string | null {
	return "id" in event && typeof event.id === "string"
		? `${event.type}:${event.id}`
		: null;
}
