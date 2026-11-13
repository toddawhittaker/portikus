import type { Socket } from "node:net";
import { ChatSubagentEvent, MAX_CHAT_SERVER_FRAME_BYTES } from "@portikus/contracts";
import type { ChatEventBody } from "../agent.js";
import { writeLine } from "../wire.js";
import { replayTurns, turnStatus } from "./history.js";
import { CodexItemMapper } from "./mapper.js";
import {
	DeltaNotification,
	ItemNotification,
	parsed,
	type Turn,
	TurnNotification,
} from "./protocol.js";

type SubagentEventBody = Extract<ChatEventBody, { type: ChatSubagentEvent["type"] }>;

const SUBAGENT_EVENT_TYPES: readonly string[] = ChatSubagentEvent.options.map(
	(option) => option.shape.type.value,
);

function isSubagentEvent(event: ChatEventBody): event is SubagentEventBody {
	return SUBAGENT_EVENT_TYPES.includes(event.type);
}

/** Most child threads whose live state is kept; the oldest go first. */
const MAX_REMEMBERED = 256;

interface Watch {
	threadId: string;
	seq: number;
	held: SubagentEventBody[] | null;
}

export interface CodexSubagentDeps {
	terminalId: string;
	/** A child thread's recent turns, oldest first. */
	turns: (threadId: string) => Promise<Turn[]>;
}

/**
 * Codex subagents' own conversations for the read-only subagent view
 * (SPEC.md §10.8). A subagent is a child thread; its events arrive on the
 * chat's own app-server stream under the child's thread id, which is also
 * the subagent's id in the chat and in the left pane. A watch replays the
 * child's turns, then follows it live. Held in memory only, never logged.
 */
export class CodexSubagents {
	private readonly mappers = new Map<string, CodexItemMapper>();
	private readonly running = new Set<string>();
	private readonly watches = new Map<Socket, Watch>();

	constructor(private readonly deps: CodexSubagentDeps) {}

	/** An event of a child thread. */
	notification(threadId: string, method: string, params: unknown): void {
		this.send(threadId, this.events(threadId, method, params));
	}

	private events(threadId: string, method: string, params: unknown): ChatEventBody[] {
		const mapper = this.mapperFor(threadId);
		switch (method) {
			case "turn/started":
				this.running.add(threadId);
				return [{ type: "turn.started", at: Date.now() }];
			case "turn/completed": {
				const turn = parsed(TurnNotification, params)?.turn;
				this.running.delete(threadId);
				const status = turnStatus(turn?.status ?? "");
				return [{ type: "turn.finished", status, at: Date.now() }];
			}
			case "item/started":
			case "item/completed": {
				const item = parsed(ItemNotification, params)?.item;
				if (item === undefined) return [];
				return method === "item/started"
					? mapper.started(item)
					: mapper.completed(item);
			}
			case "item/agentMessage/delta": {
				const delta = parsed(DeltaNotification, params);
				return delta ? mapper.delta(delta.itemId, delta.delta) : [];
			}
		}
		return [];
	}

	/** A child thread's item mapper, whose rows an approval the child asks for shows. */
	mapper(threadId: string): CodexItemMapper {
		return this.mapperFor(threadId);
	}

	async watch(socket: Socket, threadId: string): Promise<void> {
		const watch: Watch = { threadId, seq: 0, held: [] };
		this.watches.set(socket, watch);
		const running = this.running.has(threadId);
		let turns: Turn[] = [];
		try {
			turns = await this.deps.turns(threadId);
		} catch {
			// Not a thread Codex knows, or not saved yet: the view shows what arrives live.
		}
		if (this.watches.get(socket) !== watch) return;
		this.write(socket, watch, {
			type: "snapshot",
			cards: [],
			turnRunning: running,
			truncated: false,
		});
		const replay = replayTurns(turns);
		if (running && !replay.some((event) => event.type === "turn.started")) {
			replay.push({ type: "turn.started", at: Date.now() });
		}
		for (const event of replay) {
			if (isSubagentEvent(event)) this.write(socket, watch, event);
		}
		const held = watch.held ?? [];
		watch.held = null;
		for (const event of held) this.write(socket, watch, event);
	}

	unwatch(socket: Socket, threadId: string): void {
		if (this.watches.get(socket)?.threadId === threadId) this.watches.delete(socket);
	}

	/** Codex stopped, or the chat moved to a new conversation: every subagent with it. */
	ended(status: "error" | "interrupted"): void {
		for (const threadId of [...this.running]) {
			this.send(threadId, [{ type: "turn.finished", status, at: Date.now() }]);
		}
		this.running.clear();
		this.mappers.clear();
	}

	private mapperFor(threadId: string): CodexItemMapper {
		let mapper = this.mappers.get(threadId);
		if (!mapper) {
			mapper = new CodexItemMapper();
			this.mappers.set(threadId, mapper);
			if (this.mappers.size > MAX_REMEMBERED) {
				const oldest = this.mappers.keys().next().value;
				if (oldest !== undefined) this.mappers.delete(oldest);
			}
		}
		return mapper;
	}

	private send(threadId: string, events: ChatEventBody[]): void {
		for (const event of events) {
			if (!isSubagentEvent(event)) continue;
			for (const [socket, watch] of this.watches) {
				if (watch.threadId !== threadId) continue;
				if (watch.held) watch.held.push(event);
				else this.write(socket, watch, event);
			}
		}
	}

	private write(socket: Socket, watch: Watch, event: SubagentEventBody): void {
		const seq = watch.seq;
		watch.seq += 1;
		const { terminalId } = this.deps;
		const line = JSON.stringify({
			type: "subagent",
			sessionId: terminalId,
			toolUseId: watch.threadId,
			event: { ...event, sessionId: terminalId, seq },
		});
		if (Buffer.byteLength(line, "utf8") <= MAX_CHAT_SERVER_FRAME_BYTES)
			writeLine(socket, line);
	}
}
