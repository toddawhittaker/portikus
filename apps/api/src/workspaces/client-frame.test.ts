import { describe, expect, test } from "vitest";
import { acceptsClientFrame } from "./terminal-pipe.js";

/** What a browser may send down a terminal socket, by attach mode (ADR 0063). */
describe("acceptsClientFrame", () => {
	const input = JSON.stringify({ type: "input", data: "ls\r" });
	const resize = JSON.stringify({ type: "resize", cols: 10, rows: 5 });

	test("the student's own attach carries every frame", () => {
		for (const frame of [input, resize, "not json"]) {
			expect(acceptsClientFrame(undefined, frame)).toBe(true);
		}
	});

	test("a view attach carries nothing", () => {
		for (const frame of [input, resize, "not json", "{}"]) {
			expect(acceptsClientFrame("view", frame)).toBe(false);
		}
	});

	test("a type attach carries keystrokes only", () => {
		expect(acceptsClientFrame("type", input)).toBe(true);
		for (const frame of [
			resize,
			"not json",
			"{}",
			"null",
			JSON.stringify({ type: "INPUT" }),
		]) {
			expect(acceptsClientFrame("type", frame)).toBe(false);
		}
	});
});
