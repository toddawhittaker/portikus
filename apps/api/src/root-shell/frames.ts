/**
 * The root-shell helper's socket frames (ADR 0051): a 1-byte type, a 4-byte
 * big-endian body length, then the body. The type numbers match
 * packaging/root-shell/root-shell.
 */

export const FrameType = {
	OPEN: 0x01,
	INPUT: 0x02,
	RESIZE: 0x03,
	END: 0x04,
	OUTPUT: 0x81,
	EXIT: 0x82,
	ERROR: 0x83,
} as const;

const HEADER_BYTES = 5;

/**
 * The largest body the API accepts from the helper, by type. Output far
 * exceeds the helper's read size; the JSON frames are tiny.
 */
const RECEIVE_CAPS: Record<number, number> = {
	[FrameType.OUTPUT]: 1024 * 1024,
	[FrameType.EXIT]: 4096,
	[FrameType.ERROR]: 4096,
};

export interface Frame {
	type: number;
	body: Buffer;
}

export function encodeFrame(type: number, body: Buffer | string): Buffer {
	const bytes = typeof body === "string" ? Buffer.from(body, "utf8") : body;
	const header = Buffer.alloc(HEADER_BYTES);
	header.writeUInt8(type, 0);
	header.writeUInt32BE(bytes.length, 1);
	return Buffer.concat([header, bytes]);
}

export function encodeJsonFrame(type: number, value: unknown): Buffer {
	return encodeFrame(type, JSON.stringify(value));
}

/**
 * Splits the helper's byte stream into frames. Throws on an unknown type or
 * an oversized length, checked before the body is buffered.
 */
export class FrameDecoder {
	private buffered: Buffer = Buffer.alloc(0);

	push(chunk: Buffer): Frame[] {
		this.buffered =
			this.buffered.length === 0 ? chunk : Buffer.concat([this.buffered, chunk]);
		const frames: Frame[] = [];
		while (this.buffered.length >= HEADER_BYTES) {
			const type = this.buffered.readUInt8(0);
			const length = this.buffered.readUInt32BE(1);
			const cap = RECEIVE_CAPS[type];
			if (cap === undefined) throw new Error("unknown frame type");
			if (length > cap) throw new Error("frame too large");
			if (this.buffered.length < HEADER_BYTES + length) break;
			frames.push({
				type,
				body: this.buffered.subarray(HEADER_BYTES, HEADER_BYTES + length),
			});
			this.buffered = this.buffered.subarray(HEADER_BYTES + length);
		}
		return frames;
	}
}
