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
	useEffect,
	useId,
	useImperativeHandle,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { useStore } from "zustand";
import { useChatAgent } from "./chatAgent.js";
import { type ChatState, type ChatStore, sideBusy } from "./chatStore.js";
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
function statusText(side: ChatState | null, running: boolean): string {
	if (running) return "The side question is running.";
	if (side === null) return "";
	const last = Object.values(side.turns).at(-1);
	if (last?.status === "done") return "Side answer ready.";
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
	const running = useStore(store, sideBusy);
	const ids = useId();
	const log = useRef<HTMLDivElement | null>(null);
	const content = useRef<HTMLDivElement | null>(null);
	const stop = useRef<HTMLButtonElement | null>(null);
	const follow = useFollowEnd(log, content, true);
	const [draft, setDraft] = useState("");
	const [error, setError] = useState("");
	const items = side?.items ?? [];
	/**
	 * What the live region says. A replay starts from an empty snapshot, so its
	 * passing blank is skipped: a finished answer is not spoken again (SPEC.md §25.8).
	 */
	const spoken = useRef("");
	const status = statusText(side, running);
	const rebuilding = side !== null && Object.keys(side.turns).length === 0;
	if (status !== "" || !rebuilding) spoken.current = status;

	/**
	 * The keyboard sat on a control inside the log. A replay empties the list
	 * and may swap it for the empty-state paragraph, and removing the focused
	 * node reports no new target (a browser may still fire a blur for it), so
	 * focus is recorded here and the move is made after the items change
	 * (SPEC.md §25.8). It is forgotten when focus goes to another element or
	 * the student presses on the page outside the log.
	 */
	const inLog = useRef(false);
	useEffect(() => {
		const node = log.current;
		if (!node) return;
		const onFocusIn = () => {
			inLog.current = true;
		};
		const onFocusOut = (event: FocusEvent) => {
			const next = event.relatedTarget;
			if (next instanceof Node && !node.contains(next)) inLog.current = false;
		};
		const onPointerDown = (event: PointerEvent) => {
			if (!(event.target instanceof Node && node.contains(event.target)))
				inLog.current = false;
		};
		node.addEventListener("focusin", onFocusIn);
		node.addEventListener("focusout", onFocusOut);
		document.addEventListener("pointerdown", onPointerDown, true);
		return () => {
			node.removeEventListener("focusin", onFocusIn);
			node.removeEventListener("focusout", onFocusOut);
			document.removeEventListener("pointerdown", onPointerDown, true);
		};
	}, []);

	/**
	 * The box had the keyboard as its question went. It is disabled while the
	 * question runs, so the keyboard waits on Stop and comes back after (SPEC.md §25.8).
	 */
	const typing = useRef(false);
	const box = useRef<HTMLTextAreaElement | null>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: runs whenever the conversation changes
	useLayoutEffect(() => {
		follow.arrived();
		if (!inLog.current) return;
		const active = document.activeElement;
		if (active !== null && active !== document.body) return;
		inLog.current = false;
		// Where the pane's own handle puts it: Stop while a question runs, else the box.
		(running ? stop.current : box.current)?.focus({ preventScroll: true });
	}, [side?.items]);

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
	const waitId = `${ids}-wait`;
	const emptyId = `${ids}-empty`;
	const empty = draft.trim() === "";
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
						aria-describedby={
							[running ? waitId : "", error !== "" ? errorId : ""].join(" ").trim() ||
							undefined
						}
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
							aria-disabled={running || empty || undefined}
							aria-describedby={running ? waitId : empty ? emptyId : undefined}
						/>
					</div>
				</div>
				{running ? (
					<span id={waitId} hidden={true}>
						Wait for the answer, or stop it, before asking again.
					</span>
				) : empty ? (
					<span id={emptyId} hidden={true}>
						Type a side question first.
					</span>
				) : null}
				{error !== "" ? (
					<p id={errorId} className="pk-side-error" role="alert">
						{error}
					</p>
				) : null}
			</form>
			<p className="sr-only" aria-live="polite" data-testid="side-announcer">
				{spoken.current}
			</p>
		</section>
	);
}
