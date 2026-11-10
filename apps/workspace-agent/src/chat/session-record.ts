import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TerminalId } from "@portikus/contracts";

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
