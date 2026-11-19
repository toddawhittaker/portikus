import { ChatSubagentEvent, type SideExchange } from "@portikus/contracts";
import type { ChatEventBody } from "../agent.js";
import type { AppServerClient as Client } from "./app-server.js";
import { turnStatus } from "./history.js";
import { CodexItemMapper } from "./mapper.js";
import {
	DeltaNotification,
	ErrorNotification,
	ItemNotification,
	parsed,
	ThreadResult,
	type TurnError,
	TurnNotification,
	TurnStartResult,
} from "./protocol.js";

type SideEventBody = Extract<ChatEventBody, { type: ChatSubagentEvent["type"] }>;

const SIDE_EVENT_TYPES: readonly string[] = ChatSubagentEvent.options.map(
	(option) => option.shape.type.value,
);

function isSideEvent(event: ChatEventBody): event is SideEventBody {
	return SIDE_EVENT_TYPES.includes(event.type);
}

/**
 * The note put ahead of a side question, as an injected item rather than
 * developer instructions, which the platform's managed config owns
 * (SPEC.md §10.2).
 */
export const SIDE_BOUNDARY =
	"This is a side conversation. Everything before this note is the main " +
	"conversation, for reference only: do not continue its work. Answer only " +
	"the side question that follows. Do not change any files, and do not start " +
	"subagents.";

const STOPPED = "Codex stopped before it answered.";

function message(role: "user" | "assistant", text: string): unknown {
	const type = role === "user" ? "input_text" : "output_text";
	return { type: "message", role, content: [{ type, text }] };
}

/** The items a side question's fork is given before its turn: the boundary, then earlier exchanges. */
export function sideItems(earlier: readonly SideExchange[]): unknown[] {
	const items = [message("user", SIDE_BOUNDARY)];
	for (const exchange of earlier) {
		items.push(message("user", exchange.question));
		if (exchange.answer !== "") items.push(message("assistant", exchange.answer));
	}
	return items;
}

export interface CodexSideHost {
	terminalId: string;
	projectDir: string;
	/** The running app-server, started if need be. */
	client(): Promise<Client>;
	/** The main conversation's thread. */
	mainThread(): string | null;
	/** The main chat's model and effort; a side question uses the same ones. */
	model(): { model: string; effort: string };
}

interface Question {
	client: Client;
	forkId: string | null;
	turnId: string | null;
	mapper: CodexItemMapper;
	emit: (event: ChatSubagentEvent) => void;
	done: (outcome?: Error | "interrupted") => void;
	error: TurnError | null;
}

/**
 * A side conversation beside a Codex chat (SPEC.md §10.2, ADR 0083). Each
 * question forks the main thread as it stands into an ephemeral, read-only
 * thread with approvals off, puts the side boundary and the earlier side
 * exchanges into it, and runs one turn. The fork's events go only to the
 * side pane: never to the main transcript, the tab's state or its context
 * meter. Held in memory only, never logged (ADR 0012).
 */
export class CodexSide {
	private question: Question | null = null;
	/** Forks this host made, so their requests are refused and their events kept apart. */
	private readonly forks = new Set<string>();
	private seq = 0;
	/** A question is waiting for the app-server, before it runs. */
	private opening = false;

	constructor(private readonly host: CodexSideHost) {}

	/** The thread is a side fork. */
	owns(threadId: string): boolean {
		return this.forks.has(threadId);
	}

	async ask(
		text: string,
		earlier: readonly SideExchange[],
		emit: (event: ChatSubagentEvent) => void,
		signal: AbortSignal,
	): Promise<void> {
		if (this.question || this.opening)
			throw new Error("Wait for the side answer, or stop it first.");
		this.opening = true;
		let client: Client;
		try {
			client = await this.host.client();
		} finally {
			this.opening = false;
		}
		const main = this.host.mainThread();
		if (!main) throw new Error("Codex has no conversation to ask about yet.");
		let resolve!: () => void;
		let reject!: (error: Error) => void;
		const promise = new Promise<void>((yes, no) => {
			resolve = yes;
			reject = no;
		});
		const question: Question = {
			client,
			forkId: null,
			turnId: null,
			mapper: new CodexItemMapper(),
			emit,
			error: null,
			done: (outcome) => {
				if (this.question !== question) return;
				this.question = null;
				signal.removeEventListener("abort", onAbort);
				const status =
					outcome instanceof Error ? "error" : outcome ? "interrupted" : "done";
				this.send(question, { type: "turn.finished", status, at: Date.now() });
				void this.release(question);
				if (outcome instanceof Error) reject(outcome);
				else resolve();
			},
		};
		const onAbort = () => {
			const { forkId, turnId } = question;
			if (forkId && turnId) {
				void client
					.request("turn/interrupt", { threadId: forkId, turnId })
					.catch(() => undefined);
			}
			question.done("interrupted");
		};
		this.question = question;
		signal.addEventListener("abort", onAbort, { once: true });
		this.send(question, { type: "turn.started", at: Date.now() });
		void this.run(question, main, text, earlier).catch((error: unknown) =>
			question.done(
				new Error(error instanceof Error ? error.message : "Codex did not answer."),
			),
		);
		return promise;
	}

	private async run(
		question: Question,
		main: string,
		text: string,
		earlier: readonly SideExchange[],
	): Promise<void> {
		const { client } = question;
		const { model, effort } = this.host.model();
		const fork = parsed(
			ThreadResult,
			await client.request("thread/fork", {
				threadId: main,
				ephemeral: true,
				// Codex refuses an ephemeral fork that would copy the turns back.
				excludeTurns: true,
				cwd: this.host.projectDir,
				sandbox: "read-only",
				approvalPolicy: "never",
				...(model ? { model } : {}),
			}),
		);
		if (!fork) throw new Error("Codex did not start the side conversation.");
		question.forkId = fork.thread.id;
		this.forks.add(fork.thread.id);
		// Stopped while the fork was starting: it is dropped now its id is known.
		if (this.question !== question) {
			void this.release(question);
			return;
		}
		await client.request("thread/inject_items", {
			threadId: fork.thread.id,
			items: sideItems(earlier),
		});
		if (this.question !== question) return;
		const started = parsed(
			TurnStartResult,
			await client.request("turn/start", {
				threadId: fork.thread.id,
				input: [{ type: "text", text, text_elements: [] }],
				approvalPolicy: "never",
				sandboxPolicy: { type: "readOnly", networkAccess: false },
				...(model ? { model } : {}),
				...(effort ? { effort } : {}),
			}),
		);
		question.turnId ??= started?.turn.id ?? null;
		// Stopped while the turn was starting: interrupt it now its id is known.
		if (this.question !== question && question.turnId) {
			void client
				.request("turn/interrupt", {
					threadId: fork.thread.id,
					turnId: question.turnId,
				})
				.catch(() => undefined);
		}
	}

	/** An event of a side fork. Token usage and anything else is dropped. */
	notification(threadId: string, method: string, params: unknown): void {
		const question = this.question;
		if (!question || question.forkId !== threadId) return;
		switch (method) {
			case "turn/started":
				question.turnId ??= parsed(TurnNotification, params)?.turn.id ?? null;
				return;
			case "turn/completed": {
				const turn = parsed(TurnNotification, params)?.turn;
				const status = turnStatus(turn?.status ?? "");
				const message = (turn?.error ?? question.error)?.message?.trim();
				if (status === "error")
					question.done(new Error(message?.slice(0, 500) || "Codex hit an error."));
				else question.done(status === "interrupted" ? "interrupted" : undefined);
				return;
			}
			case "item/started":
			case "item/completed": {
				const item = parsed(ItemNotification, params)?.item;
				if (item === undefined) return;
				// The question is shown by the pane when it is asked.
				if ((item as { type?: unknown } | null)?.type === "userMessage") return;
				const events =
					method === "item/started"
						? question.mapper.started(item)
						: question.mapper.completed(item);
				for (const event of events) this.send(question, event);
				return;
			}
			case "item/agentMessage/delta": {
				const delta = parsed(DeltaNotification, params);
				if (!delta) return;
				for (const event of question.mapper.delta(delta.itemId, delta.delta))
					this.send(question, event);
				return;
			}
			case "error": {
				const error = parsed(ErrorNotification, params);
				if (error && !error.willRetry) question.error = error.error ?? null;
			}
		}
	}

	/** Codex stopped: the question running ends with an error. */
	stopped(): void {
		this.question?.done(new Error(STOPPED));
		this.forks.clear();
	}

	/** Close the side conversation: stop any question and drop its fork. */
	async end(): Promise<void> {
		const question = this.question;
		if (question?.forkId && question.turnId) {
			await question.client
				.request("turn/interrupt", {
					threadId: question.forkId,
					turnId: question.turnId,
				})
				.catch(() => undefined);
		}
		question?.done("interrupted");
		this.seq = 0;
	}

	private async release(question: Question): Promise<void> {
		const { forkId } = question;
		if (!forkId) return;
		await question.client
			.request("thread/unsubscribe", { threadId: forkId })
			.catch(() => undefined);
	}

	private send(question: Question, event: ChatEventBody): void {
		if (!isSideEvent(event)) return;
		const seq = this.seq;
		this.seq += 1;
		question.emit({
			...event,
			sessionId: this.host.terminalId,
			seq,
		} as ChatSubagentEvent);
	}
}
