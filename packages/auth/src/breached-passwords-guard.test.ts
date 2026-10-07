import { afterEach, expect, test, vi } from "vitest";

/** An empty or truncated list must stop the process, not accept every password (ADR 0054). */

afterEach(() => {
	vi.doUnmock("node:fs");
	vi.resetModules();
});

function listReads(content: string): void {
	vi.resetModules();
	vi.doMock("node:fs", async (importOriginal) => ({
		...(await importOriginal<typeof import("node:fs")>()),
		readFileSync: () => content,
	}));
}

test("an empty list file refuses to load", async () => {
	listReads("");
	await expect(import("./breached-passwords.js")).rejects.toThrow(
		"breached-password list is missing entries",
	);
});

test("a short list file refuses to load", async () => {
	listReads("passwordpassword\nmanchesterunited\n");
	await expect(import("./breached-passwords.js")).rejects.toThrow(
		"breached-password list is missing entries",
	);
});
