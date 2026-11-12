/**
 * The question a terminal's Claude Code is waiting on, as the chat's question
 * card over the bottom of the pane (SPEC.md §10.8). It overlays the terminal
 * without resizing it, and "Answer in the terminal" hands the question back
 * to Claude Code's own dialog. Questions and answers live only in this
 * state, never in storage.
 */
import type {
	TerminalQuestionAnswer,
	TerminalQuestion as WaitingQuestion,
} from "@portikus/contracts";
import { Button, useToast } from "@portikus/ui";
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ApiError, errorText } from "../api/request.js";
import { answerTerminalQuestion } from "../api/workspace.js";
import { useAgentStatus } from "./codingAgentStatus.js";
import "./terminal.css";

// Questions are rare, so the card and the chat styles it shares load on the first one.
const QuestionCard = lazy(() =>
	Promise.all([import("../chat/QuestionCard.js"), import("../chat/chat.css")]).then(
		([module]) => ({ default: module.QuestionCard }),
	),
);

/** Shown when the answer arrives after Claude Code stopped waiting for it. */
export const QUESTION_GONE = "Answered in the terminal or timed out";
const GONE_MS = 4000;

export interface TerminalQuestionProps {
	workspaceId: string;
	terminalId: string;
	visible: boolean;
}

export function TerminalQuestion({
	workspaceId,
	terminalId,
	visible,
}: TerminalQuestionProps) {
	const question = useAgentStatus().terminals.find(
		(one) => one.terminalId === terminalId,
	)?.question;
	const toast = useToast();
	/** A question this tab has settled, hidden before the agent's list catches up. */
	const [settled, setSettled] = useState<string | null>(null);
	const [sending, setSending] = useState(false);
	const [gone, setGone] = useState(false);
	/** Bumped when an answer fails to send, so the card can send again with its choices kept. */
	const [failedSends, setFailedSends] = useState(0);

	useEffect(() => {
		if (!gone) return;
		const timer = setTimeout(() => setGone(false), GONE_MS);
		return () => clearTimeout(timer);
	}, [gone]);

	async function send(answer: TerminalQuestionAnswer) {
		if (sending) return;
		setSending(true);
		try {
			await answerTerminalQuestion(workspaceId, terminalId, answer);
			setSettled(answer.id);
		} catch (error) {
			if (error instanceof ApiError && error.status === 409) {
				setSettled(answer.id);
				setGone(true);
			} else {
				toast.show({
					tone: "danger",
					title: "Your answer was not sent",
					children: errorText(error),
				});
				setFailedSends((was) => was + 1);
			}
		} finally {
			setSending(false);
		}
	}

	const shown = question && question.id !== settled ? question : null;
	return (
		<>
			{shown ? (
				<QuestionOverlay
					key={shown.id}
					question={shown}
					visible={visible}
					sending={sending}
					failedSends={failedSends}
					onSend={(answer) => void send(answer)}
				/>
			) : null}
			<div role="status" aria-live="polite">
				{gone ? (
					<p
						className="pk-term-flag pk-term-question-gone"
						data-testid={`terminal-question-gone-${terminalId}`}
					>
						{QUESTION_GONE}
					</p>
				) : null}
			</div>
		</>
	);
}

function QuestionOverlay({
	question,
	visible,
	sending,
	failedSends,
	onSend,
}: {
	question: WaitingQuestion;
	visible: boolean;
	sending: boolean;
	failedSends: number;
	onSend: (answer: TerminalQuestionAnswer) => void;
}) {
	const box = useRef<HTMLDivElement | null>(null);

	// Runs before the card leaves the page, while it still holds focus.
	useLayoutEffect(() => {
		const node = box.current;
		return () => {
			if (!node?.contains(document.activeElement)) return;
			// xterm.js takes the keyboard through this hidden field.
			node
				.closest(".pk-term")
				?.querySelector<HTMLElement>(".xterm-helper-textarea")
				?.focus({ preventScroll: true });
		};
	}, []);

	/** Take the keyboard only from this pane's terminal or from nowhere. */
	function takeFocus(): boolean {
		if (!visible) return false;
		const active = document.activeElement;
		if (active === null || active === document.body) return true;
		return box.current?.closest(".pk-term")?.contains(active) ?? false;
	}

	return (
		<div ref={box} className="pk-term-question" data-testid="terminal-question">
			<Suspense fallback={null}>
				<QuestionCard
					card={{ type: "question", id: question.id, questions: question.questions }}
					waiting={0}
					failedSends={failedSends}
					takeFocus={takeFocus}
					onAnswer={(answers, notes) => {
						onSend(
							notes
								? { id: question.id, answers, notes }
								: { id: question.id, answers },
						);
						return true;
					}}
					extraAction={
						<Button
							variant="quiet"
							size="sm"
							aria-disabled={sending || undefined}
							data-testid="terminal-question-in-terminal"
							onClick={() => onSend({ id: question.id, inTerminal: true })}
						>
							Answer in the terminal
						</Button>
					}
				/>
			</Suspense>
		</div>
	);
}
