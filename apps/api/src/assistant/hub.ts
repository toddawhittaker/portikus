import type { WebSocket } from "@fastify/websocket";
import type { AssistantServerEvent, ChatOpenCard } from "@portikus/contracts";
import type { Database } from "@portikus/db";
import type { Kysely } from "kysely";
import { appendEvent, loadEvents, maxSeq, type StoredEvent } from "./store.js";

/**
 * The open sockets of each conversation, and its running turn. Every event
 * goes through one queue per conversation, so it gets the next `seq`, is
 * stored, and reaches every socket in the same order. A socket attaching
 * joins the queue too, so it sees the stored history and then every event
 * after it, with nothing missed or repeated. The API is one process, so
 * memory is the place for this.
 */

type Live = {
	sockets: Set<WebSocket>;
	/** The last seq handed out; null until read from the database. */
	seq: number | null;
	queue: Promise<void>;
	turn: AbortController | null;
	/** The reply streaming now, sent whole to a socket that attaches mid-reply. */
	streaming: { messageId: string; text: string } | null;
};

export type AssistantHub = ReturnType<typeof createAssistantHub>;

/** The cards still waiting for an answer after these events. */
export function openCards(events: readonly StoredEvent[]): ChatOpenCard[] {
	const open = new Map<string, ChatOpenCard>();
	for (const event of events) {
		if (event.type === "permission.requested") {
			const { type: _type, ...card } = event;
			open.set(card.id, { type: "permission", ...card });
		} else if (event.type === "card.resolved") {
			open.delete(event.id);
		}
	}
	return [...open.values()];
}

export function createAssistantHub(db: Kysely<Database>) {
	const live = new Map<string, Live>();

	function stateOf(id: string): Live {
		let state = live.get(id);
		if (!state) {
			state = {
				sockets: new Set(),
				seq: null,
				queue: Promise.resolve(),
				turn: null,
				streaming: null,
			};
			live.set(id, state);
		}
		return state;
	}

	function dropIfIdle(id: string, state: Live, queue: Promise<void>): void {
		if (state.sockets.size === 0 && state.turn === null && state.queue === queue) {
			live.delete(id);
		}
	}

	function enqueue(id: string, work: (state: Live) => Promise<void>): Promise<void> {
		const state = stateOf(id);
		const next = state.queue.then(() => work(state));
		const settled = next.then(
			() => {},
			() => {},
		);
		state.queue = settled;
		void settled.then(() => dropIfIdle(id, state, settled));
		return next;
	}

	function send(socket: WebSocket, event: AssistantServerEvent): void {
		if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
	}

	function framed(id: string, seq: number, event: StoredEvent): AssistantServerEvent {
		return { ...event, sessionId: id, seq } as AssistantServerEvent;
	}

	return {
		/**
		 * Store the event with the next seq and send it to every socket. A
		 * streamed piece of text is sent but not stored: the whole message
		 * that follows it is.
		 */
		emit(id: string, event: StoredEvent): Promise<void> {
			return enqueue(id, async (state) => {
				state.seq ??= await maxSeq(db, id);
				const seq = state.seq + 1;
				if (event.type === "text.delta") {
					state.streaming =
						state.streaming?.messageId === event.messageId
							? { ...state.streaming, text: state.streaming.text + event.text }
							: { messageId: event.messageId, text: event.text };
				} else {
					await appendEvent(db, id, seq, event);
					if (event.type === "message") state.streaming = null;
				}
				state.seq = seq;
				for (const socket of state.sockets) send(socket, framed(id, seq, event));
			});
		},

		/** Send the snapshot and the stored history, then every later event. */
		attach(id: string, socket: WebSocket): Promise<void> {
			return enqueue(id, async (state) => {
				const events = await loadEvents(db, id);
				const last = events.at(-1)?.seq ?? 0;
				state.seq = Math.max(state.seq ?? 0, last);
				send(socket, {
					type: "snapshot",
					sessionId: id,
					// Below every stored seq, so the replay that follows is applied.
					seq: 0,
					cards: openCards(events.map((one) => one.event)),
					turnRunning: state.turn !== null,
					truncated: false,
				});
				for (const one of events) send(socket, framed(id, one.seq, one.event));
				// The streamed text took the latest seq, so it follows the history.
				if (state.streaming && state.streaming.text !== "") {
					send(
						socket,
						framed(id, state.seq, {
							type: "text.delta",
							messageId: state.streaming.messageId,
							text: state.streaming.text,
						}),
					);
				}
				state.sockets.add(socket);
			});
		},

		detach(id: string, socket: WebSocket): void {
			const state = live.get(id);
			if (!state) return;
			state.sockets.delete(socket);
			dropIfIdle(id, state, state.queue);
		},

		/** Start a turn, or null when one is already running. */
		beginTurn(id: string): AbortController | null {
			const state = stateOf(id);
			if (state.turn !== null) return null;
			state.turn = new AbortController();
			return state.turn;
		},

		endTurn(id: string): void {
			const state = live.get(id);
			if (!state) return;
			state.turn = null;
			state.streaming = null;
			dropIfIdle(id, state, state.queue);
		},

		isRunning(id: string): boolean {
			return live.get(id)?.turn != null;
		},

		interrupt(id: string): void {
			live.get(id)?.turn?.abort();
		},

		/** Stop every running turn, for shutdown. */
		abortAll(): void {
			for (const state of live.values()) state.turn?.abort();
		},

		/** Close every socket of a deleted conversation. */
		closeAll(id: string, code: number, reason: string): void {
			const state = live.get(id);
			if (!state) return;
			for (const socket of state.sockets) socket.close(code, reason);
			state.sockets.clear();
			state.turn?.abort();
		},
	};
}
