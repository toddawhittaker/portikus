import { randomUUID } from "node:crypto";
import type { WebSocket } from "@fastify/websocket";
import {
	type ChatClientMessage,
	type ChatCommand,
	ChatServerEvent,
	type ChatSubagentEvent,
} from "@portikus/contracts";
import type { FastifyInstance } from "fastify";

/**
 * The scripted host's side conversation (SPEC.md §10.2): `btw` is listed only
 * when a test turns it on, a question is answered after a delay a test sets,
 * and every event is numbered per conversation from a snapshot at seq 0, as
 * the real host numbers them. Stop leaves an interrupted turn, End an empty
 * snapshot, and an attach replays what is there.
 */

/** The command a host lists when its agent can take side questions. */
const BTW: ChatCommand = {
	name: "btw",
	description: "Ask a side question without interrupting the chat",
	argumentHint: "<question>",
	terminalOnly: false,
};

type Body = Record<string, unknown> & { type: ChatSubagentEvent["type"] };

interface SideState {
	/** Whether the host lists `btw`; a test sets it. */
	offered: boolean;
	/** How long the next answers take; a test sets it. */
	delayMs: number;
	events: Record<string, unknown>[];
	seq: number;
	timer: NodeJS.Timeout | null;
	/** What each question was, so a test can read the asks back. */
	asked: string[];
}

interface FakeSideDeps {
	/** The sockets attached to the chat now. */
	socketsOf: (id: string) => Iterable<WebSocket>;
	/** Send the commands event to every attachment. */
	sendCommands: (id: string) => void;
}

export function fakeSide(deps: FakeSideDeps) {
	const states = new Map<string, SideState>();

	function stateOf(id: string): SideState {
		let state = states.get(id);
		if (!state) {
			state = {
				offered: false,
				delayMs: 0,
				events: [],
				seq: 0,
				timer: null,
				asked: [],
			};
			states.set(id, state);
		}
		return state;
	}

	/** One `side` frame, checked against the contract; it carries no chat `seq`. */
	function frame(id: string, event: Record<string, unknown>): string {
		return JSON.stringify(
			ChatServerEvent.parse({ type: "side", sessionId: id, event }),
		);
	}

	function snapshot(id: string, running: boolean): Record<string, unknown> {
		return {
			type: "snapshot",
			sessionId: id,
			seq: 0,
			cards: [],
			turnRunning: running,
			truncated: false,
		};
	}

	function broadcast(id: string, event: Record<string, unknown>): void {
		const line = frame(id, event);
		for (const peer of deps.socketsOf(id)) {
			if (peer.readyState === peer.OPEN) peer.send(line);
		}
	}

	function push(id: string, body: Body): void {
		const state = stateOf(id);
		state.seq += 1;
		const event = { ...body, sessionId: id, seq: state.seq };
		state.events.push(event);
		broadcast(id, event);
	}

	function finish(id: string, status: "done" | "interrupted"): void {
		const state = stateOf(id);
		state.timer = null;
		push(id, { type: "turn.finished", at: Date.now(), status });
	}

	function ask(id: string, text: string): void {
		const state = stateOf(id);
		// As the host does, a question while one runs is refused, and a host
		// without the command does not know the message.
		if (!state.offered || state.timer !== null) return;
		state.asked.push(text);
		if (state.events.length === 0) broadcast(id, snapshot(id, true));
		push(id, { type: "turn.started", at: Date.now() });
		push(id, { type: "message", id: randomUUID(), role: "user", markdown: text });
		state.timer = setTimeout(() => {
			push(id, {
				type: "message",
				id: randomUUID(),
				role: "assistant",
				markdown: `Side answer to: ${text}`,
			});
			finish(id, "done");
		}, state.delayMs);
	}

	function stop(id: string): void {
		const state = stateOf(id);
		if (state.timer === null) return;
		clearTimeout(state.timer);
		finish(id, "interrupted");
	}

	function end(id: string): void {
		const state = stateOf(id);
		if (state.timer) clearTimeout(state.timer);
		state.timer = null;
		const open = state.events.length > 0;
		state.events = [];
		state.seq = 0;
		if (open) broadcast(id, snapshot(id, false));
	}

	return {
		/** The commands the chat lists: its own, with `btw` when the host offers it. */
		commandsFor(id: string, commands: ChatCommand[]): ChatCommand[] {
			return stateOf(id).offered ? [...commands, BTW] : commands;
		},

		/** Handle a side message from the browser; false for any other message. */
		handle(id: string, message: ChatClientMessage): boolean {
			switch (message.type) {
				case "side.ask":
					ask(id, message.text);
					return true;
				case "side.stop":
					stop(id);
					return true;
				case "side.end":
					end(id);
					return true;
				default:
					return false;
			}
		},

		/** The conversation so far, for one attachment: a snapshot, then every event. */
		replay(id: string): string[] {
			const state = stateOf(id);
			if (state.events.length === 0) return [];
			return [snapshot(id, state.timer !== null), ...state.events].map((event) =>
				frame(id, event),
			);
		},

		/** Forget the conversation, as /clear and an agent swap do. */
		clear: end,

		routes(app: FastifyInstance): void {
			// Offer `btw` or not (body: offered, delayMs for the answer's delay).
			app.post("/__test/chats/:id/side", async (request, reply) => {
				const id = (request.params as { id: string }).id;
				const body = request.body as { offered?: boolean; delayMs?: number };
				const state = stateOf(id);
				if (body.delayMs !== undefined) state.delayMs = body.delayMs;
				if (body.offered !== undefined) {
					state.offered = body.offered;
					deps.sendCommands(id);
				}
				return reply.status(204).send();
			});

			// The side questions the host took, in order.
			app.get("/__test/chats/:id/side", async (request) => {
				const id = (request.params as { id: string }).id;
				return { asked: stateOf(id).asked };
			});
		},
	};
}
