/**
 * A chat tab's centre pane (SPEC.md §8.3, §10.8): the conversation, the
 * cards waiting for an answer docked below it so they never scroll away,
 * and the composer at the bottom. Cards and the turn's state are announced
 * politely (SPEC.md §25.8); no ticking time is. A card never takes the
 * keyboard from where the student is typing: an Enter meant for a message
 * must not grant a permission.
 */
import type { ChatOpenCard } from "@portikus/contracts";
import { AgentStateMark, IconButton, Skeleton } from "@portikus/ui";
import type { TiptapEditorHTMLElement } from "@tiptap/core";
import { useEffect, useId, useLayoutEffect, useMemo, useRef } from "react";
import { useStore } from "zustand";
import { isLeaveShortcut } from "../terminal/leaveShortcut.js";
import { Composer } from "./Composer.js";
import type { ChatState } from "./chatStore.js";
import { ImageViewerProvider } from "./ImageViewer.js";
import { MessageList } from "./MessageList.js";
import { PermissionCard } from "./PermissionCard.js";
import { QuestionCard } from "./QuestionCard.js";
import { SessionRules } from "./SessionRules.js";
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

const COMPOSER_BOX = '.pk-chat-composer [role="textbox"]';

/** Ways into a new chat; a click puts one in the message box to edit, never sends it. */
const STARTERS = [
	"Explain how this project is organised",
	"Find a bug and explain it before fixing it",
	"Write tests for the main file",
] as const;

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
	const store = useChatSession(workspaceId, projectId, terminalId);
	const state = useStore(store);
	const root = useRef<HTMLDivElement | null>(null);
	const log = useRef<HTMLDivElement | null>(null);
	const content = useRef<HTMLDivElement | null>(null);
	const cardsHadFocus = useRef(false);
	const ids = useId();
	const follow = useFollowEnd(log, content, visible);
	const card = state.cards[0];
	const waiting = state.cards.length - 1;
	// A permission card's id is the id of the tool call it asks about.
	const asking = useMemo(
		() =>
			new Set(
				state.cards.flatMap((one) => (one.type === "permission" ? [one.id] : [])),
			),
		[state.cards],
	);

	// Opening a chat from the launcher puts the keyboard in its message box.
	// biome-ignore lint/correctness/useExhaustiveDependencies: only as the chat first appears
	useEffect(() => {
		if (focused) focusComposer();
	}, []);

	// Where ResizeObserver is missing, new content still keeps the end in view;
	// a student reading back is told it came instead.
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs whenever the conversation changes
	useLayoutEffect(() => {
		follow.arrived();
	}, [state.items]);

	// So does a turn's working line, and a card docking below the log, which makes it shorter.
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs whenever the turn or the dock changes
	useLayoutEffect(() => {
		const box = log.current;
		if (box && !follow.away) box.scrollTop = box.scrollHeight;
	}, [state.currentTurnId, card?.id]);

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
			?.focus({ preventScroll: true });
	}, [card?.id]);

	/** A new card takes the keyboard only when nothing holds it; the announcement covers the rest. */
	function takeFocus(): boolean {
		if (!visible) return false;
		const active = document.activeElement;
		return active === null || active === document.body;
	}

	/** Focus never scrolls: only the log scrolls, and only by its own rules. */
	function focusComposer() {
		root.current
			?.querySelector<HTMLElement>(COMPOSER_BOX)
			?.focus({ preventScroll: true });
	}

	/**
	 * The composer's editor hangs on its element (TipTap's own handle), so no
	 * new prop is needed. A draft already typed is kept, never replaced.
	 */
	function fillComposer(text: string) {
		const editor =
			root.current?.querySelector<TiptapEditorHTMLElement>(COMPOSER_BOX)?.editor;
		if (!editor) return;
		if (!editor.isEmpty) {
			editor.view.focus();
			return;
		}
		editor
			.chain()
			.setContent({
				type: "doc",
				content: [{ type: "paragraph", content: [{ type: "text", text }] }],
			})
			.focus("end", { scrollIntoView: false })
			.run();
		// TipTap focuses on the next frame; the student's next key should land now.
		editor.view.focus();
	}

	function jumpToLatest() {
		follow.toEnd();
		// The button goes away with its own click, so the keyboard needs a new home.
		focusComposer();
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
									Ask Claude Code about this project below, or start from one of these.
									The conversation is kept in your workspace, not by Portikus.
								</p>
								<ul className="pk-chat-starters">
									{STARTERS.map((starter) => (
										<li key={starter}>
											<button
												type="button"
												className="pk-chat-starter pk-focus-ring"
												onClick={() => fillComposer(starter)}
											>
												{starter}
											</button>
										</li>
									))}
								</ul>
							</div>
						) : (
							<MessageList
								items={state.items}
								turns={state.turns}
								currentTurnId={state.currentTurnId}
								truncated={state.truncated}
								asking={asking}
							/>
						)}
					</div>
				</div>
				{follow.away ? (
					<div className="pk-chat-jump">
						<IconButton
							icon="chevron-down"
							label="Jump to latest"
							variant="secondary"
							className="pk-chat-jump-button"
							data-testid="chat-jump"
							data-fresh={follow.fresh || undefined}
							aria-describedby={follow.fresh ? `${ids}-fresh` : undefined}
							onClick={jumpToLatest}
						/>
						{follow.fresh ? (
							<>
								<span className="pk-chat-jump-dot" aria-hidden={true} />
								<span id={`${ids}-fresh`} className="sr-only">
									Something new arrived below
								</span>
							</>
						) : null}
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
							onAnswer={(optionId, extras) =>
								store.getState().answerPermission(card.id, optionId, extras)
							}
						/>
					)}
					<p className="pk-chat-needs" data-testid="chat-needs-input">
						<AgentStateMark state="needs-input" />
						Needs your input
					</p>
				</div>
			) : null}
			<SessionRules store={store} />
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
