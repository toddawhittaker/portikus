import * as http from "node:http";
import type { ControllerErrorCode } from "@portikus/contracts";
import WebSocket from "ws";

/** Bound for an Incus request whose caller passed no signal (ADR 0034). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export class IncusError extends Error {
	readonly code: ControllerErrorCode;
	constructor(code: ControllerErrorCode, message: string) {
		super(message);
		this.name = "IncusError";
		this.code = code;
	}
}

function failure(message: string): IncusError {
	if (message.includes("no space") || message.includes("not enough")) {
		return new IncusError("STORAGE_FULL", message);
	}
	return new IncusError("OPERATION_FAILED", message);
}

interface IncusEnvelope {
	type: string;
	status: string;
	status_code: number;
	operation?: string;
	metadata?: unknown;
	error?: string;
	error_code?: number;
	/** The response's ETag header, read for the guarded update below. */
	etag?: string;
}

/** The most one message on an exec's control or stdin socket may carry. */
const CONTROL_MAX_PAYLOAD = 4096;

/** The secrets Incus gives for an exec's stdin, stdout, stderr and control sockets. */
interface ExecFds {
	"0": string;
	"1": string;
	"2": string;
	control: string;
}

export interface IncusClientOptions {
	socketPath: string;
	project: string;
}

/**
 * Minimal typed REST client for the Incus unix socket API.
 * Uses node:http with socketPath (ADR 0005: no CLI, no undici).
 */
export class IncusClient {
	private readonly socketPath: string;
	/** The Incus project; the controller also names cgroups with it. */
	readonly project: string;

	constructor(opts: IncusClientOptions) {
		this.socketPath = opts.socketPath;
		this.project = opts.project;
	}

	async request(
		method: string,
		path: string,
		body?: unknown,
		signal?: AbortSignal,
		waitTimeout?: number,
		requestTimeoutMs?: number,
	): Promise<unknown> {
		const envelope = await this.rawRequest(
			method,
			this.withProject(path),
			body,
			signal,
			undefined,
			requestTimeoutMs,
		);

		if (envelope.type === "async" && envelope.operation) {
			return this.waitForOperation(envelope.operation, waitTimeout ?? 60, signal);
		}

		return envelope.metadata;
	}

	/** Read a resource together with its ETag, for `putIfMatch`. */
	async getWithEtag(
		path: string,
		signal?: AbortSignal,
	): Promise<{ metadata: unknown; etag: string }> {
		const envelope = await this.rawRequest(
			"GET",
			this.withProject(path),
			undefined,
			signal,
		);
		if (!envelope.etag) {
			throw new IncusError("OPERATION_FAILED", `Incus sent no ETag for ${path}`);
		}
		return { metadata: envelope.metadata, etag: envelope.etag };
	}

	/**
	 * Replace a resource only if it is unchanged since `getWithEtag`, so a
	 * concurrent edit is refused rather than overwritten (Incus answers 412).
	 */
	async putIfMatch(
		path: string,
		body: unknown,
		etag: string,
		signal?: AbortSignal,
		waitTimeout?: number,
	): Promise<unknown> {
		const envelope = await this.rawRequest(
			"PUT",
			this.withProject(path),
			body,
			signal,
			{
				headers: { "Content-Type": "application/json", "If-Match": etag },
				body: JSON.stringify(body),
			},
		);
		if (envelope.type === "async" && envelope.operation) {
			return this.waitForOperation(envelope.operation, waitTimeout ?? 60, signal);
		}
		return envelope.metadata;
	}

	private withProject(path: string): string {
		const sep = path.includes("?") ? "&" : "?";
		return `${path}${sep}project=${encodeURIComponent(this.project)}`;
	}

	/**
	 * Push a file into an instance through the Incus files API
	 * (ADR 0009). The endpoint answers with a sync envelope, not an
	 * operation, so there is nothing to wait for.
	 */
	async pushFile(
		instance: string,
		filePath: string,
		body: string,
		opts: { uid: number; gid: number; mode: string; type?: "file" | "directory" },
		signal?: AbortSignal,
	): Promise<void> {
		await this.rawRequest(
			"POST",
			this.filesPath(instance, filePath),
			undefined,
			signal,
			{
				headers: {
					"Content-Type": "application/octet-stream",
					"X-Incus-uid": String(opts.uid),
					"X-Incus-gid": String(opts.gid),
					"X-Incus-mode": opts.mode,
					"X-Incus-type": opts.type ?? "file",
					"X-Incus-write": "overwrite",
				},
				body,
			},
		);
	}

	/** Delete a file inside an instance through the Incus files API. */
	async deleteFile(
		instance: string,
		filePath: string,
		signal?: AbortSignal,
	): Promise<void> {
		await this.rawRequest(
			"DELETE",
			this.filesPath(instance, filePath),
			undefined,
			signal,
		);
	}

	/**
	 * Put `body` at `filePath` without opening what is there: a student can
	 * leave a named pipe, and opening one blocks an Incus thread (SPEC.md
	 * §24). Deleting first replaces a pipe, link or file alike; anything that
	 * cannot be deleted, such as a non-empty directory, is refused. Use it
	 * only on a stopped instance: in a running one a student's process could
	 * put a pipe back between the two requests.
	 */
	async replaceFile(
		instance: string,
		filePath: string,
		body: string,
		owner: { uid: number; gid: number; mode: string },
		signal?: AbortSignal,
	): Promise<void> {
		try {
			await this.deleteFile(instance, filePath, signal);
		} catch (err) {
			if (!(err instanceof IncusError && err.code === "NOT_FOUND")) {
				throw new Error(`${filePath} cannot be replaced: ${(err as Error).message}`);
			}
		}
		await this.pushFile(instance, filePath, body, owner, signal);
	}

	/**
	 * There is deliberately no read through the files API: Incus reports a
	 * named pipe as a regular file in HEAD, and a GET on one blocks an Incus
	 * thread for good (SPEC.md §24). Reads go through `exec` instead.
	 */
	private filesPath(instance: string, filePath: string): string {
		return (
			`/1.0/instances/${encodeURIComponent(instance)}/files` +
			`?path=${encodeURIComponent(filePath)}` +
			`&project=${encodeURIComponent(this.project)}`
		);
	}

	/**
	 * Run a command in a running instance and wait for it to end. With
	 * `outputMaxBytes`, stdout comes back over the exec websocket and at most
	 * that much is read; past it, or past the timeout, the command is killed
	 * and the sockets closed. Output is never recorded to a file on the host,
	 * where a student's command could fill the disk (SPEC.md §24). Incus 7.5
	 * refuses to cancel an exec operation, but closing the control socket
	 * kills the command, so a command with sockets never outlives this call.
	 * One without (no `outputMaxBytes`) is only waited for: past the timeout
	 * it is left until it exits or the container stops.
	 */
	async exec(
		instance: string,
		command: string[],
		opts: { timeoutSeconds: number; user?: number; outputMaxBytes?: number },
		signal?: AbortSignal,
	): Promise<{ status: number | null; stdout: Buffer; tooLarge: boolean }> {
		const withOutput = opts.outputMaxBytes !== undefined;
		const envelope = await this.rawRequest(
			"POST",
			this.withProject(`/1.0/instances/${encodeURIComponent(instance)}/exec`),
			{
				command,
				"wait-for-websocket": withOutput,
				"record-output": false,
				interactive: false,
				...(opts.user !== undefined ? { user: opts.user, group: opts.user } : {}),
			},
			signal,
		);
		const operation = envelope.operation;
		if (!operation) {
			// Like `request`, a reply that is not an operation is the result itself.
			if (withOutput) {
				throw new IncusError("OPERATION_FAILED", "Incus answered exec without sockets");
			}
			const ret = (envelope.metadata as { metadata?: { return?: unknown } } | undefined)
				?.metadata?.return;
			return {
				status: typeof ret === "number" ? ret : null,
				stdout: Buffer.alloc(0),
				tooLarge: false,
			};
		}
		let out: { stdout: Buffer; tooLarge: boolean } = {
			stdout: Buffer.alloc(0),
			tooLarge: false,
		};
		if (withOutput) {
			const fds = (envelope.metadata as { metadata?: { fds?: ExecFds } } | undefined)
				?.metadata?.fds;
			if (!fds) throw new IncusError("OPERATION_FAILED", "Incus sent no exec sockets");
			out = await this.readExecOutput(
				operation,
				fds,
				opts.outputMaxBytes ?? 0,
				opts.timeoutSeconds,
			);
			if (out.tooLarge) return { status: null, ...out };
		}
		const result = await this.waitForOperation(operation, opts.timeoutSeconds, signal);
		const ret = (result as { metadata?: { return?: unknown } } | undefined)?.metadata
			?.return;
		return { status: typeof ret === "number" ? ret : null, ...out };
	}

	/**
	 * Connect the exec's sockets (Incus starts the command only once all are
	 * connected), end stdin, and collect stdout until it closes. Over
	 * `maxBytes` on stdout or stderr, or past `timeoutSeconds`, the command is
	 * sent SIGKILL through the control socket; every socket is then closed,
	 * which on its own also makes Incus kill the command.
	 */
	private readExecOutput(
		operation: string,
		fds: ExecFds,
		maxBytes: number,
		timeoutSeconds: number,
	): Promise<{ stdout: Buffer; tooLarge: boolean }> {
		// The cap holds per message too: a larger one fails its socket.
		const open = (secret: string, maxPayload: number): WebSocket =>
			new WebSocket(
				`ws+unix://${this.socketPath}:${operation}/websocket?secret=${encodeURIComponent(secret)}`,
				{ maxPayload },
			);
		const control = open(fds.control, CONTROL_MAX_PAYLOAD);
		const stdin = open(fds["0"], CONTROL_MAX_PAYLOAD);
		const stdout = open(fds["1"], maxBytes + 1);
		const stderr = open(fds["2"], maxBytes + 1);
		const sockets = [control, stdin, stdout, stderr];
		return new Promise((resolve, reject) => {
			const chunks: Buffer[] = [];
			let outBytes = 0;
			let errBytes = 0;
			let settled = false;
			const finish = (
				kill: boolean,
				result?: { stdout: Buffer; tooLarge: boolean },
				error: IncusError = new IncusError("TIMEOUT", "exec timed out"),
			): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				if (kill && control.readyState === WebSocket.OPEN) {
					control.send(JSON.stringify({ command: "signal", signal: 9 }));
				}
				for (const ws of sockets) ws.terminate();
				if (result) resolve(result);
				else reject(error);
			};
			const timer = setTimeout(() => finish(true), timeoutSeconds * 1000);
			const tooLarge = (): void =>
				finish(true, { stdout: Buffer.alloc(0), tooLarge: true });
			for (const ws of sockets) {
				ws.on("error", (err: Error & { code?: string }) => {
					if (err.code === "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH") tooLarge();
					else
						finish(
							true,
							undefined,
							new IncusError("OPERATION_FAILED", `exec socket error: ${err.message}`),
						);
				});
			}
			stdin.on("open", () => stdin.close());
			stdout.on("message", (data: Buffer) => {
				outBytes += data.length;
				if (outBytes > maxBytes) tooLarge();
				else chunks.push(Buffer.from(data));
			});
			stderr.on("message", (data: Buffer) => {
				errBytes += data.length;
				if (errBytes > maxBytes) tooLarge();
			});
			stdout.on("close", () =>
				finish(false, { stdout: Buffer.concat(chunks), tooLarge: false }),
			);
		});
	}

	private rawRequest(
		method: string,
		path: string,
		body?: unknown,
		signal?: AbortSignal,
		raw?: { headers: Record<string, string>; body: string },
		// A caller signal may be long-lived, so the default bound applies with one too.
		timeoutMs: number = DEFAULT_REQUEST_TIMEOUT_MS,
	): Promise<IncusEnvelope> {
		return new Promise<IncusEnvelope>((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new IncusError("TIMEOUT", "request timed out"));
				req.destroy();
			}, timeoutMs);
			const settle = (): void => clearTimeout(timer);
			const payload = raw
				? raw.body
				: body !== undefined
					? JSON.stringify(body)
					: undefined;

			const req = http.request(
				{
					socketPath: this.socketPath,
					method,
					path,
					headers: {
						...(raw ? raw.headers : { "Content-Type": "application/json" }),
						...(payload !== undefined
							? {
									"Content-Length": Buffer.byteLength(payload),
								}
							: {}),
					},
					signal,
				},
				(res) => {
					const chunks: Buffer[] = [];
					res.on("data", (chunk: Buffer) => chunks.push(chunk));
					res.on("end", () => {
						settle();
						try {
							const text = Buffer.concat(chunks).toString();
							const envelope = JSON.parse(text) as IncusEnvelope;
							const err = this.mapEnvelopeError(envelope, res.statusCode ?? 0);
							if (err) {
								reject(err);
							} else {
								const etag = res.headers.etag;
								resolve(etag ? { ...envelope, etag } : envelope);
							}
						} catch (e) {
							reject(
								new IncusError(
									"OPERATION_FAILED",
									`failed to parse Incus response: ${e}`,
								),
							);
						}
					});
				},
			);

			req.on("error", (err: NodeJS.ErrnoException) => {
				settle();
				if (
					err.code === "ECONNREFUSED" ||
					err.code === "ENOENT" ||
					err.code === "ECONNRESET"
				) {
					reject(
						new IncusError(
							"INCUS_UNAVAILABLE",
							`cannot connect to Incus: ${err.message}`,
						),
					);
				} else if (err.name === "AbortError") {
					reject(new IncusError("TIMEOUT", "request timed out"));
				} else {
					reject(new IncusError("OPERATION_FAILED", err.message));
				}
			});

			if (payload !== undefined) {
				req.write(payload);
			}
			req.end();
		});
	}

	private mapEnvelopeError(
		envelope: IncusEnvelope,
		httpStatus: number,
	): IncusError | null {
		if (httpStatus === 404) {
			return new IncusError("NOT_FOUND", envelope.error ?? "not found");
		}
		if (httpStatus === 409) {
			return new IncusError("ALREADY_EXISTS", envelope.error ?? "already exists");
		}
		if (httpStatus >= 400 && envelope.error) {
			return failure(envelope.error);
		}
		return null;
	}

	private async waitForOperation(
		operationUrl: string,
		timeout: number,
		signal?: AbortSignal,
	): Promise<unknown> {
		const waitPath = `${operationUrl}/wait?timeout=${timeout}`;
		// The wait itself is bounded by Incus; the HTTP request gets 5 s more.
		const envelope = await this.rawRequest(
			"GET",
			waitPath,
			undefined,
			signal,
			undefined,
			(timeout + 5) * 1000,
		);

		// The reply itself always says success; the operation's outcome is inside it.
		const op = envelope.metadata as { status_code?: number; err?: string } | undefined;
		const code = op?.status_code ?? 0;
		if (code === 200) {
			return envelope.metadata;
		}
		if (code >= 400) {
			throw failure(op?.err || "operation failed");
		}
		throw new IncusError("TIMEOUT", "operation timed out");
	}

	async ping(signal?: AbortSignal): Promise<boolean> {
		try {
			await this.rawRequest("GET", "/1.0", undefined, signal);
			return true;
		} catch {
			return false;
		}
	}
}
