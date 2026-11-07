/**
 * A chat tab's centre pane (SPEC.md §8.3, §10.8): the conversation, the
 * cards waiting for an answer pinned below it so they never scroll away,
 * and the composer at the bottom. Cards and the turn's state are announced
 * politely (SPEC.md §25.8); no ticking time is.
 */
import type { ChatOpenCard } from "@portikus/contracts";
import { Skeleton } from "@portikus/ui";
import { useLayoutEffect, useRef } from "react";
import { useStore } from "zustand";
import type { ChatState } from "./chatStore.js";
import { MessageList } from "./MessageList.js";
import { PermissionCard } from "./PermissionCard.js";
import { PlaceholderComposer } from "./PlaceholderComposer.js";
import { QuestionCard } from "./QuestionCard.js";
import { useChatSession } from "./useChatSession.js";
import "./chat.css";

export interface ChatViewProps {
	workspaceId: string;
	terminalId: string;
	visible: boolean;
}

/** Within this many pixels of the end, new content keeps the view at the end. */
const STICK_PX = 48;

function announcement(state: ChatState): string {
	const card = state.cards[0];
	if (card) return cardAnnouncement(card);
	if (state.currentTurnId !== null) return "Claude is working.";
	const last = Object.values(state.turns).at(-1);
	if (last?.status === "done") return "Claude finished.";
	if (last?.status === "interrupted") return "Claude stopped.";
	if (last?.status === "error") return "Claude's turn failed.";
	return "";
}

function cardAnnouncement(card: ChatOpenCard): string {
	if (card.type === "permission") {
		return card.toolName === "ExitPlanMode"
			? "Claude has a plan for you to review."
			: `Claude wants to use ${card.toolName}.`;
	}
	return card.questions.length === 1
		? `Claude has a question: ${card.questions[0]?.question ?? ""}`
		: `Claude has ${card.questions.length} questions.`;
}

const CONNECTION_TEXT: Partial<Record<ChatState["connection"], string>> = {
	reconnecting: "Reconnecting…",
	lost: "This chat lost its connection. Reload the page to try again.",
	tooMany:
		"You have too many chats and terminals open across your browser tabs. Close some, then reload the page.",
	notFound: "This chat is no longer available. Close the tab and start a new one.",
};

export function ChatView({ workspaceId, terminalId, visible }: ChatViewProps) {
	const store = useChatSession(workspaceId, terminalId);
	const state = useStore(store);
	const root = useRef<HTMLDivElement | null>(null);
	const log = useRef<HTMLDivElement | null>(null);
	const atEnd = useRef(true);
	const cardsHadFocus = useRef(false);
	const card = state.cards[0];
	const waiting = state.cards.length - 1;

	// Follow new content only when already at the end, so reading back is not interrupted.
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs whenever the conversation grows
	useLayoutEffect(() => {
		const box = log.current;
		if (box && atEnd.current) box.scrollTop = box.scrollHeight;
	}, [state.items, state.currentTurnId, visible]);

	// A card answered here or in another browser takes the focus with it; put it somewhere useful.
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs when the front card changes
	useLayoutEffect(() => {
		if (!cardsHadFocus.current) return;
		cardsHadFocus.current = false;
		// Focus that moved on by itself stays where it went.
		const active = document.activeElement;
		if (active !== null && active !== document.body) return;
		root.current
			?.querySelector<HTMLElement>(
				".pk-chat-cards input, .pk-chat-cards button, .pk-chat-composer textarea",
			)
			?.focus();
	}, [card?.id]);

	/** A new card takes the keyboard only from this chat, or from nowhere. */
	function takeFocus(): boolean {
		if (!visible) return false;
		const active = document.activeElement;
		return (
			active === null || active === document.body || !!root.current?.contains(active)
		);
	}

	const notice = CONNECTION_TEXT[state.connection];

	return (
		<div ref={root} className="pk-chat" data-testid={`chat-view-${terminalId}`}>
			<div
				ref={log}
				className="pk-chat-scroll"
				onScroll={(event) => {
					const box = event.currentTarget;
					atEnd.current =
						box.scrollHeight - box.scrollTop - box.clientHeight <= STICK_PX;
				}}
			>
				{!state.loaded ? (
					<div className="pk-chat-loading" data-testid="chat-loading">
						<span className="sr-only">Loading the conversation…</span>
						<Skeleton lines={3} width="60%" />
					</div>
				) : state.items.length === 0 && state.currentTurnId === null ? (
					<div className="pk-chat-empty" data-testid="chat-empty">
						<p className="pk-chat-empty-title">No messages yet</p>
						<p className="pk-chat-muted">
							Ask Claude Code about this project below. The conversation is kept in your
							workspace, not by Portikus.
						</p>
					</div>
				) : (
					<MessageList
						items={state.items}
						turns={state.turns}
						currentTurnId={state.currentTurnId}
						truncated={state.truncated}
					/>
				)}
			</div>
			<p className="pk-chat-notice" role="status" data-testid="chat-connection">
				{notice}
			</p>
			{card ? (
				// biome-ignore lint/a11y/noStaticElementInteractions: only notes where focus was; the cards hold the controls
				<div
					className="pk-chat-cards"
					onFocus={() => {
						cardsHadFocus.current = true;
					}}
				>
					{card.type === "question" ? (
						<QuestionCard
							key={card.id}
							card={card}
							takeFocus={takeFocus}
							onAnswer={(answers, notes) =>
								store.getState().answerQuestion(card.id, answers, notes)
							}
						/>
					) : (
						<PermissionCard
							key={card.id}
							card={card}
							takeFocus={takeFocus}
							onAnswer={(optionId) =>
								store.getState().answerPermission(card.id, optionId)
							}
						/>
					)}
					{waiting > 0 ? (
						<p className="pk-chat-muted" data-testid="chat-cards-waiting">
							{waiting === 1
								? "1 more request is waiting"
								: `${waiting} more requests are waiting`}
						</p>
					) : null}
				</div>
			) : null}
			{/* The composer mounts here. */}
			<div className="pk-chat-composer">
				<PlaceholderComposer store={store} />
			</div>
			<p className="sr-only" aria-live="polite" data-testid="chat-announcer">
				{announcement(state)}
			</p>
		</div>
	);
}
