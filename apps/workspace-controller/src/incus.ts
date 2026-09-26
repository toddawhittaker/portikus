import * as http from "node:http";
import type { ControllerErrorCode } from "@portikus/contracts";

/** Bound for an Incus request whose caller passed no signal (EPIC-17 ruling 8). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export class IncusError extends Error {
	readonly code: ControllerErrorCode;
	constructor(code: ControllerErrorCode, message: string) {
		super(message);
		this.name = "IncusError";
		this.code = code;
	}
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
	): Promise<unknown> {
		const envelope = await this.rawRequest(
			method,
			this.withProject(path),
			body,
			signal,
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
		opts: { uid: number; gid: number; mode: string },
		signal?: AbortSignal,
	): Promise<void> {
		const path =
			`/1.0/instances/${encodeURIComponent(instance)}/files` +
			`?path=${encodeURIComponent(filePath)}` +
			`&project=${encodeURIComponent(this.project)}`;

		await this.rawRequest("POST", path, undefined, signal, {
			headers: {
				"Content-Type": "application/octet-stream",
				"X-Incus-uid": String(opts.uid),
				"X-Incus-gid": String(opts.gid),
				"X-Incus-mode": opts.mode,
				"X-Incus-type": "file",
				"X-Incus-write": "overwrite",
			},
			body,
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
			if (
				envelope.error.includes("no space") ||
				envelope.error.includes("not enough")
			) {
				return new IncusError("STORAGE_FULL", envelope.error);
			}
			return new IncusError("OPERATION_FAILED", envelope.error);
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

		if (envelope.status_code === 200) {
			return envelope.metadata;
		}
		if (envelope.status_code === 103) {
			throw new IncusError("TIMEOUT", "operation timed out");
		}
		if (envelope.status_code === 400) {
			const meta = envelope.metadata as Record<string, unknown> | undefined;
			const errMsg = (meta?.err as string) ?? envelope.error ?? "operation failed";
			throw new IncusError("OPERATION_FAILED", errMsg);
		}

		return envelope.metadata;
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
