import { randomUUID } from "node:crypto";
import {
	type ChatCommand,
	type ChatSubagentEvent,
	MAX_CHAT_SERVER_FRAME_BYTES,
	MAX_CHAT_SIDE_TEXT_CHARS,
	type SideExchange,
} from "@portikus/contracts";
import type { ChatAgent } from "./agent.js";

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

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
	? Omit<T, K>
	: never;
type SideBody = DistributiveOmit<ChatSubagentEvent, "sessionId" | "seq">;

/**
 * What a send's text asks of the side conversation: nothing (not `/btw`),
 * just the pane (a bare `/btw`, which the browser opens), or a question.
 */
export function sideCommand(text: string): { question: string } | "open" | null {
	const trimmed = text.trim();
	if (trimmed === `/${SIDE_COMMAND}`) return "open";
	if (!text.trimStart().startsWith(`/${SIDE_COMMAND} `)) return null;
	const question = trimmed.slice(SIDE_COMMAND.length + 1).trim();
	return question === "" ? "open" : { question };
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

	/** Whether a side question is running. */
	get busy(): boolean {
		return this.running !== null;
	}

	/** Ask a question; a refusal throws, and the answer streams to every attachment. */
	ask(text: string): void {
		const askSide = this.deps.agent.askSide;
		if (!askSide) throw new Error(SIDE_UNAVAILABLE_MESSAGE);
		if (this.running) throw new Error(SIDE_BUSY_MESSAGE);
		if (text.length > MAX_CHAT_SIDE_TEXT_CHARS) throw new Error(SIDE_TOO_LONG_MESSAGE);
		const controller = new AbortController();
		this.running = controller;
		if (this.events.length === 0) this.send(this.snapshot());
		const answers: string[] = [];
		let asked = false;
		let finished = false;
		const live = () => this.running === controller;
		// The driver opens and closes the side turn; the question goes in just inside it.
		const askedOnce = () => {
			if (asked) return;
			asked = true;
			this.push({ type: "message", id: randomUUID(), role: "user", markdown: text });
		};
		const emit = (event: ChatSubagentEvent) => {
			if (!live() || event.type === "snapshot") return;
			const { sessionId: _, seq: __, ...body } = event;
			if (body.type === "turn.started") {
				this.push(body);
				askedOnce();
				return;
			}
			askedOnce();
			if (body.type === "turn.finished") finished = true;
			if (body.type === "message" && body.role === "assistant")
				answers.push(body.markdown);
			this.push(body as SideBody);
		};
		void askSide
			.call(this.deps.agent, text, [...this.earlier], emit, controller.signal)
			.then(
				() => (controller.signal.aborted ? "interrupted" : "done"),
				(error: unknown) => {
					if (controller.signal.aborted) return "interrupted";
					if (live()) {
						askedOnce();
						const markdown =
							error instanceof Error && error.message
								? error.message
								: SIDE_FAILED_MESSAGE;
						this.push({
							type: "message",
							id: randomUUID(),
							role: "assistant",
							markdown,
						});
					}
					return "error";
				},
			)
			.then((status) => {
				if (!live()) return;
				this.running = null;
				if (status === "done")
					this.earlier.push({ question: text, answer: answers.join("\n\n") });
				// A driver that ended without closing its turn still leaves it closed.
				if (!finished) {
					askedOnce();
					this.push({ type: "turn.finished", status, at: Date.now() });
				}
			});
	}

	/** Stop the running question; the conversation stays. */
	stop(): void {
		this.running?.abort();
	}

	/** Forget the conversation and tell every attachment it is empty. */
	async end(): Promise<void> {
		const open = this.events.length > 0;
		this.running?.abort();
		this.running = null;
		this.earlier = [];
		this.events = [];
		this.seq = 0;
		if (open) {
			this.send(this.snapshot());
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

	private send(event: ChatSubagentEvent): void {
		const line = this.frame(event);
		if (line !== null) this.deps.broadcast(line);
	}

	/** One `side` frame, or null when it is larger than a frame may be. */
	private frame(event: ChatSubagentEvent): string | null {
		const line = JSON.stringify({
			type: "side",
			sessionId: this.deps.terminalId,
			event,
		});
		return Buffer.byteLength(line, "utf8") <= MAX_CHAT_SERVER_FRAME_BYTES ? line : null;
	}
}
