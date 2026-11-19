/**
 * The side conversation beside a chat (SPEC.md §10.2, ADR 0083): quick
 * questions about the conversation, answered while a turn runs without
 * joining or steering it. The host folds its `side` frames into the chat
 * store's `side` state, which this draws with the chat's own MessageList.
 * Its composer takes plain text, one question at a time, and is disabled
 * while one runs; Stop ends that question and Close forgets the
 * conversation. The pane is a labelled region (SPEC.md §25.8).
 */
import { MAX_CHAT_SIDE_TEXT_CHARS } from "@portikus/contracts";
import { IconButton } from "@portikus/ui";
import {
	type FormEvent,
	type RefObject,
	useId,
	useImperativeHandle,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { useStore } from "zustand";
import { useChatAgent } from "./chatAgent.js";
import type { ChatState, ChatStore } from "./chatStore.js";
import { type FileOpener, MessageList } from "./MessageList.js";
import { useFollowEnd } from "./useFollowEnd.js";
import "./side.css";

/** No permission card is ever asked from the side conversation. */
const NONE_ASKED: ReadonlySet<string> = new Set();

const COUNT = new Intl.NumberFormat("en");

export const sideTooLong = (length: number) =>
	`Your side question is ${COUNT.format(length)} characters long, over the limit of ${COUNT.format(MAX_CHAT_SIDE_TEXT_CHARS)}. Shorten it and ask again.`;

export const SIDE_NOT_SENT =
	"Your side question was not sent. Check the connection, then ask again.";

export const SIDE_BUSY =
	"A side question is still running. Wait for its answer, or stop it, before asking another.";

/** What the chat can do with the pane: put the keyboard in it as it opens. */
export interface SidePanelHandle {
	focus: () => void;
}

/** What the pane says politely of its question as it changes. */
function statusText(side: ChatState | null, name: string): string {
	if (side === null) return "";
	if (side.currentTurnId !== null) return `${name} is answering.`;
	const last = Object.values(side.turns).at(-1);
	if (last?.status === "done") return `${name} answered.`;
	if (last?.status === "interrupted") return "The side question was stopped.";
	if (last?.status === "error") return "The side question failed.";
	return "";
}

export function SidePanel({
	store,
	chatName,
	opener,
	handle,
	onClose,
}: {
	store: ChatStore;
	/** The chat's name, as the project list shows it. */
	chatName: string;
	opener: FileOpener | null;
	handle: RefObject<SidePanelHandle | null>;
	onClose: () => void;
}) {
	const { agent, name } = useChatAgent();
	const side = useStore(store, (state) => state.side);
	const waiting = useStore(store, (state) => state.sideWaiting);
	const ids = useId();
	const log = useRef<HTMLDivElement | null>(null);
	const content = useRef<HTMLDivElement | null>(null);
	const stop = useRef<HTMLButtonElement | null>(null);
	const follow = useFollowEnd(log, content, true);
	const [draft, setDraft] = useState("");
	const [error, setError] = useState("");
	const running = waiting || (side !== null && side.currentTurnId !== null);
	const items = side?.items ?? [];

	// biome-ignore lint/correctness/useExhaustiveDependencies: runs whenever the conversation changes
	useLayoutEffect(() => {
		follow.arrived();
	}, [side?.items]);

	/**
	 * The box had the keyboard as its question went. It is disabled while the
	 * question runs, so the keyboard waits on Stop and comes back after (SPEC.md §25.8).
	 */
	const typing = useRef(false);
	const box = useRef<HTMLTextAreaElement | null>(null);
	// Into the box, or onto Stop while a question runs, to come back to the box after.
	useImperativeHandle(
		handle,
		() => ({
			focus: () => {
				typing.current = running;
				(running ? stop.current : box.current)?.focus({ preventScroll: true });
			},
		}),
		[running],
	);
	useLayoutEffect(() => {
		if (!typing.current) return;
		if (running) {
			stop.current?.focus({ preventScroll: true });
			return;
		}
		typing.current = false;
		const active = document.activeElement;
		if (active === null || active === document.body)
			box.current?.focus({ preventScroll: true });
	}, [running]);

	function ask(event?: FormEvent) {
		event?.preventDefault();
		if (running) return;
		const text = draft.trim();
		if (text === "") return;
		if (text.length > MAX_CHAT_SIDE_TEXT_CHARS) {
			setError(sideTooLong(text.length));
			return;
		}
		typing.current = document.activeElement === box.current;
		if (!store.getState().askSide(text)) {
			typing.current = false;
			setError(SIDE_NOT_SENT);
			return;
		}
		setError("");
		setDraft("");
	}

	const headingId = `${ids}-title`;
	const errorId = `${ids}-error`;
	return (
		<section className="pk-side" aria-labelledby={headingId} data-testid="side-panel">
			<div className="pk-side-head">
				<h2 id={headingId} className="pk-side-title" title={`Side: ${chatName}`}>
					<span className="pk-side-kind">Side:</span> {chatName}
				</h2>
				<IconButton
					icon="x"
					label="Close the side conversation"
					size="sm"
					data-testid="side-close"
					onClick={onClose}
				/>
			</div>
			<p className="pk-side-note">
				{agent === "codex"
					? `${name} answers from this chat and may run read-only commands. Nothing here joins the chat or changes your files.`
					: `${name} answers from this chat, without tools. Nothing here joins the chat or changes your files.`}
			</p>
			<div
				ref={log}
				className="pk-chat-scroll pk-side-scroll"
				data-testid="side-scroll"
				onScroll={follow.onScroll}
			>
				<div ref={content} className="pk-chat-column">
					{items.length === 0 && !running ? (
						<p className="pk-chat-muted" data-testid="side-empty">
							Ask a quick question about the chat, even while {name} is working.
						</p>
					) : (
						<MessageList
							items={items}
							turns={side?.turns ?? {}}
							currentTurnId={side?.currentTurnId ?? null}
							truncated={false}
							asking={NONE_ASKED}
							opener={opener}
						/>
					)}
				</div>
			</div>
			<form className="pk-side-form" onSubmit={ask}>
				<div className="pk-composer pk-side-composer">
					<label htmlFor={`${ids}-text`} className="sr-only">
						Side question
					</label>
					<textarea
						ref={box}
						id={`${ids}-text`}
						className="pk-composer-text pk-side-text"
						data-testid="side-composer"
						rows={1}
						placeholder={`Ask ${name} on the side`}
						value={draft}
						disabled={running}
						aria-invalid={error !== "" || undefined}
						aria-describedby={error !== "" ? errorId : undefined}
						onChange={(event) => setDraft(event.target.value)}
						onKeyDown={(event) => {
							if (
								event.key !== "Enter" ||
								event.shiftKey ||
								event.altKey ||
								event.ctrlKey ||
								event.metaKey ||
								event.nativeEvent.isComposing
							)
								return;
							event.preventDefault();
							ask();
						}}
					/>
					<div className="pk-side-actions">
						{running ? (
							<IconButton
								ref={stop}
								icon="stop"
								label="Stop the side question"
								variant="secondary"
								className="pk-composer-send pk-composer-stop"
								data-testid="side-stop"
								onClick={() => store.getState().stopSide()}
							/>
						) : null}
						<IconButton
							type="submit"
							icon="arrow-up"
							label="Ask"
							shortcut={["Enter"]}
							className="pk-composer-send is-send"
							data-testid="side-send"
							// Stays focusable while a question runs, and says why (SPEC.md §25.8).
							aria-disabled={running || undefined}
							aria-describedby={running ? `${ids}-wait` : undefined}
						/>
					</div>
				</div>
				{running ? (
					<span id={`${ids}-wait`} hidden={true}>
						Wait for the answer, or stop it, before asking again.
					</span>
				) : null}
				{error !== "" ? (
					<p id={errorId} className="pk-side-error" role="alert">
						{error}
					</p>
				) : null}
			</form>
			<p className="sr-only" aria-live="polite" data-testid="side-announcer">
				{statusText(side, name)}
			</p>
		</section>
	);
}
