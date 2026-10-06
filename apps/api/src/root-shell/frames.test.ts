import { expect, test } from "vitest";
import { encodeFrame, encodeJsonFrame, FrameDecoder, FrameType } from "./frames.js";

/** The helper socket's framing (ADR 0051): type byte, 4-byte big-endian length, body. */

test("a frame is a type byte, a big-endian length and the body", () => {
	const frame = encodeFrame(FrameType.INPUT, "ls\r");
	expect([...frame]).toEqual([0x02, 0, 0, 0, 3, 0x6c, 0x73, 0x0d]);
	expect(encodeJsonFrame(FrameType.END, { reason: "session_ended" }).toString()).toBe(
		'\u0004\u0000\u0000\u0000\u001a{"reason":"session_ended"}',
	);
});

test("the decoder joins frames split across chunks and splits joined ones", () => {
	const decoder = new FrameDecoder();
	const bytes = Buffer.concat([
		encodeFrame(FrameType.OUTPUT, "hello"),
		encodeJsonFrame(FrameType.EXIT, { status: 0 }),
	]);
	const frames = [];
	for (const byte of bytes) frames.push(...decoder.push(Buffer.from([byte])));
	expect(frames.map((f) => [f.type, f.body.toString()])).toEqual([
		[FrameType.OUTPUT, "hello"],
		[FrameType.EXIT, '{"status":0}'],
	]);
});

test("a frame type the helper never sends is refused", () => {
	const decoder = new FrameDecoder();
	expect(() => decoder.push(encodeFrame(FrameType.INPUT, "x"))).toThrow(
		"unknown frame type",
	);
	expect(() => new FrameDecoder().push(Buffer.from([0x7f, 0, 0, 0, 0]))).toThrow(
		"unknown frame type",
	);
});

test("an oversized length is refused from the header, before the body arrives", () => {
	const header = Buffer.from([FrameType.EXIT, 0, 0, 0x10, 0x01]);
	expect(() => new FrameDecoder().push(header)).toThrow("frame too large");
	const output = Buffer.alloc(5);
	output.writeUInt8(FrameType.OUTPUT, 0);
	output.writeUInt32BE(1024 * 1024 + 1, 1);
	expect(() => new FrameDecoder().push(output)).toThrow("frame too large");
});
