import { agentTitleText, type ChatServerEvent } from "@portikus/contracts";
import type { ChatSdk } from "./sdk.js";

/**
 * A chat's conversation title (ADR 0074). Claude Code's session file is the
 * source: the student's own title from `/rename` or the pencil, else Claude
 * Code's summary. The CLI announces no change, so the host reads it again
 * after each result and publishes it when it differs. The title is drawn
 * from prompts: it is held here and posted, never logged.
 */
export class ChatTitle {
	/** The title last published; undefined until one post has gone through. */
	private published: string | null | undefined;
	/** Posts go one at a time, so the receiver sees them in order. */
	private queue: Promise<void> = Promise.resolve();

	constructor(
		private readonly sdk: Pick<ChatSdk, "sessionTitle" | "renameSession">,
		private readonly dir: string,
		private readonly post: (title: string | null) => Promise<void>,
	) {}

	/** Read the session's title and publish it if it changed. A failure keeps the last one. */
	refresh(sessionId: string): Promise<void> {
		this.queue = this.queue.then(async () => {
			let title: string | null;
			try {
				const raw = await this.sdk.sessionTitle(sessionId, this.dir);
				title = raw === null ? null : agentTitleText(raw) || null;
			} catch {
				return;
			}
			if (title === this.published) return;
			try {
				await this.post(title);
				this.published = title;
			} catch {
				// The next refresh tries again.
			}
		});
		return this.queue;
	}

	/** A new session: its title is read afresh, and published even when it matches. */
	reset(): void {
		this.published = undefined;
	}

	/** Retitle the session and publish the result. */
	async rename(sessionId: string, raw: string): Promise<void> {
		const title = agentTitleText(raw);
		if (title === "") throw new Error("A title needs at least one letter or number.");
		try {
			await this.sdk.renameSession(sessionId, title, this.dir);
		} catch (error) {
			// Claude Code writes the session file with the first message.
			if (error instanceof Error && /not found/i.test(error.message)) {
				throw new Error("Send a message first, then rename it.");
			}
			throw new Error("The chat could not be renamed. Try again.");
		}
		await this.refresh(sessionId);
	}

	/** Rename, and say how it went as the `rename.result` the asker reads. */
	answerRename(
		sessionId: string,
		raw: string,
	): Promise<Extract<ChatServerEvent, { type: "rename.result" }>> {
		return this.rename(sessionId, raw).then(
			() => ({ type: "rename.result", ok: true }),
			(error: Error) => ({ type: "rename.result", ok: false, message: error.message }),
		);
	}
}
