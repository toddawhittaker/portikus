import { randomUUID } from "node:crypto";
import {
	type ChatCommand,
	type ChatSubagentEvent,
	MAX_CHAT_SERVER_FRAME_BYTES,
	MAX_CHAT_SIDE_TEXT_CHARS,
	type SideExchange,
} from "@portikus/contracts";
import type { ChatAgent, SideBody, SideEventBody } from "./agent.js";

/**
 * One chat's side conversation (SPEC.md §10.2, ADR 0083): questions asked
 * beside the main conversation, which never enter its transcript, open no
 * card and leave the tab's working state alone. It lives in memory only and
 * ends on /clear, an agent swap, or the host stopping. Nothing from it is
 * logged (ADR 0012).
 */

const SIDE_COMMAND = "btw";

export const SIDE_COMMAND_INFO: ChatCommand = {
	name: SIDE_COMMAND,
	description: "Ask a side question without interrupting the chat",
	argumentHint: "<question>",
	terminalOnly: false,
};

export const SIDE_BUSY_MESSAGE =
	"Wait for the side answer before asking another side question.";
export const SIDE_UNAVAILABLE_MESSAGE = "This chat cannot take side questions.";
export const SIDE_TOO_LONG_MESSAGE = `A side question can be at most ${MAX_CHAT_SIDE_TEXT_CHARS} characters.`;
const SIDE_FAILED_MESSAGE = "That side question did not get an answer. Try again.";

/**
 * What a send's text asks of the side conversation: nothing (not `/btw`),
 * just the pane (a bare `/btw`, which the browser opens), or a question.
 */
export function sideCommand(text: string): { question: string } | "open" | null {
	// `/btw` then any whitespace (a space, a tab or a newline) starts the question.
	const match = /^\/btw(?:\s+([\s\S]*))?$/.exec(text.trim());
	if (!match) return null;
	return match[1] ? { question: match[1] } : "open";
}

export interface SideDeps {
	terminalId: string;
	agent: ChatAgent;
	/** Write one frame to every attachment whose attach has finished. */
	broadcast: (line: string) => void;
}

export class SideConversation {
	private earlier: SideExchange[] = [];
	/** Every event since the conversation opened, numbered, for an attach. */
	private events: ChatSubagentEvent[] = [];
	private seq = 0;
	/** The question running now. */
	private running: AbortController | null = null;

	constructor(private readonly deps: SideDeps) {}

	/**
	 * Ask a question; the answer streams to every attachment. A refusal is
	 * an answer in the side conversation too, outside any turn, so the main
	 * conversation never shows it.
	 */
	ask(text: string): void {
		const askSide = this.deps.agent.askSide;
		if (this.events.length === 0) this.send(this.snapshot());
		const refusal = !askSide
			? SIDE_UNAVAILABLE_MESSAGE
			: this.running
				? SIDE_BUSY_MESSAGE
				: text.length > MAX_CHAT_SIDE_TEXT_CHARS
					? SIDE_TOO_LONG_MESSAGE
					: null;
		if (!askSide || refusal) {
			this.answer(refusal ?? SIDE_UNAVAILABLE_MESSAGE);
			return;
		}
		const controller = new AbortController();
		this.running = controller;
		const answers: string[] = [];
		const live = () => this.running === controller;
		// The core owns the side turn; the driver emits only its content.
		this.push({ type: "turn.started", at: Date.now() });
		this.push({ type: "message", id: randomUUID(), role: "user", markdown: text });
		const emit = (event: SideEventBody) => {
			if (!live()) return;
			if (event.type === "message" && event.role === "assistant")
				answers.push(event.markdown);
			this.push(event);
		};
		void askSide
			.call(this.deps.agent, text, [...this.earlier], emit, controller.signal)
			.then(
				() => (controller.signal.aborted ? "interrupted" : "done"),
				(error: unknown) => {
					if (controller.signal.aborted) return "interrupted";
					if (live()) {
						this.answer(
							error instanceof Error && error.message
								? error.message
								: SIDE_FAILED_MESSAGE,
						);
					}
					return "error";
				},
			)
			.then((status) => {
				if (!live()) return;
				this.running = null;
				if (status === "done")
					this.earlier.push({ question: text, answer: answers.join("\n\n") });
				this.push({ type: "turn.finished", status, at: Date.now() });
			});
	}

	/** Stop the running question; the conversation stays. */
	stop(): void {
		this.running?.abort();
	}

	/** Forget the conversation and tell every attachment it is empty. */
	async end(): Promise<void> {
		// A question still starting counts: its driver may hold something to drop.
		const open = this.events.length > 0 || this.running !== null;
		this.running?.abort();
		this.running = null;
		this.earlier = [];
		this.events = [];
		this.seq = 0;
		if (open) {
			this.send(this.snapshot(), true);
			await this.deps.agent.endSide?.().catch(() => undefined);
		}
	}

	/** The conversation so far, as frames for one attachment. */
	replay(): string[] {
		if (this.events.length === 0) return [];
		return [this.snapshot(), ...this.events]
			.map((event) => this.frame(event))
			.filter((line) => line !== null);
	}

	private snapshot(): ChatSubagentEvent {
		return {
			type: "snapshot",
			sessionId: this.deps.terminalId,
			seq: 0,
			cards: [],
			turnRunning: this.running !== null,
			truncated: false,
		};
	}

	/** A message from the host in the side conversation: a refusal or an error. */
	private answer(markdown: string): void {
		this.push({ type: "message", id: randomUUID(), role: "assistant", markdown });
	}

	private push(body: SideBody): void {
		this.seq += 1;
		const event = {
			...body,
			sessionId: this.deps.terminalId,
			seq: this.seq,
		} as ChatSubagentEvent;
		this.events.push(event);
		this.send(event);
	}

	/** One frame to every attachment; `ended` marks the conversation's end. */
	private send(event: ChatSubagentEvent, ended = false): void {
		const line = this.frame(event, ended);
		if (line !== null) this.deps.broadcast(line);
	}

	/** One `side` frame, or null when it is larger than a frame may be. */
	private frame(event: ChatSubagentEvent, ended = false): string | null {
		const line = JSON.stringify({
			type: "side",
			sessionId: this.deps.terminalId,
			...(ended ? { ended: true } : {}),
			event,
		});
		return Buffer.byteLength(line, "utf8") <= MAX_CHAT_SERVER_FRAME_BYTES ? line : null;
	}
}
