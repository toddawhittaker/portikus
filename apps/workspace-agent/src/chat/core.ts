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
	CODING_AGENT_LABEL,
	type CodingAgent,
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
import { lastTurns, newHandoffId, turnsFromEvents } from "./handoff.js";
import { OpenCards } from "./open-cards.js";
import {
	type ChatSwapState,
	readChatSession,
	writePendingSwitch,
	writeSwapState,
} from "./session-record.js";
import { chatSocketPath, privateDirectory, readLines, writeLine } from "./wire.js";

export interface ChatCoreOptions {
	terminalId: string;
	socketDir: string;
	homeDir: string;
	log: Logger;
	/**
	 * The tab's state across agent swaps, as `takeSwapState` read it, and
	 * whether this start is a swap (SPEC.md §10.8).
	 */
	swap?: { state: ChatSwapState | null; switched: boolean };
}

/** Why a chat cannot swap agents now; one sentence the student can act on. */
export const SWITCH_BUSY_MESSAGE =
	"Wait for the reply to finish before switching agents.";

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
	/** The tab's swaps so far; null until the first. */
	private swap: ChatSwapState | null;
	/** A swap is prepared, and the host waits to be replaced. */
	private switching = false;

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
		private readonly agentName: CodingAgent,
	) {
		this.swap = options.swap?.state ?? null;
	}

	get socketPath(): string {
		return chatSocketPath(this.options.socketDir, this.options.terminalId);
	}

	/** Start the agent, then listen on the socket. */
	async start(): Promise<void> {
		await privateDirectory(this.options.socketDir);
		await unlink(this.socketPath).catch(() => undefined);
		await this.agent.start(this.sink);
		await this.adoptHandoff();
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
		await this.closeListener();
	}

	/**
	 * Stop listening and remove the socket, once: a host replaced by a swap
	 * must not remove its successor's. Open attachments stay until they end.
	 */
	private closeListener(): Promise<void> {
		const server = this.server;
		if (!server) return Promise.resolve();
		this.server = null;
		const closed = new Promise<void>((resolve) => server.close(() => resolve()));
		const removed = unlink(this.socketPath).catch(() => undefined);
		return Promise.all([closed, removed]).then(() => undefined);
	}

	/**
	 * After a swap, hand the agent the conversation it missed and mark the
	 * place with a divider; after a later restart, let it find its place.
	 * The handoff's content is never logged (ADR 0012).
	 */
	private async adoptHandoff(): Promise<void> {
		const state = this.swap;
		if (!state) return;
		const switched = this.options.swap?.switched === true;
		const handoff = switched
			? { id: newHandoffId(), from: this.previousAgent(), droppedTurns: 0 }
			: state.handoff;
		if (!handoff) return;
		let dropped = 0;
		try {
			dropped = await this.agent.adoptHandoff({
				id: handoff.id,
				from: handoff.from,
				log: state.log,
			});
		} catch {
			this.options.log.warn("could not hand the conversation over");
		}
		if (!switched) return;
		const divider: ChatEventBody = {
			type: "handoff",
			from: handoff.from,
			to: this.agentName,
			droppedTurns: dropped,
		};
		this.swap = {
			...state,
			earlier: [...state.earlier, divider],
			handoff: { ...handoff, droppedTurns: dropped },
		};
		await this.saveSwap();
		this.options.log.info({ droppedTurns: dropped }, "chat agent swapped in");
		this.broadcast(divider);
	}

	private previousAgent(): CodingAgent {
		return (
			this.swap?.log.at(-1)?.agent ?? (this.agentName === "claude" ? "codex" : "claude")
		);
	}

	private async saveSwap(): Promise<void> {
		await writeSwapState(
			this.options.homeDir,
			this.options.terminalId,
			this.swap,
		).catch(() => this.options.log.warn("could not record the chat's agent swap"));
	}

	/**
	 * Prepare a swap to the other agent (SPEC.md §10.8): record what the
	 * chat shows so far and this agent's part of the conversation for the
	 * next host, then stop listening. Closing the asker's connection says it
	 * is done; the workspace agent then puts the other agent's host here.
	 */
	private async prepareSwitch(client: Client, to: CodingAgent): Promise<void> {
		if (to === this.agentName) {
			throw new Error(`This chat already uses ${CODING_AGENT_LABEL[to]}.`);
		}
		if (
			this.switching ||
			this.turnRunning ||
			this.cards.current.length > 0 ||
			this.agent.inProgress().length > 0
		) {
			throw new Error(SWITCH_BUSY_MESSAGE);
		}
		this.switching = true;
		try {
			const [own, shown, session] = await Promise.all([
				this.agent.transcript(),
				this.agent.history(false),
				readChatSession(this.options.homeDir, this.options.terminalId),
			]);
			const state = this.swap;
			const earlier = lastTurns([...(state?.earlier ?? []), ...shown.events]);
			await writePendingSwitch(this.options.homeDir, this.options.terminalId, to, {
				sessions: {
					...state?.sessions,
					...(session ? { [this.agentName]: session } : {}),
				},
				earlier: earlier.events,
				truncated: (state?.truncated ?? false) || shown.truncated || earlier.truncated,
				log: [
					...(state?.log ?? []),
					{ agent: this.agentName, turns: turnsFromEvents(own) },
				],
				handoff: null,
			});
		} catch (error) {
			this.switching = false;
			throw error;
		}
		this.options.log.info({ to }, "chat agent swap prepared");
		void this.closeListener();
		client.socket.end();
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
		// A new conversation starts with nothing from before a swap.
		if (this.swap) {
			this.swap = null;
			void this.saveSwap();
		}
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
		const history = this.withEarlier(await this.agent.history(turnRunning));
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

	/** The agent's history after what the chat showed before its swaps, kept to the replay limit. */
	private withEarlier<T extends { events: ChatEventBody[]; truncated: boolean }>(
		history: T,
	): T {
		if (!this.swap) return history;
		const kept = lastTurns([...this.swap.earlier, ...history.events]);
		return {
			...history,
			events: kept.events,
			truncated: this.swap.truncated || history.truncated || kept.truncated,
		};
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
		if (this.switching) throw new Error("This chat is switching agents.");
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
				return this.prepareSwitch(client, message.agent);
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
