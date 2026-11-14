import { connect, type Socket } from "node:net";
import type {
	ChatClientMessage,
	ChatOpenCard,
	ChatServerEvent,
} from "@portikus/contracts";
import { expect, vi } from "vitest";
import type { ChatAgent, ChatEventBody, ChatSink, ContextFigures } from "../agent.js";
import type { Handoff } from "../handoff.js";
import { readLines } from "../wire.js";

/** The chat tab every core test runs. */
export const ID = "00000000-0000-4000-8000-000000000001";

/** A driver the tests steer by hand; it records what the core asked of it. */
export class FakeAgent implements ChatAgent {
	sink!: ChatSink;
	calls: unknown[][] = [];
	historyEvents: ChatEventBody[] = [];
	historyContext: ContextFigures | null = null;
	running: ChatEventBody[] = [];
	/** When set, a history read waits for it. */
	gate: Promise<void> | null = null;
	failSend: string | null = null;
	/** When set, a send waits for it, as a turn that is still starting does. */
	sendGate: Promise<void> | null = null;
	/** When set, a transcript read waits for it. */
	transcriptGate: Promise<void> | null = null;
	failAdopt = false;

	async start(sink: ChatSink): Promise<void> {
		this.sink = sink;
		sink.settings({ agent: "claude", model: "default", effort: "high", mode: "auto" });
	}
	async stop(): Promise<void> {
		this.calls.push(["stop"]);
	}
	async history(turnRunning: boolean) {
		this.calls.push(["history", turnRunning]);
		if (this.gate) await this.gate;
		return {
			events: this.historyEvents,
			truncated: false,
			context: this.historyContext,
		};
	}
	inProgress(): ChatEventBody[] {
		return this.running;
	}
	async send(text: string, attachments: unknown[]): Promise<void> {
		this.calls.push(["send", text, attachments]);
		if (this.sendGate) await this.sendGate;
		if (this.failSend) throw new Error(this.failSend);
	}
	async interrupt(): Promise<void> {
		this.calls.push(["interrupt"]);
	}
	async set(change: unknown): Promise<void> {
		this.calls.push(["set", change]);
	}
	async revokeRule(rule: string): Promise<void> {
		this.calls.push(["revokeRule", rule]);
	}
	async watchSubagent(_socket: Socket, id: string): Promise<void> {
		this.calls.push(["watch", id]);
	}
	unwatchSubagent(_socket: Socket, id: string): void {
		this.calls.push(["unwatch", id]);
	}
	async rename(title: string) {
		this.calls.push(["rename", title]);
		return { type: "rename.result" as const, ok: true };
	}
	dropped = 0;
	transcriptEvents: ChatEventBody[] = [];
	async adoptHandoff(handoff: Handoff): Promise<number> {
		this.calls.push(["adopt", handoff]);
		if (this.failAdopt) throw new Error("rejected");
		return this.dropped;
	}
	async transcript(): Promise<ChatEventBody[]> {
		this.calls.push(["transcript"]);
		if (this.transcriptGate) await this.transcriptGate;
		return this.transcriptEvents;
	}
	async checkSignIn(): Promise<void> {
		this.calls.push(["checkSignIn"]);
	}
}

export interface Client {
	socket: Socket;
	events: ChatServerEvent[];
	closed: Promise<void>;
	send: (message: ChatClientMessage) => void;
}

/** Connect to a core's socket as a browser attachment would. */
export async function attach(socketPath: string): Promise<Client> {
	const socket = connect(socketPath);
	const events: ChatServerEvent[] = [];
	readLines(socket, 16 * 1024 * 1024, (line) => events.push(JSON.parse(line)));
	socket.on("error", () => undefined);
	await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
	const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
	return {
		socket,
		events,
		closed,
		send: (message) => socket.write(`${JSON.stringify(message)}\n`),
	};
}

/** Attach and wait until the attach's last fixed frame, the rules, has arrived. */
export async function attached(socketPath: string): Promise<Client> {
	const client = await attach(socketPath);
	await vi.waitFor(() => expect(types(client)).toContain("rules"));
	return client;
}

export function types(client: Client): string[] {
	return client.events.map((event) => event.type);
}

export function permissionCard(id: string): ChatOpenCard {
	return {
		type: "permission",
		id,
		toolName: "Bash",
		input: {},
		title: "Run a command",
		options: [
			{ id: "allow", label: "Allow" },
			{ id: "deny", label: "Deny" },
		],
	} as unknown as ChatOpenCard;
}
