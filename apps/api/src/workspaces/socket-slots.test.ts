import { expect, test } from "vitest";
import { createSocketSlots } from "./socket-slots.js";

test("a key gets at most the cap, and a release frees one slot", () => {
	const slots = createSocketSlots(2);
	expect(slots.take("alice")).toBe(true);
	expect(slots.take("alice")).toBe(true);
	expect(slots.take("alice")).toBe(false);
	slots.release("alice");
	expect(slots.open("alice")).toBe(1);
	expect(slots.take("alice")).toBe(true);
});

test("one key's slots never affect another's (SPEC.md §24.13)", () => {
	const slots = createSocketSlots(1);
	expect(slots.take("alice")).toBe(true);
	expect(slots.take("alice")).toBe(false);
	expect(slots.take("bob")).toBe(true);
	slots.release("bob");
	expect(slots.open("alice")).toBe(1);
});

test("an extra release never goes below zero or grants extra slots", () => {
	const slots = createSocketSlots(1);
	slots.release("alice");
	expect(slots.open("alice")).toBe(0);
	expect(slots.take("alice")).toBe(true);
	expect(slots.take("alice")).toBe(false);
});
