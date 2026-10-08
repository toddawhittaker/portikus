import { expect, test } from "vitest";
// @ts-expect-error The generator is a plain .mjs script with no type declarations.
import { buildList, HAND_WRITTEN, MIN_LENGTH } from "./generate-breached-passwords.mjs";

const build = (lines: string[], extra: string[] = []): string[] =>
	buildList(lines, extra);

test("keeps only entries of at least the minimum length", () => {
	expect(MIN_LENGTH).toBe(15);
	expect(build(["password", "12345678901234", "123456789012345"])).toEqual([
		"123456789012345",
	]);
});

test("lower-cases, de-duplicates and sorts", () => {
	expect(build(["ZZZZZZZZZZZZZZZ", "PasswordPassword", "passwordpassword"])).toEqual([
		"passwordpassword",
		"zzzzzzzzzzzzzzz",
	]);
});

test("merges the hand-written entries and drops blank lines and CR endings", () => {
	expect(build(["", "abcdefghijklmnop\r"], ["Portikusportikus"])).toEqual([
		"abcdefghijklmnop",
		"portikusportikus",
	]);
});

test("every hand-written entry survives the filter", () => {
	expect(build([], HAND_WRITTEN)).toHaveLength(new Set(HAND_WRITTEN).size);
});
