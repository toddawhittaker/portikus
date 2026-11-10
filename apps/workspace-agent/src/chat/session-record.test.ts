import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
	chatSessionsDir,
	recordChatSession,
	writeChatSession,
} from "./session-record.js";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const C = "33333333-3333-4333-8333-333333333333";
const D = "44444444-4444-4444-8444-444444444444";

let home: string;
beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "pk-chat-sessions-"));
});
afterEach(async () => {
	await rm(home, { recursive: true, force: true });
});

test("a new chat records its own id, in a private directory", async () => {
	expect(await recordChatSession(home, A)).toBe(A);
	expect(await readFile(join(chatSessionsDir(home), A), "utf8")).toBe(A);
	expect((await stat(chatSessionsDir(home))).mode & 0o777).toBe(0o700);
});

test("a chain of three resumes keeps the first chat's session", async () => {
	await recordChatSession(home, A);
	expect(await recordChatSession(home, B, A)).toBe(A);
	expect(await recordChatSession(home, C, B)).toBe(A);
	expect(await recordChatSession(home, D, C)).toBe(A);
	expect(await readFile(join(chatSessionsDir(home), D), "utf8")).toBe(A);
});

test("a resumed tab with no record falls back to its own id", async () => {
	expect(await recordChatSession(home, B, A)).toBe(A);
});

test("a malformed record falls back to the old tab's id", async () => {
	await mkdir(chatSessionsDir(home), { recursive: true });
	await writeFile(join(chatSessionsDir(home), A), "../../etc/passwd");
	expect(await recordChatSession(home, B, A)).toBe(A);
});

test("ids that are not UUIDs are refused", async () => {
	await expect(recordChatSession(home, "../x")).rejects.toThrow();
	await expect(recordChatSession(home, A, "../x")).rejects.toThrow();
});

test("a restarted tab keeps the session /clear moved it to", async () => {
	await recordChatSession(home, A);
	await writeChatSession(home, A, B);
	expect(await recordChatSession(home, A)).toBe(B);
	expect(await recordChatSession(home, C, A)).toBe(B);
});

test("a session id that is not a UUID is refused", async () => {
	await expect(writeChatSession(home, A, "../x")).rejects.toThrow();
});
