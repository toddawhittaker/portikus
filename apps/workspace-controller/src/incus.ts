import * as http from "node:http";
import type { ControllerErrorCode } from "@portikus/contracts";

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

	private filesPath(instance: string, filePath: string): string {
		return (
			`/1.0/instances/${encodeURIComponent(instance)}/files` +
			`?path=${encodeURIComponent(filePath)}` +
			`&project=${encodeURIComponent(this.project)}`
		);
	}

	/**
	 * Read a file from an instance through the Incus files API. Incus does not
	 * follow a final symbolic link, so `type` says what the path is. A body
	 * longer than `maxBytes` is cut off and reported as `tooLarge`.
	 */
	readFile(
		instance: string,
		filePath: string,
		maxBytes: number,
		signal?: AbortSignal,
	): Promise<{ type: string; content: Buffer; tooLarge: boolean }> {
		const path =
			`/1.0/instances/${encodeURIComponent(instance)}/files` +
			`?path=${encodeURIComponent(filePath)}` +
			`&project=${encodeURIComponent(this.project)}`;
		return new Promise((resolve, reject) => {
			const timer = signal
				? undefined
				: setTimeout(() => {
						reject(new IncusError("TIMEOUT", "request timed out"));
						req.destroy();
					}, DEFAULT_REQUEST_TIMEOUT_MS);
			const req = http.request(
				{ socketPath: this.socketPath, method: "GET", path, signal },
				(res) => {
					const status = res.statusCode ?? 0;
					const chunks: Buffer[] = [];
					let size = 0;
					let tooLarge = false;
					res.on("data", (chunk: Buffer) => {
						if (tooLarge) return;
						size += chunk.length;
						if (status === 200 && size > maxBytes) {
							tooLarge = true;
							clearTimeout(timer);
							resolve({ type: "file", content: Buffer.alloc(0), tooLarge });
							req.destroy();
							return;
						}
						chunks.push(chunk);
					});
					res.on("end", () => {
						clearTimeout(timer);
						if (tooLarge) return;
						const body = Buffer.concat(chunks);
						if (status !== 200) {
							let envelope: IncusEnvelope | null = null;
							try {
								envelope = JSON.parse(body.toString()) as IncusEnvelope;
							} catch {
								// Not an Incus envelope; fall through with the status alone.
							}
							reject(
								this.mapEnvelopeError(
									envelope ?? ({ error: `HTTP ${status}` } as IncusEnvelope),
									status,
								) ?? new IncusError("OPERATION_FAILED", `HTTP ${status}`),
							);
							return;
						}
						const type = res.headers["x-incus-type"];
						resolve({
							type: typeof type === "string" ? type : "unknown",
							content: body,
							tooLarge: false,
						});
					});
				},
			);
			req.on("error", (err: NodeJS.ErrnoException) => {
				clearTimeout(timer);
				if (err.name === "AbortError") {
					reject(new IncusError("TIMEOUT", "request timed out"));
				} else {
					reject(
						new IncusError("INCUS_UNAVAILABLE", `cannot read file: ${err.message}`),
					);
				}
			});
			req.end();
		});
	}

	private rawRequest(
		method: string,
		path: string,
		body?: unknown,
		signal?: AbortSignal,
		raw?: { headers: Record<string, string>; body: string },
		timeoutMs: number | undefined = signal ? undefined : DEFAULT_REQUEST_TIMEOUT_MS,
	): Promise<IncusEnvelope> {
		return new Promise<IncusEnvelope>((resolve, reject) => {
			const timer =
				timeoutMs === undefined
					? undefined
					: setTimeout(() => {
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
