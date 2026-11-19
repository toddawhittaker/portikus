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
import { Button, IconButton, useToast } from "@portikus/ui";
import { lazy, Suspense, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ApiError, errorText } from "../api/request.js";
import { answerTerminalQuestion } from "../api/workspace.js";
import { questionAnnouncement, useAgentStatus } from "./codingAgentStatus.js";
import "./terminal.css";

// Questions are rare, so the card and the chat styles it shares load on the first one.
const QuestionCard = lazy(() =>
	Promise.all([import("../chat/QuestionCard.js"), import("../chat/chat.css")]).then(
		([module]) => ({ default: module.QuestionCard }),
	),
);

/** Shown when the answer arrives after Claude Code stopped waiting for it. */
export const QUESTION_GONE = "Answered in the terminal or timed out";

/** Hands the keyboard to the terminal that holds the node, when the node holds it. */
function returnFocusToTerminal(node: HTMLElement | null) {
	if (!node?.contains(document.activeElement)) return;
	// xterm.js takes the keyboard through this hidden field.
	node
		.closest(".pk-term")
		?.querySelector<HTMLElement>(".xterm-helper-textarea")
		?.focus({ preventScroll: true });
}

/**
 * What a new question does about the keyboard: the card takes it from this
 * pane's terminal or from nowhere; a visible pane whose student is typing
 * elsewhere gets a spoken announcement instead; a hidden tab gets neither,
 * because its toast already tells the student; a window that does not have
 * focus is the same, since the persistent toast speaks for it (SPEC.md §25.8).
 */
function questionFocus(
	visible: boolean,
	active: Element | null,
	pane: Element | null,
): "take" | "announce" | "none" {
	if (!visible) return "none";
	if (active === null || active === document.body) return "take";
	if (pane?.contains(active)) return "take";
	return document.hasFocus() ? "announce" : "none";
}

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
	const agent = useAgentStatus().terminals.find((one) => one.terminalId === terminalId);
	const question = agent?.question;
	const toast = useToast();
	const region = useRef<HTMLDivElement | null>(null);
	/** The question whose announcement was decided, so a refresh never says it twice. */
	const decided = useRef<string | null>(null);
	/** The spoken text for the question on screen; empty once it leaves. */
	const [announcement, setAnnouncement] = useState("");
	/** A question this tab has settled, hidden before the agent's list catches up. */
	const [settled, setSettled] = useState<string | null>(null);
	const [sending, setSending] = useState(false);
	const [gone, setGone] = useState(false);
	/** Bumped when an answer fails to send, so the card can send again with its choices kept. */
	const [failedSends, setFailedSends] = useState(0);

	const shownId = question && question.id !== settled ? question.id : null;
	const agentKind = agent?.agent;
	const agentName = agent?.name;
	useEffect(() => {
		// The notice is about the last question, so the next one replaces it.
		if (shownId !== null) setGone(false);
		if (shownId === null) {
			decided.current = null;
			setAnnouncement("");
			return;
		}
		// Decided once on arrival, before the lazy card tries for the keyboard.
		if (decided.current === shownId) return;
		decided.current = shownId;
		const pane = region.current?.closest(".pk-term") ?? null;
		// Every new question starts from an empty region, so the last one's words never linger.
		setAnnouncement(
			agentKind &&
				agentName &&
				questionFocus(visible, document.activeElement, pane) === "announce"
				? questionAnnouncement(agentKind, agentName)
				: "",
		);
	}, [shownId, visible, agentKind, agentName]);

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
			<div
				ref={region}
				role="status"
				aria-live="polite"
				data-testid={`terminal-question-live-${terminalId}`}
			>
				{announcement ? (
					// Keyed by question, so a swap from one question to the next is a new
					// node a screen reader speaks even when the words are the same.
					<span key={shownId} className="pk-visually-hidden">
						{announcement}
					</span>
				) : null}
				{gone ? (
					<GoneNotice
						testId={`terminal-question-gone-${terminalId}`}
						onClose={() => setGone(false)}
					/>
				) : null}
			</div>
		</>
	);
}

/** Stays until the student closes it or the next question arrives. */
function GoneNotice({ testId, onClose }: { testId: string; onClose: () => void }) {
	const box = useRef<HTMLParagraphElement | null>(null);

	// Runs before the notice leaves the page, so a closed notice never strands focus.
	useLayoutEffect(() => {
		const node = box.current;
		return () => returnFocusToTerminal(node);
	}, []);

	return (
		<p ref={box} className="pk-term-flag pk-term-question-gone" data-testid={testId}>
			{QUESTION_GONE}
			<IconButton icon="x" size="sm" label="Dismiss notice" onClick={onClose} />
		</p>
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
		return () => returnFocusToTerminal(node);
	}, []);

	/** Take the keyboard only from this pane's terminal or from nowhere. */
	function takeFocus(): boolean {
		return (
			questionFocus(
				visible,
				document.activeElement,
				box.current?.closest(".pk-term") ?? null,
			) === "take"
		);
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
