/**
 * One JSON-RPC connection to a language server: one LSP message per
 * WebSocket text frame, no envelope (SPEC.md §13.6). It knows nothing of
 * documents; client.ts does.
 */
import { CloseCode } from "@portikus/contracts";

/** What a close code tells the client to do next. */
export type CloseAction =
	/** Another window has the server: wait for "Use here". */
	| "replaced"
	/** Idle: reconnect quietly at the next edit or focus. */
	| "idle"
	| "crashed"
	| "unavailable"
	/** The site switch is off: no socket again, and no status. */
	| "disabled"
	/** The session or project is gone; retrying cannot help. */
	| "refused"
	/** Anything else, such as an agent restart: reconnect with backoff. */
	| "retry";

export function closeAction(code: number): CloseAction {
	switch (code) {
		case CloseCode.LANGUAGE_SERVER_REPLACED:
			return "replaced";
		case CloseCode.LANGUAGE_SERVER_IDLE:
			return "idle";
		case CloseCode.LANGUAGE_SERVER_CRASHED:
			return "crashed";
		case CloseCode.LANGUAGE_SERVER_UNAVAILABLE:
			return "unavailable";
		case CloseCode.LANGUAGE_SERVER_DISABLED:
			return "disabled";
		case CloseCode.SESSION_ENDED:
		case CloseCode.NOT_FOUND:
		case CloseCode.POLICY:
			return "refused";
		default:
			return "retry";
	}
}

/** The backoff of useProjectEvents: 1 s doubling to 15 s, reset by a healthy socket. */
export const FIRST_RETRY_MS = 1000;
export const MAX_RETRY_MS = 15_000;
const HEALTHY_MS = 5_000;

export function nextBackoff(current: number, livedMs: number): number {
	return livedMs < HEALTHY_MS ? Math.min(current * 2, MAX_RETRY_MS) : FIRST_RETRY_MS;
}

interface Message {
	jsonrpc: "2.0";
	id?: number | string | null;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code: number; message: string };
}

export interface ConnectionHandlers {
	onOpen: () => void;
	/** A request from the server; the returned value is the result. */
	onRequest: (method: string, params: unknown) => unknown;
	onNotification: (method: string, params: unknown) => void;
	onClose: (code: number, reason: string) => void;
}

const METHOD_NOT_FOUND = -32601;

export class RpcConnection {
	private socket: WebSocket;
	private nextId = 1;
	private pending = new Map<
		number,
		{ resolve: (value: unknown) => void; reject: (error: Error) => void }
	>();
	private closed = false;

	constructor(url: string, handlers: ConnectionHandlers) {
		this.socket = new WebSocket(url);
		this.socket.onopen = () => handlers.onOpen();
		this.socket.onmessage = (event: MessageEvent) => {
			let message: Message;
			try {
				message = JSON.parse(String(event.data)) as Message;
			} catch {
				return;
			}
			this.receive(message, handlers);
		};
		this.socket.onclose = (event: CloseEvent) => {
			this.closed = true;
			this.failPending();
			handlers.onClose(event.code, event.reason);
		};
		// A failed connection also closes, so onclose alone handles it.
		this.socket.onerror = () => {};
	}

	private receive(message: Message, handlers: ConnectionHandlers): void {
		const isResponse = message.method === undefined && typeof message.id === "number";
		if (isResponse) {
			const waiter = this.pending.get(message.id as number);
			if (!waiter) return;
			this.pending.delete(message.id as number);
			if (message.error) waiter.reject(new Error(message.error.message));
			else waiter.resolve(message.result ?? null);
			return;
		}
		if (message.method === undefined) return;
		if (message.id === undefined || message.id === null) {
			handlers.onNotification(message.method, message.params);
			return;
		}
		let result: unknown;
		try {
			result = handlers.onRequest(message.method, message.params);
		} catch {
			this.send({
				jsonrpc: "2.0",
				id: message.id,
				error: { code: METHOD_NOT_FOUND, message: "Not supported" },
			});
			return;
		}
		this.send({ jsonrpc: "2.0", id: message.id, result: result ?? null });
	}

	private send(message: Message): void {
		if (this.closed || this.socket.readyState !== WebSocket.OPEN) return;
		this.socket.send(JSON.stringify(message));
	}

	request<T>(method: string, params: unknown): Promise<T> {
		if (this.closed || this.socket.readyState !== WebSocket.OPEN) {
			return Promise.reject(new Error("Not connected"));
		}
		const id = this.nextId++;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
			this.send({ jsonrpc: "2.0", id, method, params });
		});
	}

	notify(method: string, params: unknown): void {
		this.send({ jsonrpc: "2.0", method, params });
	}

	close(): void {
		this.closed = true;
		this.failPending();
		this.socket.close();
	}

	private failPending(): void {
		for (const waiter of this.pending.values()) waiter.reject(new Error("Closed"));
		this.pending.clear();
	}
}
