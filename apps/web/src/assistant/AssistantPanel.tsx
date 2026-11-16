/**
 * The built-in assistant, as a side panel beside the page (SPEC.md
 * section 20). It lists the person's own conversations, newest first, and
 * shows one at a time with the student chat's message list and tool
 * blocks. Changes wait on an approval card the server draws from the
 * catalog. Focus moves in on open and back to the Assistant button on
 * close; Escape closes it (SPEC.md section 25.8).
 */
import type {
	ChatCardDecision,
	ChatOpenCard,
	ConversationSummary,
} from "@portikus/contracts";
import {
	Button,
	ConfirmDialog,
	ConfirmDialogRoot,
	Icon,
	IconButton,
	Skeleton,
} from "@portikus/ui";
import { Link } from "@tanstack/react-router";
import { type RefObject, useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "zustand";
import { errorText } from "../api/request.js";
import { ChatSpeakerContext } from "../chat/chatAgent.js";
import type { ChatState } from "../chat/chatStore.js";
import { MessageList } from "../chat/MessageList.js";
import { useMe } from "../useMe.js";
import { ApprovalCard, type ApprovalCardData, approvalTitle } from "./ApprovalCard.js";
import { AssistantComposer } from "./AssistantComposer.js";
import { useAssistant } from "./AssistantContext.js";
import {
	isNotEnabled,
	notEnabledText,
	useAssistantConversation,
	useAssistantStatus,
	useConversations,
	useCreateConversation,
	useDeleteConversation,
} from "./useAssistant.js";
import "../chat/chat.css";
import "./assistant.css";

/** The header button that opens and closes the panel. */
export function AssistantButton() {
	const assistant = useAssistant();
	return (
		<button
			ref={assistant.launcher}
			type="button"
			className="pk-wsbutton"
			aria-expanded={assistant.isOpen}
			aria-controls={assistant.isOpen ? PANEL_ID : undefined}
			data-testid="assistant-button"
			// A narrow bar shows only the icon; the name stays.
			aria-label="Assistant"
			onClick={() => (assistant.isOpen ? assistant.close() : assistant.open())}
		>
			<Icon name="agent" size="sm" />
			<span className="@max-[30rem]:hidden">Assistant</span>
		</button>
	);
}

const PANEL_ID = "pk-assistant-panel";

const DATE = new Intl.DateTimeFormat(undefined, {
	dateStyle: "medium",
	timeStyle: "short",
});

export function AssistantPanel({ courseId }: { courseId?: string }) {
	const assistant = useAssistant();
	const me = useMe();
	const isAdmin = me.status === "authenticated" && me.user.role === "administrator";
	const heading = useRef<HTMLHeadingElement>(null);
	const panel = useRef<HTMLElement>(null);
	const status = useAssistantStatus(assistant.isOpen);
	const enabled = status.data?.enabled === true;
	const conversations = useConversations(assistant.isOpen && enabled);
	const create = useCreateConversation();
	const [chosen, setChosen] = useState<ConversationSummary | null>(null);
	const [startError, setStartError] = useState<unknown>(null);
	const { pending, takePending } = assistant;

	useEffect(() => {
		if (assistant.isOpen) heading.current?.focus();
	}, [assistant.isOpen]);

	function start(body: {
		context?: ConversationSummary["context"];
		courseId?: string;
	}) {
		setStartError(null);
		create.mutate(
			{
				...(body.context ? { context: body.context } : {}),
				...(body.courseId ? { courseId: body.courseId } : {}),
			},
			{
				onSuccess: (summary) => setChosen(summary),
				onError: (error) => setStartError(error),
			},
		);
	}

	// A Diagnose button asked for a conversation about its item.
	// biome-ignore lint/correctness/useExhaustiveDependencies: acts once per start, when the status is known
	useEffect(() => {
		if (!pending || !status.data) return;
		takePending();
		if (!status.data.enabled) return;
		start({ context: pending.context, courseId: pending.courseId ?? courseId });
	}, [pending, status.data]);

	useEscapeCloses(panel, assistant.isOpen, assistant.close);

	if (!assistant.isOpen) return null;

	// The list's copy is fresher (the server names a conversation after its first message).
	const active = chosen
		? (conversations.data?.find((one) => one.id === chosen.id) ?? chosen)
		: null;
	const off = status.data && !status.data.enabled ? notEnabledText(status.data) : null;
	const refused = isNotEnabled(startError) ? errorText(startError) : null;

	return (
		<aside
			ref={panel}
			id={PANEL_ID}
			className="pk-assistant"
			aria-labelledby="pk-assistant-title"
			data-testid="assistant-panel"
			data-density="compact"
			data-controls="console"
		>
			<header className="pk-assistant-head">
				<h2
					id="pk-assistant-title"
					ref={heading}
					tabIndex={-1}
					className="pk-assistant-title"
				>
					Assistant
				</h2>
				{enabled ? (
					<Button
						variant="secondary"
						size="sm"
						loading={create.isPending}
						data-testid="assistant-new"
						onClick={() => start({ courseId })}
					>
						<Icon name="plus" size="sm" />
						New conversation
					</Button>
				) : null}
				<IconButton
					icon="x"
					label="Close the assistant"
					size="sm"
					onClick={assistant.close}
				/>
			</header>
			{status.isPending ? (
				<div className="pk-assistant-pad" aria-busy="true">
					<Skeleton lines={3} />
				</div>
			) : status.isError ? (
				<p className="pk-assistant-pad" role="alert">
					{errorText(
						status.error,
						"The assistant could not be reached. Reload the page to try again.",
					)}
				</p>
			) : off || refused ? (
				<NotEnabled text={off ?? refused ?? ""} isAdmin={isAdmin} />
			) : active ? (
				<ConversationView
					key={active.id}
					summary={active}
					onBack={() => setChosen(null)}
				/>
			) : (
				<ConversationIndex
					conversations={conversations.data}
					loading={conversations.isPending}
					error={conversations.isError || (startError !== null && !refused)}
					onOpen={setChosen}
				/>
			)}
		</aside>
	);
}

/**
 * Escape closes the panel from anywhere in it, including after the
 * focused control was removed (an answered card, a deleted row) and focus
 * fell back to the page body. A confirm opened from the panel sits in a
 * portal and closes itself.
 */
function useEscapeCloses(
	panel: RefObject<HTMLElement | null>,
	open: boolean,
	close: () => void,
) {
	useEffect(() => {
		if (!open) return;
		let inside = true;
		const within = (target: EventTarget | null) =>
			target instanceof Node && panel.current?.contains(target) === true;
		const onPointer = (event: PointerEvent) => {
			inside = within(event.target);
		};
		const onFocus = (event: FocusEvent) => {
			inside = within(event.target);
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape" || event.defaultPrevented) return;
			const lost = event.target === document.body && inside;
			if (!within(event.target) && !lost) return;
			event.preventDefault();
			close();
		};
		document.addEventListener("pointerdown", onPointer, true);
		document.addEventListener("focusin", onFocus);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("pointerdown", onPointer, true);
			document.removeEventListener("focusin", onFocus);
			document.removeEventListener("keydown", onKey);
		};
	}, [panel, open, close]);
}

function NotEnabled({ text, isAdmin }: { text: string; isAdmin: boolean }) {
	return (
		<div className="pk-assistant-pad pk-assistant-off" data-testid="assistant-off">
			<p>{text}</p>
			{isAdmin ? (
				<Link
					to="/admin/$tab"
					params={{ tab: "ai" }}
					className="pk-link"
					data-testid="assistant-settings-link"
				>
					AI settings
				</Link>
			) : null}
		</div>
	);
}

function ConversationIndex({
	conversations,
	loading,
	error,
	onOpen,
}: {
	conversations: ConversationSummary[] | undefined;
	loading: boolean;
	error: boolean;
	onOpen: (conversation: ConversationSummary) => void;
}) {
	const remove = useDeleteConversation();
	const [deleting, setDeleting] = useState<ConversationSummary | null>(null);
	if (loading) {
		return (
			<div className="pk-assistant-pad" aria-busy="true">
				<Skeleton lines={4} />
			</div>
		);
	}
	return (
		<section className="pk-assistant-index" aria-labelledby="pk-assistant-list-title">
			<h3 id="pk-assistant-list-title" className="pk-assistant-subtitle">
				Conversations
			</h3>
			{error ? (
				<p role="alert" className="pk-assistant-card-error">
					Something went wrong. Try again.
				</p>
			) : null}
			{conversations && conversations.length > 0 ? (
				<ul className="pk-assistant-list" data-testid="assistant-conversations">
					{conversations.map((one) => (
						<li
							key={one.id}
							className="pk-assistant-row"
							data-testid="assistant-conversation"
						>
							<button
								type="button"
								className="pk-assistant-open pk-focus-ring"
								onClick={() => onOpen(one)}
							>
								<span className="pk-assistant-row-title">
									{one.title || "New conversation"}
								</span>
								<time className="pk-assistant-muted" dateTime={one.lastActiveAt}>
									{DATE.format(new Date(one.lastActiveAt))}
								</time>
							</button>
							<IconButton
								icon="trash"
								size="sm"
								label={`Delete ${one.title || "conversation"}`}
								data-testid="assistant-delete"
								onClick={() => setDeleting(one)}
							/>
						</li>
					))}
				</ul>
			) : (
				<p className="pk-assistant-muted" data-testid="assistant-empty">
					No conversations yet. Start one with New conversation. The assistant can read
					this site's users, workspaces, health and logs; any change waits for your
					approval.
				</p>
			)}
			<ConfirmDialogRoot
				open={deleting !== null}
				onOpenChange={(open) => !open && setDeleting(null)}
			>
				{deleting ? (
					<ConfirmDialog
						id="assistant-delete-confirm"
						testId="assistant-delete-confirm"
						title="Delete this conversation?"
						description={`"${deleting.title || "New conversation"}" and its history are removed for good.`}
						confirmLabel="Delete conversation"
						pending={remove.isPending}
						onConfirm={() =>
							remove.mutate(deleting.id, { onSettled: () => setDeleting(null) })
						}
					/>
				) : null}
			</ConfirmDialogRoot>
		</section>
	);
}

const CONNECTION_TEXT: Partial<Record<ChatState["connection"], string>> = {
	reconnecting: "Reconnecting…",
	lost: "The assistant lost its connection. Reload the page to try again.",
	tooMany:
		"You have too many chats and terminals open. Close some, then reload the page.",
	notFound: "This conversation no longer exists. Go back and start a new one.",
};

/** What the live region says; the list itself is not live, so streamed text is not read word by word. */
function assistantAnnouncement(state: ChatState): string {
	const card = state.cards[0];
	if (card?.type === "permission") return `Approval needed: ${approvalTitle(card)}.`;
	if (state.currentTurnId !== null) return "The assistant is working.";
	const last = Object.values(state.turns).at(-1);
	if (last?.status === "done") return "The assistant replied.";
	if (last?.status === "interrupted") return "The assistant stopped.";
	if (last?.status === "error") return "The assistant's turn failed.";
	return "";
}

function isPermission(card: ChatOpenCard): card is ApprovalCardData {
	return card.type === "permission";
}

/** The card answered last, kept in view with its outcome until the next card or message. */
function useResolvedCard(store: ReturnType<typeof useAssistantConversation>["store"]) {
	const [resolved, setResolved] = useState<{
		card: ApprovalCardData;
		decision: ChatCardDecision;
	} | null>(null);
	useEffect(
		() =>
			store.subscribe((state, previous) => {
				if (
					state.cards.length > previous.cards.length ||
					state.lastUserMessageSeq !== previous.lastUserMessageSeq
				) {
					setResolved(null);
				}
				for (const card of previous.cards) {
					if (!isPermission(card) || state.cards.some((open) => open.id === card.id))
						continue;
					const decision = state.decisions[card.id];
					if (decision) setResolved({ card, decision });
				}
			}),
		[store],
	);
	return resolved;
}

function ConversationView({
	summary,
	onBack,
}: {
	summary: ConversationSummary;
	onBack: () => void;
}) {
	const { store, answer } = useAssistantConversation(summary.id);
	const state = useStore(store);
	const resolved = useResolvedCard(store);
	const cards = state.cards.filter(isPermission);
	const card = cards[0];
	const asking = useMemo(() => new Set(cards.map((one) => one.id)), [cards]);
	const running = state.currentTurnId !== null;
	const notice = CONNECTION_TEXT[state.connection];
	const scroll = useRef<HTMLDivElement>(null);
	const section = useRef<HTMLElement>(null);
	const lastCard = useRef<string | undefined>(undefined);

	// An answered card takes its buttons with it; keep the keyboard in the panel, at the message box.
	useEffect(() => {
		const was = lastCard.current;
		lastCard.current = card?.id;
		if (was === undefined || card !== undefined) return;
		const active = document.activeElement;
		if (active && active !== document.body && active.isConnected) return;
		section.current?.querySelector("textarea")?.focus();
	}, [card]);

	// Keep the newest step in view as it streams in.
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs as the log grows
	useEffect(() => {
		const box = scroll.current;
		if (box) box.scrollTop = box.scrollHeight;
	}, [state.items, state.cards]);

	return (
		<section
			ref={section}
			className="pk-assistant-conversation"
			aria-labelledby="pk-assistant-conv-title"
		>
			<div className="pk-assistant-conv-head">
				<IconButton
					icon="arrow-left"
					size="sm"
					label="All conversations"
					onClick={onBack}
					data-testid="assistant-back"
				/>
				<h3
					id="pk-assistant-conv-title"
					className="pk-assistant-subtitle pk-assistant-conv-title"
				>
					{summary.title || "New conversation"}
				</h3>
			</div>
			{summary.readOnly ? (
				<p className="pk-assistant-muted pk-assistant-pad-inline">
					This conversation can only read. It cannot change anything.
				</p>
			) : null}
			<div className="pk-chat pk-assistant-chat">
				<div className="pk-chat-main">
					<div ref={scroll} className="pk-chat-scroll" data-testid="assistant-scroll">
						{!state.loaded ? (
							<div aria-busy="true">
								<span className="sr-only">Loading the conversation…</span>
								<Skeleton lines={3} width="60%" />
							</div>
						) : state.items.length === 0 && !running ? (
							<p className="pk-assistant-muted" data-testid="assistant-conv-empty">
								Ask a question below. The assistant reads what it needs and asks before
								it changes anything.
							</p>
						) : (
							<ChatSpeakerContext.Provider value="Assistant">
								<MessageList
									items={state.items}
									turns={state.turns}
									currentTurnId={state.currentTurnId}
									truncated={state.truncated}
									asking={asking}
								/>
							</ChatSpeakerContext.Provider>
						)}
					</div>
				</div>
				{notice ? (
					<p
						className="pk-assistant-notice"
						role="status"
						data-testid="assistant-connection"
					>
						{notice}
					</p>
				) : null}
				{card || resolved ? (
					<div className="pk-chat-cards" data-testid="assistant-cards">
						{card ? (
							<ApprovalCard
								key={`${card.id}:${state.snapshotAt}`}
								card={card}
								autoFocus
								waiting={cards.length - 1}
								onAnswer={(optionId, confirmation) =>
									answer(card.id, optionId, confirmation)
								}
							/>
						) : resolved ? (
							<ApprovalCard
								key={`${resolved.card.id}:resolved`}
								card={resolved.card}
								decision={resolved.decision}
								onAnswer={() => false}
							/>
						) : null}
					</div>
				) : null}
				<div className="pk-chat-composer">
					<AssistantComposer
						running={running}
						disabled={state.connection !== "open"}
						disabledReason={
							state.connection === "open" ? undefined : "Waiting for the connection."
						}
						onSend={(text) => store.getState().send(text, [])}
						onStop={() => store.getState().interrupt()}
					/>
				</div>
			</div>
			<p className="sr-only" aria-live="polite" data-testid="assistant-announcer">
				{assistantAnnouncement(state)}
			</p>
		</section>
	);
}
