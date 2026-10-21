/** Content-Length framing for language servers (SPEC.md §13.6). */
import { describe, expect, test } from "vitest";
import {
	encodeMessage,
	FramingError,
	MessageReader,
	responseId,
	type StdioMessage,
} from "./stdio-messages.js";

function reader(max = 1024): {
	got: StdioMessage[];
	push: (data: Buffer | string) => void;
} {
	const got: StdioMessage[] = [];
	const instance = new MessageReader(max, (message) => got.push(message));
	return {
		got,
		push: (data) => instance.push(typeof data === "string" ? Buffer.from(data) : data),
	};
}

describe("encodeMessage", () => {
	test("counts bytes, not characters", () => {
		const framed = encodeMessage('{"a":"é😀"}').toString("utf8");
		expect(framed).toBe('Content-Length: 14\r\n\r\n{"a":"é😀"}');
	});
});

describe("MessageReader", () => {
	test("reads what encodeMessage wrote, whole or one byte at a time", () => {
		const bodies = ['{"id":1}', '{"text":"ünïcode 😀"}', "{}"];
		const stream = Buffer.concat(bodies.map(encodeMessage));

		const whole = reader();
		whole.push(stream);
		expect(whole.got).toEqual(bodies.map((body) => ({ kind: "message", body })));

		const bytewise = reader();
		for (const byte of stream) bytewise.push(Buffer.from([byte]));
		expect(bytewise.got).toEqual(whole.got);
	});

	test("accepts other headers and any case", () => {
		const { got, push } = reader();
		push(
			"content-type: application/vscode-jsonrpc; charset=utf-8\r\ncontent-length: 2\r\n\r\n{}",
		);
		expect(got).toEqual([{ kind: "message", body: "{}" }]);
	});

	test("an oversized response becomes its id, and the next message still arrives", () => {
		const { got, push } = reader(100);
		const big = JSON.stringify({ jsonrpc: "2.0", id: 7, result: "x".repeat(5000) });
		const stream = Buffer.concat([encodeMessage(big), encodeMessage('{"id":8}')]);
		for (let at = 0; at < stream.length; at += 333) push(stream.subarray(at, at + 333));
		expect(got).toEqual([
			{ kind: "oversize", id: 7 },
			{ kind: "message", body: '{"id":8}' },
		]);
	});

	test("an oversized notification has no id", () => {
		const { got, push } = reader(10);
		push(
			encodeMessage(
				JSON.stringify({ jsonrpc: "2.0", method: "x", params: "y".repeat(50) }),
			),
		);
		expect(got).toEqual([{ kind: "oversize", id: null }]);
	});

	test("a stream without Content-Length is refused", () => {
		const { push } = reader();
		expect(() => push("Foo: 1\r\n\r\n{}")).toThrow(FramingError);
	});

	test("a header that never ends is refused rather than buffered", () => {
		const { push } = reader();
		expect(() => push("x".repeat(2000))).toThrow(FramingError);
	});
});

describe("responseId", () => {
	test("finds a number or string id of a result or error", () => {
		expect(responseId('{"jsonrpc":"2.0","id":12,"result":[')).toBe(12);
		expect(responseId('{"jsonrpc":"2.0","id":"a\\"b","error":{')).toBe('a"b');
		expect(responseId('{ "id" : 3 , "result" :')).toBe(3);
	});

	test("never answers for a server request or a notification", () => {
		expect(
			responseId('{"jsonrpc":"2.0","id":4,"method":"workspace/configuration"'),
		).toBeNull();
		expect(responseId('{"jsonrpc":"2.0","method":"x","id":4,')).toBeNull();
		expect(responseId('{"jsonrpc":"2.0","result":{"id":5')).toBeNull();
	});
});
