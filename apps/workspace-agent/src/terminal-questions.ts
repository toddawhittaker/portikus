import {
	MAX_CODING_AGENT_TERMINALS,
	MAX_TERMINAL_QUESTIONS_HELD_BYTES,
	TERMINAL_QUESTION_TIMEOUT_MS,
	TerminalChatQuestions,
	TerminalId,
	type TerminalQuestion,
	TerminalQuestionAnswer,
	type TerminalQuestionPost,
} from "@portikus/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { questionResult } from "./chat/claude-adapter.js";
import { ERROR_STATUS } from "./errors.js";

/**
 * Questions a terminal's Claude Code asks through its AskUserQuestion hook,
 * held while the student answers them in the browser (SPEC.md §10.8,
 * ADR 0075). Memory only, and never logged: questions and answers are the
 * student's (SPEC.md §24.2).
 */

/** The hook's own wait is the contract's limit less 5 seconds; this gives up 5 sooner. */
export const TERMINAL_QUESTION_WAIT_MS = TERMINAL_QUESTION_TIMEOUT_MS - 10_000;

const QuestionInput = z.object({ questions: TerminalChatQuestions });

/** What Claude Code reads from a PreToolUse hook's output to answer the call itself. */
export interface QuestionHookReply {
	hookSpecificOutput: {
		hookEventName: "PreToolUse";
		permissionDecision: "allow";
		updatedInput: Record<string, unknown>;
	};
}

interface Waiting {
	question: TerminalQuestion;
	input: Record<string, unknown>;
	/** The question's JSON size, counted against the held-bytes cap. */
	bytes: number;
	/** Null lets Claude Code ask in the terminal itself. */
	settle: (reply: QuestionHookReply | null) => void;
}

export interface TerminalQuestionsOptions {
	/** Told when a terminal's question appears or goes, to show it on the board. */
	onChange: (terminalId: string, question: TerminalQuestion | undefined) => void;
	/** Whether a terminal is open; a question for any other id is asked in the terminal. */
	isOpen: (terminalId: string) => Promise<boolean>;
	/** Overrides how long a question waits. For tests. */
	waitMs?: number;
}

/** At most one waiting question per terminal. */
export class TerminalQuestions {
	private readonly waiting = new Map<string, Waiting>();
	private readonly onChange: TerminalQuestionsOptions["onChange"];
	private readonly isOpen: TerminalQuestionsOptions["isOpen"];
	private readonly waitMs: number;
	private heldBytes = 0;

	constructor(options: TerminalQuestionsOptions) {
		this.onChange = options.onChange;
		this.isOpen = options.isOpen;
		this.waitMs = options.waitMs ?? TERMINAL_QUESTION_WAIT_MS;
	}

	/**
	 * Hold a hook's question until the student answers, the hook goes away, or
	 * the wait ends. Null, at once or later, means Claude Code asks in the
	 * terminal: anything but an AskUserQuestion that fits the contract, a
	 * terminal that is not open or already waiting, too many terminals
	 * waiting, or too many bytes of questions held.
	 */
	async ask(
		terminalId: string,
		post: TerminalQuestionPost,
		signal: AbortSignal,
	): Promise<QuestionHookReply | null> {
		if (post.tool_name !== "AskUserQuestion") return null;
		const parsed = QuestionInput.safeParse(post.tool_input);
		if (!parsed.success) return null;
		if (!(await this.isOpen(terminalId).catch(() => false))) return null;
		// Checked after the await, so two posts racing cannot both pass.
		if (signal.aborted) return null;
		if (this.waiting.has(terminalId)) return null;
		if (this.waiting.size >= MAX_CODING_AGENT_TERMINALS) return null;
		const input = post.tool_input as Record<string, unknown>;
		const question: TerminalQuestion = {
			id: post.tool_use_id,
			questions: parsed.data.questions,
		};
		const bytes = new TextEncoder().encode(JSON.stringify(question)).length;
		if (this.heldBytes + bytes > MAX_TERMINAL_QUESTIONS_HELD_BYTES) return null;
		return new Promise((resolve) => {
			const timer = setTimeout(() => entry.settle(null), this.waitMs);
			const onAbort = () => entry.settle(null);
			const entry: Waiting = {
				question,
				input,
				bytes,
				settle: (reply) => {
					if (this.waiting.get(terminalId) !== entry) return;
					clearTimeout(timer);
					signal.removeEventListener("abort", onAbort);
					this.waiting.delete(terminalId);
					this.heldBytes -= bytes;
					this.onChange(terminalId, undefined);
					resolve(reply);
				},
			};
			signal.addEventListener("abort", onAbort, { once: true });
			this.waiting.set(terminalId, entry);
			this.heldBytes += bytes;
			this.onChange(terminalId, question);
		});
	}

	/**
	 * The student's answer, from the API. False when the terminal waits on no
	 * question with this id: it was answered in the terminal or timed out.
	 */
	answer(terminalId: string, answer: TerminalQuestionAnswer): boolean {
		const entry = this.waiting.get(terminalId);
		if (!entry || entry.question.id !== answer.id) return false;
		if ("inTerminal" in answer) {
			entry.settle(null);
			return true;
		}
		const result = questionResult(
			entry.input,
			entry.question.questions,
			answer.answers,
			answer.notes,
		);
		entry.settle({
			hookSpecificOutput: {
				hookEventName: "PreToolUse",
				permissionDecision: "allow",
				updatedInput: result.updatedInput,
			},
		});
		return true;
	}

	/** A closed terminal's question goes; its Claude Code went with it. */
	remove(terminalId: string): void {
		this.waiting.get(terminalId)?.settle(null);
	}
}

/**
 * `POST /terminals/:id/question` on the agent's authenticated port: the
 * API forwards the owner's answer here (SPEC.md §24.1). The loopback
 * receiver never takes answers, so a process in the workspace cannot answer
 * for the student.
 */
export async function terminalQuestionRoute(
	app: FastifyInstance,
	options: { questions: TerminalQuestions },
): Promise<void> {
	app.post<{ Params: { id: string } }>(
		"/terminals/:id/question",
		async (request, reply) => {
			const id = TerminalId.safeParse(request.params.id);
			const answer = TerminalQuestionAnswer.safeParse(request.body);
			if (!id.success || !answer.success) {
				return reply
					.code(ERROR_STATUS.BAD_REQUEST)
					.send({ error: { code: "BAD_REQUEST", message: "invalid answer" } });
			}
			if (!options.questions.answer(id.data, answer.data)) {
				return reply.code(ERROR_STATUS.BUSY).send({
					error: { code: "BUSY", message: "answered in the terminal or timed out" },
				});
			}
			return reply.code(204).send();
		},
	);
}
