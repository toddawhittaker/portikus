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
 * The session a chat tab runs, recorded under its own id: its own id for a
 * new chat, or the session of the ended tab it resumes, falling back to
 * that tab's id when it has no record.
 */
export async function recordChatSession(
	homeDir: string,
	tabId: string,
	resumeOf?: string,
): Promise<string> {
	const tab = TerminalId.parse(tabId);
	const old = resumeOf === undefined ? undefined : TerminalId.parse(resumeOf);
	const dir = chatSessionsDir(homeDir);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	await chmod(dir, 0o700);
	const sessionId = old === undefined ? tab : ((await readRecord(dir, old)) ?? old);
	const temp = join(dir, `.${tab}.${randomUUID()}.tmp`);
	await writeFile(temp, sessionId, { mode: 0o600 });
	await rename(temp, join(dir, tab));
	return sessionId;
}
