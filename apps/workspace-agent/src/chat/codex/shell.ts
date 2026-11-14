import { randomUUID } from "node:crypto";
import type { ChatShellItem } from "@portikus/contracts";
import type { ChatEventBody, ChatSink } from "../agent.js";
import { runningShell, withoutKind } from "../shell-command.js";
import type { AppServerClient as Client } from "./app-server.js";
import { shellItem } from "./history.js";
import type { CommandItem } from "./protocol.js";

/** How long a `!` command may run before Codex stops it (ADR 0073). */
const SHELL_TIME_LIMIT_MS = 2 * 60 * 1000;

/**
 * The `!` command a chat runs with Codex's own shell command, outside the
 * model (ADR 0073). Its turn is not a conversation turn: its events are
 * told apart here, and it is shown as done once its turn ends, so no
 * message reaches Codex mid-command.
 */
export class CodexShell {
	/** The command running now; its turn id once Codex starts it. */
	private current: { item: ChatShellItem; turnId: string | null } | null = null;

	constructor(private readonly sink: () => ChatSink) {}

	get running(): boolean {
		return this.current !== null;
	}

	/** The running command's turn, once Codex has started it. */
	get turnId(): string | null {
		return this.current?.turnId ?? null;
	}

	/** The command, for a client that attaches while it runs. */
	inProgress(): ChatEventBody[] {
		return this.current ? [{ type: "shell", ...withoutKind(this.current.item) }] : [];
	}

	async run(client: Client, threadId: string | null, command: string): Promise<void> {
		const item = runningShell(randomUUID(), command);
		this.current = { item, turnId: null };
		this.sink().emit({ type: "shell", ...withoutKind(item) });
		try {
			await client.request("thread/shellCommand", {
				threadId,
				command,
				timeoutMs: SHELL_TIME_LIMIT_MS,
			});
		} catch {
			if (this.current?.item.id === item.id) this.finish(item);
			throw new Error("The shell command could not start.");
		}
	}

	/** A turn started: it is the command's when the command still waits for its turn. */
	claimsTurn(turnId: string, turnRunning: boolean): boolean {
		if (this.current && this.current.turnId === null && !turnRunning) {
			this.current.turnId = turnId;
			return true;
		}
		return false;
	}

	/** A turn ended: true when it was the command's, which is then done. */
	endsWith(turnId: string): boolean {
		if (!this.current || this.current.turnId !== turnId) return false;
		this.finish(this.current.item);
		return true;
	}

	/** Codex's own item for the command, with its output so far. */
	completedItem(item: CommandItem): void {
		if (this.current) this.current.item = shellItem(this.current.item.id, item);
	}

	/** The conversation ended under the command. */
	end(): void {
		if (this.current) this.finish(this.current.item);
	}

	private finish(item: ChatShellItem): void {
		this.current = null;
		this.sink().emit({ type: "shell", ...withoutKind({ ...item, state: "done" }) });
	}
}
