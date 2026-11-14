import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CodingAgent, TerminalId } from "@portikus/contracts";
import { z } from "zod";
import type { ChatEventBody } from "./agent.js";
import { HandoffSegment } from "./handoff.js";

/**
 * Which Claude session each chat tab runs, one file per tab holding only
 * the session id (SPEC.md §10.8). It lives in the student's home so it
 * survives a workspace restart, and so a chain of resumes keeps one session.
 */
export function chatSessionsDir(homeDir: string): string {
	return join(homeDir, ".local", "state", "portikus", "chat-sessions");
}

async function readRecord(dir: string, tabId: string): Promise<string | null> {
	const text = await readFile(join(dir, tabId), "utf8").catch(() => null);
	const parsed = TerminalId.safeParse(text?.trim());
	return parsed.success ? parsed.data : null;
}

/** The session or thread a chat tab's running agent has recorded, if any. */
export function readChatSession(
	homeDir: string,
	tabId: string,
): Promise<string | null> {
	return readRecord(chatSessionsDir(homeDir), TerminalId.parse(tabId));
}

/**
 * The session a chat tab runs, recorded under its own id: the session of
 * the ended tab it resumes, or else the session already recorded for this
 * tab, each falling back to that tab's own id when it has no record.
 */
export async function recordChatSession(
	homeDir: string,
	tabId: string,
	resumeOf?: string,
): Promise<string> {
	const tab = TerminalId.parse(tabId);
	const old = resumeOf === undefined ? undefined : TerminalId.parse(resumeOf);
	const dir = chatSessionsDir(homeDir);
	// A restarted tab keeps the session it had moved to, such as after /clear.
	const from = old ?? tab;
	const sessionId = (await readRecord(dir, from)) ?? from;
	await writeChatSession(homeDir, tab, sessionId);
	return sessionId;
}

/** Record that a chat tab now runs this session, replacing what it ran before. */
export async function writeChatSession(
	homeDir: string,
	tabId: string,
	sessionId: string,
): Promise<void> {
	const tab = TerminalId.parse(tabId);
	const session = TerminalId.parse(sessionId);
	const dir = chatSessionsDir(homeDir);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	await chmod(dir, 0o700);
	const temp = join(dir, `.${tab}.${randomUUID()}.tmp`);
	await writeFile(temp, session, { mode: 0o600 });
	await rename(temp, join(dir, tab));
}

/**
 * A chat's state across agent swaps, beside its session record (SPEC.md
 * §10.8). Absent until the first swap. It holds the student's conversation,
 * so it stays in this private directory and is never logged (ADR 0012).
 */
export const ChatSwapState = z.object({
	/** Claude's own session, kept while Codex runs; Codex always starts a fresh thread. */
	sessions: z.object({ claude: TerminalId.optional() }),
	/** What the chat shows before the running agent's part, ending in a divider. */
	earlier: z.array(z.looseObject({ type: z.string() })),
	/** Older turns than `earlier` holds exist. */
	truncated: z.boolean(),
	/** Each finished stretch of the conversation, oldest first, for the next handoff. */
	log: z.array(HandoffSegment),
	/** The handoff the running agent was given, and how many turns it left out. */
	handoff: z
		.object({
			id: z.uuid(),
			from: CodingAgent,
			droppedTurns: z.number().int().nonnegative(),
		})
		.nullable(),
});
export type ChatSwapState = Omit<z.infer<typeof ChatSwapState>, "earlier"> & {
	earlier: ChatEventBody[];
};

/** A swap the running host has prepared and the next host takes up. */
const PendingSwitch = z.object({ to: CodingAgent, state: ChatSwapState });

const swapFile = (dir: string, tab: string) => join(dir, `${tab}.swap.json`);
const switchFile = (dir: string, tab: string) => join(dir, `${tab}.switch.json`);

async function readJson<T>(path: string, schema: z.ZodType<T>): Promise<T | null> {
	const text = await readFile(path, "utf8").catch(() => null);
	if (text === null) return null;
	try {
		const parsed = schema.safeParse(JSON.parse(text));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

async function writePrivate(dir: string, path: string, text: string): Promise<void> {
	await mkdir(dir, { recursive: true, mode: 0o700 });
	await chmod(dir, 0o700);
	const temp = `${path}.${randomUUID()}.tmp`;
	await writeFile(temp, text, { mode: 0o600 });
	await rename(temp, path);
}

/** The tab's swap state, or null when it never swapped or the file is unreadable. */
export async function readSwapState(
	homeDir: string,
	tabId: string,
): Promise<ChatSwapState | null> {
	const tab = TerminalId.parse(tabId);
	return readJson(
		swapFile(chatSessionsDir(homeDir), tab),
		ChatSwapState,
	) as Promise<ChatSwapState | null>;
}

/** Save the tab's swap state; null forgets it, as /clear does. */
export async function writeSwapState(
	homeDir: string,
	tabId: string,
	state: ChatSwapState | null,
): Promise<void> {
	const tab = TerminalId.parse(tabId);
	const dir = chatSessionsDir(homeDir);
	if (state === null) {
		await unlink(swapFile(dir, tab)).catch(() => undefined);
		return;
	}
	await writePrivate(dir, swapFile(dir, tab), JSON.stringify(state));
}

/** Leave a prepared swap for the host that starts next with `to`. */
export async function writePendingSwitch(
	homeDir: string,
	tabId: string,
	to: CodingAgent,
	state: ChatSwapState,
): Promise<void> {
	const tab = TerminalId.parse(tabId);
	const dir = chatSessionsDir(homeDir);
	await writePrivate(dir, switchFile(dir, tab), JSON.stringify({ to, state }));
}

/** Forget a prepared swap that no host took up. */
export async function dropPendingSwitch(homeDir: string, tabId: string): Promise<void> {
	const tab = TerminalId.parse(tabId);
	await unlink(switchFile(chatSessionsDir(homeDir), tab)).catch(() => undefined);
}

/**
 * Start a chat host for `agent`: take up a swap prepared for it, making
 * its state the tab's and pointing the session record at this agent's own
 * session, or drop one prepared for the other agent, which never started.
 * Returns the state and whether this start is the swap. A resumed tab
 * carries the ended tab's swap state over.
 */
export async function takeSwapState(
	homeDir: string,
	tabId: string,
	agent: CodingAgent,
	resumeOf?: string,
): Promise<{ state: ChatSwapState | null; switched: boolean }> {
	const tab = TerminalId.parse(tabId);
	const dir = chatSessionsDir(homeDir);
	const pending = await readJson(switchFile(dir, tab), PendingSwitch);
	await dropPendingSwitch(homeDir, tab);
	if (pending && pending.to === agent) {
		const state = pending.state as ChatSwapState;
		await writeSwapState(homeDir, tab, state);
		// Codex starts a fresh thread with the conversation; Claude resumes its own.
		const own = agent === "claude" ? state.sessions.claude : undefined;
		await writeChatSession(homeDir, tab, own ?? tab);
		return { state, switched: true };
	}
	if (resumeOf !== undefined) {
		const state = await readSwapState(homeDir, resumeOf);
		if (state) await writeSwapState(homeDir, tab, state);
		return { state, switched: false };
	}
	return { state: await readSwapState(homeDir, tab), switched: false };
}
