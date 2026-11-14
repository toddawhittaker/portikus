/**
 * A subagent's own conversation, read-only, in a panel over its chat's log
 * (SPEC.md §8.3, §10.8). It watches the subagent through the chat's socket
 * and keeps a store of its own, so the chat's conversation is untouched. A
 * subagent the subagent started opens in the same panel, with Back. A
 * subagent cannot be sent a message from here, so the panel says to ask the
 * agent in the chat instead. A Codex subagent is keyed by its child thread
 * id, where a Claude one is keyed by its Agent tool call. The keyboard moves into the panel as it opens and Escape
 * closes it (SPEC.md §25.8).
 */
import { Button, IconButton, Skeleton } from "@portikus/ui";
import {
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { useStore } from "zustand";
import { useChatAgent } from "./chatAgent.js";
import {
	type ChatState,
	type ChatStore,
	createChatStore,
	receiveChatEvent,
} from "./chatStore.js";
import { type FileOpener, MessageList } from "./MessageList.js";
import { overlayOpen } from "./readAloud.js";
import { SubagentOpenerContext, type SubagentTarget } from "./subagentView.js";
import { useFollowEnd } from "./useFollowEnd.js";
import "./subagent.css";

/** No permission card is ever asked from the view. */
const NONE_ASKED: ReadonlySet<string> = new Set();

function statusText(state: ChatState): string {
	if (!state.loaded) return "";
	if (state.currentTurnId !== null) return "The subagent is working.";
	const last = Object.values(state.turns).at(-1);
	if (last?.status === "done") return "The subagent finished.";
	if (last?.status === "interrupted") return "The subagent was stopped.";
	if (last?.status === "error") return "The subagent failed.";
	return "";
}

/** One subagent's conversation, fed from the chat's socket while it is shown. */
function SubagentConversation({
	chat,
	toolUseId,
	opener,
}: {
	chat: ChatStore;
	toolUseId: string;
	opener: FileOpener | null;
}) {
	// Nothing is ever sent from the view, so its own store has no transport.
	const [store] = useState(() => createChatStore(() => false));
	const state = useStore(store);
	const log = useRef<HTMLDivElement | null>(null);
	const content = useRef<HTMLDivElement | null>(null);
	const follow = useFollowEnd(log, content, true);

	useEffect(() => {
		const watch = () => chat.getState().watchSubagent(toolUseId);
		watch();
		const unsubscribe = chat.subscribe((now, before) => {
			const frame = now.subagentFrame;
			if (frame !== before.subagentFrame && frame?.toolUseId === toolUseId) {
				store.setState((current) => receiveChatEvent(current, frame.event, Date.now()));
			}
			// A new socket knows nothing of the watch, so it is asked again.
			if (now.connection === "open" && before.connection !== "open") watch();
		});
		return () => {
			unsubscribe();
			chat.getState().unwatchSubagent(toolUseId);
		};
	}, [chat, store, toolUseId]);

	// biome-ignore lint/correctness/useExhaustiveDependencies: runs whenever the conversation changes
	useLayoutEffect(() => {
		follow.arrived();
	}, [state.items]);

	const running = state.currentTurnId !== null;
	return (
		<>
			<div
				ref={log}
				className="pk-chat-scroll"
				data-testid="subagent-scroll"
				onScroll={follow.onScroll}
			>
				<div ref={content} className="pk-chat-column">
					{!state.loaded ? (
						<div className="pk-chat-loading">
							<span className="sr-only">Loading the subagent's conversation…</span>
							<Skeleton lines={3} width="60%" />
						</div>
					) : state.items.length === 0 && !running ? (
						<p className="pk-chat-muted" data-testid="subagent-empty">
							Nothing to show for this subagent.
						</p>
					) : (
						<MessageList
							items={state.items}
							turns={state.turns}
							currentTurnId={state.currentTurnId}
							truncated={state.truncated}
							asking={NONE_ASKED}
							opener={opener}
						/>
					)}
				</div>
			</div>
			<p className="sr-only" aria-live="polite" data-testid="subagent-announcer">
				{statusText(state)}
			</p>
		</>
	);
}

export function SubagentPanel({
	chat,
	target,
	opener,
	onClose,
}: {
	chat: ChatStore;
	/** The subagent asked for; a new one starts the panel over. */
	target: SubagentTarget;
	opener: FileOpener | null;
	onClose: () => void;
}) {
	const { agent, name, program } = useChatAgent();
	const [stack, setStack] = useState<SubagentTarget[]>([target]);
	const heading = useRef<HTMLHeadingElement | null>(null);
	const headingId = useId();

	useEffect(() => {
		setStack([target]);
	}, [target]);

	const current = stack.at(-1) ?? target;
	const previous = stack.at(-2);

	// The keyboard starts at the panel's name, for each subagent shown.
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs when another subagent is shown
	useEffect(() => {
		heading.current?.focus({ preventScroll: true });
	}, [current.toolUseId]);

	const open = useCallback((next: SubagentTarget) => {
		setStack((shown) =>
			shown.at(-1)?.toolUseId === next.toolUseId ? shown : [...shown, next],
		);
	}, []);

	return (
		<SubagentOpenerContext.Provider value={open}>
			<section
				className="pk-subagent"
				aria-labelledby={headingId}
				data-testid="subagent-panel"
				data-tool-id={current.toolUseId}
				onKeyDown={(event) => {
					if (event.key !== "Escape" || overlayOpen()) return;
					event.preventDefault();
					event.stopPropagation();
					onClose();
				}}
			>
				<div className="pk-subagent-head">
					{previous ? (
						<Button
							variant="quiet"
							size="sm"
							iconStart="arrow-left"
							aria-label={`Back to ${previous.title}`}
							data-testid="subagent-back"
							onClick={() => setStack((shown) => shown.slice(0, -1))}
						>
							Back
						</Button>
					) : null}
					<h2
						ref={heading}
						id={headingId}
						className="pk-subagent-title"
						tabIndex={-1}
						title={current.title}
					>
						<span className="pk-subagent-kind">Subagent</span> {current.title}
					</h2>
					<IconButton
						icon="x"
						label="Close the subagent view"
						size="sm"
						data-testid="subagent-close"
						onClick={onClose}
					/>
				</div>
				<p className="pk-subagent-note" data-testid="subagent-note">
					{agent === "claude"
						? `Read only. ${program} cannot send a subagent a message; to pass one on, ask ${name} in the chat below.`
						: `Read only. You cannot send a subagent a message here; to pass one on, ask ${name} in the chat below.`}
				</p>
				<SubagentConversation
					key={current.toolUseId}
					chat={chat}
					toolUseId={current.toolUseId}
					opener={opener}
				/>
			</section>
		</SubagentOpenerContext.Provider>
	);
}
