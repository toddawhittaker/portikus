import type { Socket } from "node:net";
import type {
	ChatAttachment,
	ChatCardDecision,
	ChatClientMessage,
	ChatCommand,
	ChatMcpServer,
	ChatModeInfo,
	ChatModelInfo,
	ChatOpenCard,
	ChatServerEvent,
	ChatSessionRule,
} from "@portikus/contracts";
import type { Handoff } from "./handoff.js";

/**
 * What the chat host core asks of one coding agent's driver, and what a
 * driver may tell the core (SPEC.md §10.8, ADR 0069). The core owns the
 * sockets and everything the browser sees in common; a driver owns only
 * its agent's protocol.
 */

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
	? Omit<T, K>
	: never;

/** An event before the core stamps its session id and sequence number. */
export type ChatEventBody = DistributiveOmit<ChatServerEvent, "sessionId" | "seq">;

type EventOf<T extends ChatEventBody["type"]> = Extract<ChatEventBody, { type: T }>;

export type ChatSettings = Omit<EventOf<"settings">, "type">;
export type ContextFigures = Omit<EventOf<"context">, "type" | "now">;
export type ChatRenameResult = EventOf<"rename.result">;
export type ChatSettingsChange = Omit<
	Extract<ChatClientMessage, { type: "set" }>,
	"type"
>;

/** A browser's answer to an open card, or the card closing unanswered. */
export type CardAnswer =
	| { type: "permission"; optionId: string; message?: string | undefined }
	| {
			type: "question";
			answers: Record<string, string>;
			notes?: Record<string, string> | undefined;
	  }
	| { type: "closed" };

/**
 * What a driver made of an answer. `decision` is remembered and shown on
 * the card; `error` is told to the student who answered, after the card
 * resolves.
 */
export interface CardOutcome {
	decision?: ChatCardDecision;
	error?: string;
}

/**
 * Settles a card with the agent. It returns at once unless it must wait on
 * the agent, so a plain answer resolves the card before the agent moves on.
 */
export type CardSettle = (answer: CardAnswer) => CardOutcome | Promise<CardOutcome>;

export interface ChatAgent {
	/** Start the agent and tell the sink the first settings; the socket opens once this resolves. */
	start(sink: ChatSink): Promise<void>;
	stop(): Promise<void>;
	/**
	 * The conversation so far for an attach, with the context figures it
	 * implies. A driver may also begin reading what it does not know yet.
	 */
	history(turnRunning: boolean): Promise<{
		events: ChatEventBody[];
		truncated: boolean;
		context: ContextFigures | null;
	}>;
	/**
	 * What the history cannot show yet, such as a running `!` command. The
	 * core keeps the reply streaming now itself.
	 */
	inProgress(): ChatEventBody[];
	/** A message, a `!` command, or a steer while working; a thrown error goes to the sender. */
	send(text: string, attachments: ChatAttachment[]): Promise<void>;
	interrupt(): Promise<void>;
	set(change: ChatSettingsChange): Promise<void>;
	revokeRule(rule: string): Promise<void>;
	watchSubagent(socket: Socket, id: string): Promise<void>;
	unwatchSubagent(socket: Socket, id: string): void;
	rename(title: string): Promise<ChatRenameResult>;
	/**
	 * Take in the conversation from before an agent swap (SPEC.md §10.8).
	 * Called after start whenever the tab has swapped, so a restarted host
	 * finds its place again; the agent itself knows whether the handoff has
	 * already reached it. Returns how many of the oldest turns did not fit
	 * its context window.
	 */
	adoptHandoff(handoff: Handoff): Promise<number>;
	/**
	 * This agent's own part of the conversation, past the replay limit, to
	 * hand to the other agent at a swap.
	 */
	transcript(): Promise<ChatEventBody[]>;
}

export interface ChatSink {
	emit(event: ChatEventBody): void;
	models(list: ChatModelInfo[]): void;
	settings(settings: ChatSettings): void;
	commands(list: ChatCommand[]): void;
	/** The permission modes the picker offers; sent on attach before the settings. */
	modes(list: ChatModeInfo[]): void;
	/** Each MCP server's name and status, for the read-only MCP list. */
	mcp(list: ChatMcpServer[]): void;
	context(figures: ContextFigures): void;
	rules(list: ChatSessionRule[]): void;
	/**
	 * Show a card until the first answer. An abort closes it unanswered,
	 * and `settle` hears `closed`.
	 */
	openCard(card: ChatOpenCard, settle: CardSettle, signal?: AbortSignal): void;
	/**
	 * The agent moved to a new conversation, as /clear does: every
	 * attachment gets a fresh, empty snapshot.
	 */
	conversationReset(context: ContextFigures | null): void;
}
