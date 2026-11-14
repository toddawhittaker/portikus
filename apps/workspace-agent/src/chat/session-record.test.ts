import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
	type ChatSwapState,
	chatSessionsDir,
	readChatSession,
	readSwapState,
	recordChatSession,
	takeSwapState,
	writeChatSession,
	writePendingSwitch,
	writeSwapState,
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

const STATE: ChatSwapState = {
	sessions: { claude: B },
	earlier: [{ type: "turn.started", at: 1 }],
	truncated: false,
	log: [{ agent: "claude", turns: [{ user: "hi", reply: "hello", tools: [] }] }],
	handoff: null,
};

test("a tab with no swaps has no swap state", async () => {
	expect(await takeSwapState(home, A, "claude")).toEqual({
		state: null,
		switched: false,
	});
});

test("a swap prepared for Codex is taken up by the Codex host, which starts a fresh thread", async () => {
	await writeChatSession(home, A, B);
	await writePendingSwitch(home, A, "codex", STATE);
	expect(await takeSwapState(home, A, "codex")).toEqual({
		state: STATE,
		switched: true,
	});
	expect(await readSwapState(home, A)).toEqual(STATE);
	// The terminal id in the record means no thread yet.
	expect(await readChatSession(home, A)).toBe(A);
	// It is taken once; a restart reads the state, not a second swap.
	expect(await takeSwapState(home, A, "codex")).toEqual({
		state: STATE,
		switched: false,
	});
	const file = join(chatSessionsDir(home), `${A}.swap.json`);
	expect((await stat(file)).mode & 0o777).toBe(0o600);
});

test("a swap back to Claude resumes Claude's own session", async () => {
	await writeChatSession(home, A, C);
	await writePendingSwitch(home, A, "claude", {
		...STATE,
		sessions: { claude: B, codex: C },
	});
	expect((await takeSwapState(home, A, "claude")).switched).toBe(true);
	expect(await recordChatSession(home, A)).toBe(B);
});

test("a swap prepared for the other agent, which never started, is dropped", async () => {
	await writePendingSwitch(home, A, "codex", STATE);
	expect(await takeSwapState(home, A, "claude")).toEqual({
		state: null,
		switched: false,
	});
	expect(await takeSwapState(home, A, "codex")).toEqual({
		state: null,
		switched: false,
	});
});

test("a resumed chat carries the ended chat's swaps over", async () => {
	await writeSwapState(home, A, STATE);
	expect(await takeSwapState(home, B, "claude", A)).toEqual({
		state: STATE,
		switched: false,
	});
	expect(await readSwapState(home, B)).toEqual(STATE);
});

test("forgetting the swaps, as /clear does, removes them; a damaged file reads as none", async () => {
	await writeSwapState(home, A, STATE);
	await writeSwapState(home, A, null);
	expect(await readSwapState(home, A)).toBeNull();
	await writeFile(join(chatSessionsDir(home), `${A}.swap.json`), "{not json");
	expect(await readSwapState(home, A)).toBeNull();
	await writeFile(join(chatSessionsDir(home), `${A}.swap.json`), '{"sessions":{}}');
	expect(await readSwapState(home, A)).toBeNull();
});
