import { afterEach, expect, test, vi } from "vitest";

/** New passwords are checked against known-breached ones (SPEC.md section 24.13, ADR 0054). */

const reads = vi.hoisted(() => ({ count: 0 }));
vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	return {
		...fs,
		readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
			reads.count += 1;
			return fs.readFileSync(...args);
		},
	};
});

const { isBreachedPassword } = await import("./breached-passwords.js");

afterEach(() => {
	expect(reads.count).toBe(1);
});

test("refuses a long password from the SecLists list", () => {
	// Not among the hand-written entries, so this proves the generated list is used.
	expect(isBreachedPassword("manchesterunited")).toBe(true);
});

test("refuses a listed password in any case", () => {
	expect(isBreachedPassword("ManchesterUnited")).toBe(true);
	expect(isBreachedPassword("PASSWORDPASSWORD")).toBe(true);
	expect(isBreachedPassword("correct horse battery staple")).toBe(true);
});

test("accepts a password that is not listed", () => {
	expect(isBreachedPassword("violet-tram-orbit-lantern")).toBe(false);
	// A listed password with something added is not the listed password.
	expect(isBreachedPassword("passwordpassword!x")).toBe(false);
});

test("a short password is left to the length rule, not this list", () => {
	// "password" tops every breach list but is under 15 characters.
	expect(isBreachedPassword("password")).toBe(false);
});

test("reads the list file once however many checks run", () => {
	for (let i = 0; i < 5; i += 1) isBreachedPassword(`check-${i}-padding-text`);
});
