/**
 * A chat tab's centre pane (SPEC.md §8.3, §10.8): the conversation, the
 * cards waiting for an answer docked below it so they never scroll away,
 * and the composer at the bottom. Cards and the turn's state are announced
 * politely (SPEC.md §25.8); no ticking time is. A card never takes the
 * keyboard from where the student is typing: an Enter meant for a message
 * must not grant a permission.
 */
import {
	type ChatOpenCard,
	CODING_AGENT_LABEL,
	type CodingAgent,
} from "@portikus/contracts";
import { IconButton, Skeleton } from "@portikus/ui";
import type { TiptapEditorHTMLElement } from "@tiptap/core";
import {
	useCallback,
	useContext,
	useEffect,
	useId,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useStore } from "zustand";
import { CODING_AGENT_NAME } from "../agents/codingAgentName.js";
import { useGitStatus } from "../files/useGitStatus.js";
import { LayoutStoreContext } from "../layout/store.js";
import { useProjects } from "../projects/queries.js";
import { isLeaveShortcut } from "../terminal/leaveShortcut.js";
import { useTerminals } from "../terminal/useTerminals.js";
import { speakingId, stop as stopReading } from "../voice/speak.js";
import { Composer } from "./Composer.js";
import { ChatAgentContext } from "./chatAgent.js";
import type { ChatState } from "./chatStore.js";
import { ImageViewerProvider } from "./ImageViewer.js";
import { type FileOpener, MessageList } from "./MessageList.js";
import { PermissionCard } from "./PermissionCard.js";
import { QuestionCard } from "./QuestionCard.js";
import {
	overlayOpen,
	useReadAloud,
	useReadNewReplies,
	useStopWhenLeaving,
} from "./readAloud.js";
import { useToolReveal } from "./revealTool.js";
import { SessionRules } from "./SessionRules.js";
import { SubagentPanel } from "./SubagentPanel.js";
import {
	SubagentOpenerContext,
	type SubagentTarget,
	takeSubagentRequest,
	useSubagentRequest,
} from "./subagentView.js";
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

/** The chat's agent as a speaker: "Claude", "Codex"; Claude until the host says. */
function agentOf(state: ChatState): CodingAgent {
	return state.settings?.agent ?? "claude";
}

function announcement(state: ChatState): string {
	const name = CODING_AGENT_LABEL[agentOf(state)];
	const card = state.cards[0];
	if (card) {
		const waiting = state.cards.length - 1;
		return waiting > 0
			? `${cardAnnouncement(card, name)} ${waitingText(waiting)}`
			: cardAnnouncement(card, name);
	}
	// A command is not a turn: its end is said when it is the newest thing in the chat.
	const newest = state.items.at(-1);
	if (newest?.kind === "shell" && newest.state === "done") {
		if (newest.exitCode === null) return "Command stopped.";
		return newest.exitCode === 0
			? "Command finished."
			: `Command failed with exit code ${newest.exitCode}.`;
	}
	if (state.currentTurnId !== null) return `${name} is working.`;
	const last = Object.values(state.turns).at(-1);
	if (last?.status === "done") return `${name} finished.`;
	if (last?.status === "interrupted") return `${name} stopped.`;
	if (last?.status === "error") return `${name}'s turn failed.`;
	return "";
}

function cardAnnouncement(card: ChatOpenCard, name: string): string {
	if (card.type === "permission") {
		return card.plan !== undefined
			? `${name} has a plan for you to review.`
			: `${name} wants to use ${card.toolName}.`;
	}
	return card.questions.length === 1
		? `${name} has a question: ${card.questions[0]?.question ?? ""}`
		: `${name} has ${card.questions.length} questions.`;
}

const CONNECTION_TEXT: Partial<Record<ChatState["connection"], string>> = {
	reconnecting: "Reconnecting…",
	lost: "This chat lost its connection. Reload the page to try again.",
	tooMany:
		"You have too many chats and terminals open across your browser tabs. Close some, then reload the page.",
	notFound: "This chat is no longer available. Close the tab and start a new one.",
};

const COMPOSER_BOX = '.pk-chat-composer [role="combobox"]';

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

/**
 * The work area's own open-file action, given to the chat so a changed file
 * opens where the file tree would open it: its diff in a Git repository, the
 * file otherwise. Null outside a work area.
 */
function useFileOpener(workspaceId: string, projectId: string): FileOpener | null {
	const layout = useContext(LayoutStoreContext);
	const git = useGitStatus(workspaceId, projectId);
	const projects = useProjects(workspaceId, "active");
	const slug = projects.data?.find((project) => project.id === projectId)?.slug;
	const repo = git.data?.repo === true;
	return useMemo(
		() =>
			layout === null
				? null
				: {
						slug,
						open: (path: string) =>
							layout.getState().openFile(path, repo ? { diff: true } : undefined),
					},
		[layout, slug, repo],
	);
}

/**
 * Put a new chat of the other agent in this empty chat's place, through the
 * same create and close a New chat uses: with nothing said yet, nothing is
 * lost, so nothing needs warning (SPEC.md §10.8). Null outside a work area.
 */
function useAgentSwitch(
	workspaceId: string,
	projectId: string,
	terminalId: string,
): ((agent: CodingAgent) => void) | null {
	const layout = useContext(LayoutStoreContext);
	// The work area polls the list; this only creates and closes.
	const terminals = useTerminals(workspaceId, projectId, false);
	if (layout === null) return null;
	return (agent) => {
		void terminals
			.create({ kind: "chat", agent })
			.then((created) => {
				layout.getState().replaceLeaf(terminalId, created.id);
				layout.getState().setFocused(created.id);
				void terminals.close(terminalId).catch(() => {});
				terminals.refetch();
			})
			// A failed create is the hook's toast; this chat stays.
			.catch(() => {});
	};
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
	const readAloud = useReadAloud(workspaceId, projectId);
	const opener = useFileOpener(workspaceId, projectId);
	const switchAgent = useAgentSwitch(workspaceId, projectId, terminalId);
	const program = CODING_AGENT_NAME[agentOf(state)];
	useReadNewReplies(store, readAloud.on, visible);
	useStopWhenLeaving(store, visible);
	const root = useRef<HTMLDivElement | null>(null);
	const log = useRef<HTMLDivElement | null>(null);
	const content = useRef<HTMLDivElement | null>(null);
	const cardsHadFocus = useRef(false);
	const ids = useId();
	const follow = useFollowEnd(log, content, visible);
	// A subagent picked in the project list opens at its tool row (SPEC.md §8.2).
	useToolReveal(terminalId, log, visible, state.items);
	const [subagent, setSubagent] = useState<SubagentTarget | null>(null);
	/** Where the keyboard goes back to when the subagent view closes. */
	const beforeSubagent = useRef<{
		element: HTMLElement | null;
		toolUseId: string;
	} | null>(null);
	const showSubagent = useCallback(
		(target: SubagentTarget, element: HTMLElement | null) => {
			beforeSubagent.current = { element, toolUseId: target.toolUseId };
			setSubagent(target);
		},
		[],
	);
	// From an Agent card, the keyboard goes back to the button that opened it.
	const openSubagent = useCallback(
		(target: SubagentTarget) => {
			const active = document.activeElement;
			showSubagent(target, active instanceof HTMLElement ? active : null);
		},
		[showSubagent],
	);
	// From the project list, it opens once this chat is on screen, and the
	// keyboard goes back to the Agent card's row, as the row's link promises.
	const requested = useSubagentRequest(terminalId);
	// The chat's own row closes the view; the keyboard stays on the row, as
	// that row's link leaves it.
	useEffect(() => {
		if (requested === undefined || !visible) return;
		takeSubagentRequest(terminalId);
		if (requested) {
			showSubagent(requested, null);
		} else {
			beforeSubagent.current = null;
			setSubagent(null);
		}
	}, [requested, visible, terminalId, showSubagent]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs as the view closes
	useLayoutEffect(() => {
		const before = beforeSubagent.current;
		if (subagent || !before) return;
		beforeSubagent.current = null;
		const card = log.current?.querySelector<HTMLElement>(
			`details[data-testid="chat-tool-${CSS.escape(before.toolUseId)}"] > summary`,
		);
		const back = before.element?.isConnected ? before.element : card;
		if (back) back.focus({ preventScroll: true });
		else focusComposer();
	}, [subagent]);
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
		// The conversation's byline, cards and notes name this chat's agent.
		<ChatAgentContext.Provider value={state.settings?.agent ?? "claude"}>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: one shortcut for the whole chat, as a terminal has */}
			<div
				ref={root}
				className="pk-chat"
				data-testid={`chat-view-${terminalId}`}
				onKeyDown={(event) => {
					// Escape stops the speech, unless a menu or dialog is open and it is theirs.
					if (event.key === "Escape" && speakingId() !== null && !overlayOpen()) {
						stopReading();
					}
					if (!isLeaveShortcut(event.nativeEvent)) return;
					event.preventDefault();
					onLeave();
				}}
			>
				<div className="pk-chat-main" data-subagent={subagent ? "" : undefined}>
					<div
						ref={log}
						className="pk-chat-scroll"
						data-testid="chat-scroll"
						onScroll={follow.onScroll}
						// The subagent card floats over the log; the keyboard stays out from behind it.
						inert={subagent !== null}
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
										Ask {program} about this project below, or start from one of these.
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
								<SubagentOpenerContext.Provider value={openSubagent}>
									<MessageList
										items={state.items}
										turns={state.turns}
										currentTurnId={state.currentTurnId}
										truncated={state.truncated}
										asking={asking}
										opener={opener}
									/>
								</SubagentOpenerContext.Provider>
							)}
						</div>
					</div>
					{subagent ? (
						<SubagentPanel
							chat={store}
							target={subagent}
							opener={opener}
							onClose={() => setSubagent(null)}
						/>
					) : null}
					{follow.away && !subagent ? (
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
					</div>
				) : null}
				<SessionRules store={store} />
				<div className="pk-chat-composer">
					<Composer
						store={store}
						readAloud={readAloud}
						workspaceId={workspaceId}
						projectId={projectId}
						terminalId={terminalId}
						onSwitchAgent={switchAgent ?? undefined}
					/>
				</div>
				<p className="sr-only" aria-live="polite" data-testid="chat-announcer">
					{announcement(state)}
				</p>
			</div>
		</ChatAgentContext.Provider>
	);
}
