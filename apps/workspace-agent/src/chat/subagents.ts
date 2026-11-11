import type { Socket } from "node:net";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ChatSubagentEvent, MAX_CHAT_SERVER_FRAME_BYTES } from "@portikus/contracts";
import { type ChatEventBody, ClaudeMessageMapper } from "./claude-adapter.js";
import type { ChatSdk } from "./sdk.js";
import { replaySubagent } from "./snapshot.js";
import { writeLine } from "./wire.js";

type SubagentEventBody = Extract<ChatEventBody, { type: ChatSubagentEvent["type"] }>;

const SUBAGENT_EVENT_TYPES = ChatSubagentEvent.options.map(
	(option) => option.shape.type.value,
);

/** Room for the `subagent` wrapper around each event. */
const WRAPPER_BYTES = 512;

/** Most subagents whose ids and live state are remembered; the oldest go first. */
const MAX_REMEMBERED = 256;

/** What a finished task's status means for its turn. */
const FINISHED_STATUS = {
	completed: "done",
	failed: "error",
	stopped: "interrupted",
} as const;

interface Watch {
	toolUseId: string;
	/** The watch's own sequence; the snapshot is 0. */
	seq: number;
	/** Live events held, unnumbered, until the replay has gone. */
	held: SubagentEventBody[] | null;
}

export interface SubagentDeps {
	sdk: ChatSdk;
	projectDir: string;
	terminalId: string;
	/** The Claude session in force; /clear changes it. */
	sessionId: () => string;
}

function isSubagentEvent(event: ChatEventBody): event is SubagentEventBody {
	return (SUBAGENT_EVENT_TYPES as readonly string[]).includes(event.type);
}

function remember<V>(map: Map<string, V>, key: string, value: V): void {
	map.delete(key);
	map.set(key, value);
	while (map.size > MAX_REMEMBERED) {
		const oldest = map.keys().next().value;
		if (oldest === undefined) break;
		map.delete(oldest);
	}
}

/**
 * Subagents' own conversations for the read-only subagent view (SPEC.md
 * §10.8). Claude Code forwards each subagent's messages under its Agent
 * tool call's id; they go only to attachments watching that call, never into
 * the chat's own sequence. A watch starts by replaying the subagent's
 * transcript. Like the rest of the chat, the text is held in memory only and
 * never logged (STACK.md §15).
 */
export class SubagentStreams {
	/** Agent tool call id to the subagent id Claude Code files its transcript under. */
	private readonly agentIds = new Map<string, string>();
	/** Agent tool calls whose subagent is running now. */
	private readonly running = new Map<string, true>();
	private readonly mappers = new Map<string, ClaudeMessageMapper>();
	private readonly watches = new Map<Socket, Watch>();

	constructor(private readonly deps: SubagentDeps) {}

	/** Take a subagent's message; false when it belongs to the main conversation. */
	handle(message: SDKMessage): boolean {
		if (message.type === "system") {
			this.taskEvent(message);
			return false;
		}
		const parent =
			"parent_tool_use_id" in message ? (message.parent_tool_use_id ?? null) : null;
		if (parent === null) return false;
		const agentId = (message as { agent_id?: unknown }).agent_id;
		if (typeof agentId === "string") remember(this.agentIds, parent, agentId);
		let mapper = this.mappers.get(parent);
		if (!mapper) {
			mapper = new ClaudeMessageMapper(parent);
			remember(this.mappers, parent, mapper);
		}
		for (const event of mapper.map(message)) {
			if (isSubagentEvent(event)) this.send(parent, event);
		}
		return true;
	}

	private taskEvent(message: Extract<SDKMessage, { type: "system" }>): void {
		if (message.subtype === "task_started" && message.tool_use_id) {
			remember(this.agentIds, message.tool_use_id, message.task_id);
			remember(this.running, message.tool_use_id, true);
			this.send(message.tool_use_id, { type: "turn.started", at: Date.now() });
		} else if (message.subtype === "task_notification" && message.tool_use_id) {
			this.finish(message.tool_use_id, FINISHED_STATUS[message.status]);
		}
	}

	private finish(toolUseId: string, status: "done" | "error" | "interrupted"): void {
		if (!this.running.delete(toolUseId)) return;
		this.mappers.delete(toolUseId);
		this.send(toolUseId, { type: "turn.finished", status, at: Date.now() });
	}

	/**
	 * Watch one Agent call's subagent: a snapshot, its transcript so far, then
	 * live events. A new watch on the same attachment replaces the last.
	 */
	async watch(socket: Socket, toolUseId: string): Promise<void> {
		const watch: Watch = { toolUseId, seq: 0, held: [] };
		this.watches.set(socket, watch);
		const running = this.running.has(toolUseId);
		let replay: ReturnType<typeof replaySubagent> = {
			events: running ? [{ type: "turn.started", at: Date.now() }] : [],
			truncated: false,
		};
		try {
			const agentId = await this.agentIdOf(toolUseId);
			if (agentId) {
				const { sdk, projectDir } = this.deps;
				const entries = await sdk.subagentMessages(
					this.deps.sessionId(),
					agentId,
					projectDir,
				);
				replay = replaySubagent(
					entries,
					running,
					Date.now(),
					MAX_CHAT_SERVER_FRAME_BYTES - WRAPPER_BYTES,
				);
			}
		} catch {
			// No transcript to read: the view shows what arrives live.
		}
		if (this.watches.get(socket) !== watch) return;
		this.write(socket, watch, {
			type: "snapshot",
			cards: [],
			turnRunning: running,
			truncated: replay.truncated,
		});
		for (const event of replay.events) {
			if (isSubagentEvent(event)) this.write(socket, watch, event);
		}
		const held = watch.held ?? [];
		watch.held = null;
		for (const event of held) this.write(socket, watch, event);
	}

	unwatch(socket: Socket, toolUseId: string): void {
		if (this.watches.get(socket)?.toolUseId === toolUseId) this.watches.delete(socket);
	}

	/** The attachment closed. */
	drop(socket: Socket): void {
		this.watches.delete(socket);
	}

	/** The session moved on (/clear); its subagents are not the new one's. */
	reset(): void {
		this.agentIds.clear();
		this.running.clear();
		this.mappers.clear();
	}

	/** Claude Code stopped, and every subagent with it. */
	ended(): void {
		for (const toolUseId of [...this.running.keys()]) this.finish(toolUseId, "error");
	}

	/**
	 * The subagent id for an Agent call. One not seen live, as after a host
	 * restart, is found from the first entry of each subagent transcript.
	 */
	private async agentIdOf(toolUseId: string): Promise<string | undefined> {
		const known = this.agentIds.get(toolUseId);
		if (known) return known;
		const { sdk, projectDir } = this.deps;
		const sessionId = this.deps.sessionId();
		const seen = new Set(this.agentIds.values());
		for (const agentId of await sdk.subagentIds(sessionId, projectDir)) {
			if (seen.has(agentId)) continue;
			const [first] = await sdk.subagentMessages(sessionId, agentId, projectDir, 1);
			if (first?.parent_tool_use_id) {
				remember(this.agentIds, first.parent_tool_use_id, agentId);
			}
			if (first?.parent_tool_use_id === toolUseId) return agentId;
		}
		return undefined;
	}

	private send(toolUseId: string, event: SubagentEventBody): void {
		for (const [socket, watch] of this.watches) {
			if (watch.toolUseId !== toolUseId) continue;
			if (watch.held) watch.held.push(event);
			else this.write(socket, watch, event);
		}
	}

	private write(socket: Socket, watch: Watch, event: SubagentEventBody): void {
		const seq = watch.seq;
		watch.seq += 1;
		const line = JSON.stringify({
			type: "subagent",
			sessionId: this.deps.terminalId,
			toolUseId: watch.toolUseId,
			event: { ...event, sessionId: this.deps.terminalId, seq },
		});
		if (Buffer.byteLength(line, "utf8") <= MAX_CHAT_SERVER_FRAME_BYTES) {
			writeLine(socket, line);
		}
	}
}
