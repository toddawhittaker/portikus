/**
 * Content-Length framing for JSON-RPC over a child's stdio, as language
 * servers speak it (SPEC.md §13.6). Bodies are handed on as text and never
 * read here, except for the request id of one too large to forward.
 */

/** The longest header block accepted; a real one is under 100 bytes. */
const MAX_HEADER_BYTES = 1024;

/** Enough of an oversized body to find its id, which servers write first. */
const ID_PREFIX_BYTES = 256;

const SEPARATOR = Buffer.from("\r\n\r\n");

/** One complete message, or the start of one that was over the limit. */
export type StdioMessage =
	| { kind: "message"; body: string }
	| { kind: "oversize"; id: number | string | null };

/** Frame one JSON-RPC body for a child's stdin. */
export function encodeMessage(body: string): Buffer {
	const bytes = Buffer.from(body, "utf8");
	return Buffer.concat([Buffer.from(`Content-Length: ${bytes.length}\r\n\r\n`), bytes]);
}

/** Thrown when the stream is not Content-Length framing; the stream is unusable after it. */
export class FramingError extends Error {}

/**
 * Splits a byte stream into messages. A body over `maxBodyBytes` is never
 * held in memory: only its first bytes are kept, to find the id.
 */
export class MessageReader {
	private pending: Buffer = Buffer.alloc(0);
	/** Bytes of an oversized body still to skip. */
	private skipping = 0;
	private skippedPrefix: Buffer | null = null;

	constructor(
		private readonly maxBodyBytes: number,
		private readonly onMessage: (message: StdioMessage) => void,
	) {}

	push(chunk: Buffer): void {
		this.pending =
			this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk]);
		for (;;) {
			if (this.skipping > 0) {
				if (!this.skip()) return;
				continue;
			}
			const end = this.pending.indexOf(SEPARATOR);
			if (end === -1) {
				if (this.pending.length > MAX_HEADER_BYTES) {
					throw new FramingError("header too long");
				}
				return;
			}
			const length = contentLength(this.pending.subarray(0, end).toString("ascii"));
			const start = end + SEPARATOR.length;
			if (length > this.maxBodyBytes) {
				this.pending = this.pending.subarray(start);
				this.skipping = length;
				this.skippedPrefix = Buffer.alloc(0);
				continue;
			}
			if (this.pending.length < start + length) return;
			const body = this.pending.subarray(start, start + length).toString("utf8");
			this.pending = this.pending.subarray(start + length);
			this.onMessage({ kind: "message", body });
		}
	}

	/** Consume what is buffered of an oversized body; true once it is all gone. */
	private skip(): boolean {
		const take = Math.min(this.skipping, this.pending.length);
		const prefix = this.skippedPrefix ?? Buffer.alloc(0);
		if (prefix.length < ID_PREFIX_BYTES) {
			this.skippedPrefix = Buffer.concat([
				prefix,
				this.pending.subarray(0, Math.min(take, ID_PREFIX_BYTES - prefix.length)),
			]);
		}
		this.pending = this.pending.subarray(take);
		this.skipping -= take;
		if (this.skipping > 0) return false;
		const id = responseId((this.skippedPrefix ?? Buffer.alloc(0)).toString("utf8"));
		this.skippedPrefix = null;
		this.onMessage({ kind: "oversize", id });
		return true;
	}
}

function contentLength(header: string): number {
	for (const line of header.split("\r\n")) {
		const match = /^content-length:\s*(\d+)\s*$/i.exec(line);
		if (match) return Number(match[1]);
	}
	throw new FramingError("no Content-Length");
}

/**
 * The id of a response from the start of its body, or null for anything
 * else. Both pyright and the TypeScript server write `jsonrpc`, `id`, then
 * `result` or `error`; a server request (`id` then `method`) gets null, so
 * it is dropped rather than answered with an id the browser did not send.
 */
export function responseId(prefix: string): number | string | null {
	const match =
		/^\s*\{(?:\s*"jsonrpc"\s*:\s*"2\.0"\s*,)?\s*"id"\s*:\s*(-?\d+|"(?:[^"\\]|\\.)*")\s*,\s*"(?:result|error)"\s*:/.exec(
			prefix,
		);
	if (!match?.[1]) return null;
	const raw = match[1];
	return raw.startsWith('"') ? (JSON.parse(raw) as string) : Number(raw);
}
