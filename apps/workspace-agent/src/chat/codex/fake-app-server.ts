import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import type { AppServerProcess } from "./app-server.js";

/**
 * A stand-in `codex app-server` for tests, fed from the recorded fixtures
 * in test-fixtures/ (Codex 0.167.1). Requests with a handler are answered
 * at once; the server's own notifications and requests are pushed by the
 * test, a fixture's turn at a time, so a card can be answered mid-turn.
 */

export interface Recorded {
	dir: "client" | "server";
	msg: Record<string, unknown>;
}

export function fixture(name: string): Recorded[] {
	const text = readFileSync(
		new URL(`./test-fixtures/${name}.jsonl`, import.meta.url),
		"utf8",
	);
	return text
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => JSON.parse(line) as Recorded);
}

/** The server's answer to the n-th client request of this method in a fixture. */
export function recordedResult(name: string, method: string, nth = 0): unknown {
	const lines = fixture(name);
	const requests = lines.filter(
		(line) => line.dir === "client" && line.msg.method === method,
	);
	const id = requests[nth]?.msg.id;
	return lines.find(
		(line) => line.dir === "server" && line.msg.id === id && !line.msg.method,
	)?.msg.result;
}

/**
 * The server's notifications and requests after the n-th client request of
 * this method, up to the next client request, with the recorded thread id
 * changed to the test's own.
 */
export function segment(
	name: string,
	method: string,
	nth: number,
	thread: { from: string; to: string },
): Record<string, unknown>[] {
	const lines = fixture(name);
	let seen = -1;
	let inside = false;
	const out: Record<string, unknown>[] = [];
	for (const line of lines) {
		if (
			line.dir === "client" &&
			line.msg.method !== undefined &&
			line.msg.id !== undefined
		) {
			if (inside) break;
			if (line.msg.method === method) seen += 1;
			inside = seen === nth;
			continue;
		}
		if (!inside || line.dir !== "server" || typeof line.msg.method !== "string")
			continue;
		out.push(JSON.parse(JSON.stringify(line.msg).replaceAll(thread.from, thread.to)));
	}
	return out;
}

export interface SentMessage {
	id?: number | string;
	method?: string;
	params?: Record<string, unknown>;
	result?: unknown;
	error?: unknown;
}

type Handler = (params: Record<string, unknown>) => unknown;

/** A handler that answers with a JSON-RPC error. */
export class Refuse {
	constructor(readonly message: string) {}
}

export class FakeAppServer implements AppServerProcess {
	readonly stdin = new PassThrough();
	readonly stdout = new PassThrough();
	readonly sent: SentMessage[] = [];
	private readonly exitListeners: (() => void)[] = [];
	private exited = false;

	constructor(readonly handlers: Record<string, Handler>) {
		createInterface({ input: this.stdin }).on("line", (line) => {
			const message = JSON.parse(line) as SentMessage;
			this.sent.push(message);
			if (message.method === undefined || message.id === undefined) return;
			const handler = this.handlers[message.method];
			if (!handler) return;
			const result = handler(message.params ?? {});
			this.push(
				result instanceof Refuse
					? { id: message.id, error: { code: -32000, message: result.message } }
					: { id: message.id, result },
			);
		});
	}

	push(message: Record<string, unknown>): void {
		this.stdout.write(`${JSON.stringify(message)}\n`);
	}

	/** The requests the client sent with this method. */
	requests(method: string): SentMessage[] {
		return this.sent.filter(
			(message) => message.method === method && message.id !== undefined,
		);
	}

	/** The client's reply to a server request. */
	reply(id: number | string): SentMessage | undefined {
		return this.sent.find(
			(message) => message.id === id && message.method === undefined,
		);
	}

	kill(): void {
		this.exit();
	}

	exit(): void {
		if (this.exited) return;
		this.exited = true;
		for (const listener of this.exitListeners) listener();
	}

	onExit(listener: () => void): void {
		this.exitListeners.push(listener);
	}
}
