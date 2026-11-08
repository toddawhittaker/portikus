/**
 * A chat tab's centre pane (SPEC.md §8.3, §10.8): the conversation, the
 * cards waiting for an answer docked below it so they never scroll away,
 * and the composer at the bottom. Cards and the turn's state are announced
 * politely (SPEC.md §25.8); no ticking time is. A card never takes the
 * keyboard from where the student is typing: an Enter meant for a message
 * must not grant a permission.
 */
import type { ChatOpenCard } from "@portikus/contracts";
import { Button, Skeleton } from "@portikus/ui";
import { useEffect, useLayoutEffect, useRef } from "react";
import { useStore } from "zustand";
import { isLeaveShortcut } from "../terminal/leaveShortcut.js";
import { Composer } from "./Composer.js";
import type { ChatState } from "./chatStore.js";
import { ImageViewerProvider } from "./ImageViewer.js";
import { MessageList } from "./MessageList.js";
import { PermissionCard } from "./PermissionCard.js";
import { QuestionCard } from "./QuestionCard.js";
import { useChatSession } from "./useChatSession.js";
import { useFollowEnd } from "./useFollowEnd.js";
import { waitingText } from "./waiting.js";
import "./chat.css";

export interface ChatViewProps {
	workspaceId: string;
	projectId: string;
	terminalId: string;
	visible: boolean;
	/** The pane is the focused one as it mounts, so the message box takes the keyboard. */
	focused: boolean;
	/** Alt+Shift+Q: move the keyboard out to the tab strip. */
	onLeave: () => void;
}

function announcement(state: ChatState): string {
	const card = state.cards[0];
	if (card) {
		const waiting = state.cards.length - 1;
		return waiting > 0
			? `${cardAnnouncement(card)} ${waitingText(waiting)}`
			: cardAnnouncement(card);
	}
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

const COMPOSER_BOX = ".pk-chat-composer textarea";

/** The chat with its images' viewer around it, so a reply or a tool can open one. */
export function ChatView(props: ChatViewProps) {
	return (
		<ImageViewerProvider workspaceId={props.workspaceId} projectId={props.projectId}>
			<ChatViewBody {...props} />
		</ImageViewerProvider>
	);
}

function ChatViewBody({
	workspaceId,
	projectId,
	terminalId,
	visible,
	focused,
	onLeave,
}: ChatViewProps) {
	const store = useChatSession(workspaceId, terminalId);
	const state = useStore(store);
	const root = useRef<HTMLDivElement | null>(null);
	const log = useRef<HTMLDivElement | null>(null);
	const content = useRef<HTMLDivElement | null>(null);
	const cardsHadFocus = useRef(false);
	const follow = useFollowEnd(log, content, visible);
	const card = state.cards[0];
	const waiting = state.cards.length - 1;

	// Opening a chat from the launcher puts the keyboard in its message box.
	// biome-ignore lint/correctness/useExhaustiveDependencies: only as the chat first appears
	useEffect(() => {
		if (focused) root.current?.querySelector<HTMLElement>(COMPOSER_BOX)?.focus();
	}, []);

	// Where ResizeObserver is missing, new content still keeps the end in view.
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs whenever the conversation grows
	useLayoutEffect(() => {
		const box = log.current;
		if (box && !follow.away) box.scrollTop = box.scrollHeight;
	}, [state.items, state.currentTurnId]);

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
				`.pk-chat-cards input, .pk-chat-cards button, ${COMPOSER_BOX}`,
			)
			?.focus();
	}, [card?.id]);

	/** A new card takes the keyboard only when nothing holds it; the announcement covers the rest. */
	function takeFocus(): boolean {
		if (!visible) return false;
		const active = document.activeElement;
		return active === null || active === document.body;
	}

	function jumpToLatest() {
		follow.toEnd();
		// The button goes away with its own click, so the keyboard needs a new home.
		root.current?.querySelector<HTMLElement>(COMPOSER_BOX)?.focus();
	}

	const notice = CONNECTION_TEXT[state.connection];
	// A snapshot brings each open card again, with fresh state, so an answer lost
	// in a dropped connection can be given again.
	const cardKey = card ? `${card.id}:${state.snapshotAt}` : "";

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: one shortcut for the whole chat, as a terminal has
		<div
			ref={root}
			className="pk-chat"
			data-testid={`chat-view-${terminalId}`}
			onKeyDown={(event) => {
				if (!isLeaveShortcut(event.nativeEvent)) return;
				event.preventDefault();
				onLeave();
			}}
		>
			<div className="pk-chat-main">
				<div
					ref={log}
					className="pk-chat-scroll"
					data-testid="chat-scroll"
					onScroll={follow.onScroll}
				>
					<div ref={content} className="pk-chat-column">
						{!state.loaded ? (
							<div className="pk-chat-loading" data-testid="chat-loading">
								<span className="sr-only">Loading the conversation…</span>
								<Skeleton lines={3} width="60%" />
							</div>
						) : state.items.length === 0 && state.currentTurnId === null ? (
							<div className="pk-chat-empty" data-testid="chat-empty">
								<p className="pk-chat-empty-title">No messages yet</p>
								<p className="pk-chat-muted">
									Ask Claude Code about this project below. The conversation is kept in
									your workspace, not by Portikus.
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
				</div>
				{follow.away ? (
					<div className="pk-chat-jump">
						<Button
							size="sm"
							iconStart="chevron-down"
							data-testid="chat-jump"
							onClick={jumpToLatest}
						>
							Jump to latest
						</Button>
					</div>
				) : null}
			</div>
			<p
				className="pk-chat-notice"
				role="status"
				aria-live="polite"
				data-testid="chat-connection"
			>
				{notice}
			</p>
			{card ? (
				// biome-ignore lint/a11y/noStaticElementInteractions: only notes where focus was; the cards hold the controls
				<div
					className="pk-chat-cards"
					data-testid="chat-cards"
					onFocus={() => {
						cardsHadFocus.current = true;
					}}
				>
					{card.type === "question" ? (
						<QuestionCard
							key={cardKey}
							card={card}
							takeFocus={takeFocus}
							waiting={waiting}
							onAnswer={(answers, notes) =>
								store.getState().answerQuestion(card.id, answers, notes)
							}
						/>
					) : (
						<PermissionCard
							key={cardKey}
							card={card}
							takeFocus={takeFocus}
							waiting={waiting}
							onAnswer={(optionId) =>
								store.getState().answerPermission(card.id, optionId)
							}
						/>
					)}
				</div>
			) : null}
			<div className="pk-chat-composer">
				<Composer
					store={store}
					workspaceId={workspaceId}
					projectId={projectId}
					terminalId={terminalId}
				/>
			</div>
			<p className="sr-only" aria-live="polite" data-testid="chat-announcer">
				{announcement(state)}
			</p>
		</div>
	);
}
