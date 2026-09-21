import { expect, test } from "vitest";
import { decodeCheckFrame } from "./checkFrames.js";

test("output frames come back as the bytes the command wrote", () => {
	const data = Buffer.from("héllo\r\n", "utf8").toString("base64");
	const frame = decodeCheckFrame(JSON.stringify({ type: "output", data }));
	expect(frame.kind).toBe("output");
	if (frame.kind !== "output") throw new Error("wrong kind");
	expect(new TextDecoder().decode(frame.bytes)).toBe("héllo\r\n");
});

test("an exit frame carries its exit code", () => {
	expect(decodeCheckFrame(JSON.stringify({ type: "exit", exitCode: 2 }))).toEqual({
		kind: "exit",
		exitCode: 2,
	});
});

test("an error frame carries its code, and an unnamed one says so", () => {
	expect(decodeCheckFrame(JSON.stringify({ type: "error", code: "NOPE" }))).toEqual({
		kind: "error",
		code: "NOPE",
	});
	expect(decodeCheckFrame(JSON.stringify({ type: "error" }))).toEqual({
		kind: "error",
		code: "unknown",
	});
});

test("anything unreadable is ignored rather than thrown", () => {
	expect(decodeCheckFrame("not json").kind).toBe("ignored");
	expect(decodeCheckFrame(new ArrayBuffer(4)).kind).toBe("ignored");
	expect(decodeCheckFrame(JSON.stringify({ type: "what" })).kind).toBe("ignored");
	expect(decodeCheckFrame(JSON.stringify(null)).kind).toBe("ignored");
});

test("base64 that is not base64 becomes empty output rather than an error", () => {
	const frame = decodeCheckFrame(JSON.stringify({ type: "output", data: "!!!!" }));
	expect(frame).toEqual({ kind: "output", bytes: new Uint8Array() });
});
