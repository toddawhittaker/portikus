import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";

/**
 * A JSON-RPC client for one `codex app-server` child over its standard
 * input and output (one JSON message per line). Nothing here logs a
 * message: they hold prompts, replies and code (ADR 0012). The child's
 * error output is discarded for the same reason.
 */

/** The pipes and lifetime of an app-server process; tests pass a stand-in. */
export interface AppServerProcess {
	stdin: Writable;
	stdout: Readable;
	kill(): void;
	/** Called once when the process ends or cannot start. */
	onExit(listener: () => void): void;
}

export type RequestId = number | string;

/** An error answer to a request. */
export class RpcError extends Error {
	constructor(
		readonly code: number,
		message: string,
	) {
		super(message);
	}
}

/** The process has ended, so the request will never be answered. */
export class AppServerGone extends Error {
	constructor() {
		super("Codex stopped.");
	}
}

export interface AppServerHandlers {
	notification(method: string, params: unknown): void;
	/** A request from app-server; the handler answers it with `respond` or `respondError`. */
	request(id: RequestId, method: string, params: unknown): void;
	exit(): void;
}

/** Start `codex app-server` in the project folder, error output discarded. */
export function spawnAppServer(command: string, cwd: string): AppServerProcess {
	const child = spawn(command, ["app-server"], {
		cwd,
		env: process.env,
		stdio: ["pipe", "pipe", "ignore"],
	});
	let exited = false;
	const listeners: (() => void)[] = [];
	const exit = () => {
		if (exited) return;
		exited = true;
		for (const listener of listeners) listener();
	};
	child.on("error", exit);
	child.on("exit", exit);
	return {
		stdin: child.stdin,
		stdout: child.stdout,
		kill: () => child.kill("SIGTERM"),
		onExit: (listener) => listeners.push(listener),
	};
}

export class AppServerClient {
	private nextId = 1;
	private readonly pending = new Map<
		RequestId,
		{ resolve: (result: unknown) => void; reject: (error: Error) => void }
	>();
	private gone = false;

	constructor(
		private readonly process: AppServerProcess,
		private readonly handlers: AppServerHandlers,
	) {
		process.stdin.on("error", () => this.ended());
		process.onExit(() => this.ended());
		const lines = createInterface({ input: process.stdout });
		lines.on("line", (line) => this.receive(line));
	}

	get running(): boolean {
		return !this.gone;
	}

	request(method: string, params: unknown = {}): Promise<unknown> {
		if (this.gone) return Promise.reject(new AppServerGone());
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.write({ id, method, params });
		});
	}

	notify(method: string, params: unknown = {}): void {
		this.write({ method, params });
	}

	respond(id: RequestId, result: unknown): void {
		this.write({ id, result });
	}

	respondError(id: RequestId, code: number, message: string): void {
		this.write({ id, error: { code, message } });
	}

	stop(): void {
		this.process.kill();
		this.ended();
	}

	private write(message: object): void {
		if (this.gone) return;
		this.process.stdin.write(`${JSON.stringify(message)}\n`);
	}

	private receive(line: string): void {
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			return;
		}
		if (typeof message !== "object" || message === null) return;
		const { id, method, params, result, error } = message as Record<string, unknown>;
		const hasId = typeof id === "number" || typeof id === "string";
		if (typeof method === "string") {
			if (hasId) this.handlers.request(id, method, params);
			else this.handlers.notification(method, params);
			return;
		}
		if (!hasId) return;
		const waiting = this.pending.get(id);
		if (!waiting) return;
		this.pending.delete(id);
		if (error !== undefined) {
			const { code, message: text } = (error ?? {}) as Record<string, unknown>;
			waiting.reject(
				new RpcError(
					typeof code === "number" ? code : -1,
					typeof text === "string" ? text : "Codex refused the request.",
				),
			);
		} else {
			waiting.resolve(result);
		}
	}

	private ended(): void {
		if (this.gone) return;
		this.gone = true;
		for (const waiting of this.pending.values()) waiting.reject(new AppServerGone());
		this.pending.clear();
		this.handlers.exit();
	}
}
