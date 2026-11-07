/**
 * The chat's message box (SPEC.md §8.3, §10.8): a growing textarea, attached
 * files, the settings pickers and the microphone. Enter sends, Shift+Enter
 * starts a line; while a turn runs the button stops it instead. Dictation
 * is typed into the box and never sent on its own (SPEC.md §25.10). The
 * draft is cleared only when the host echoes the message back, so a send it
 * refuses leaves the text and files in place to try again.
 */
import { MAX_CHAT_TEXT_CHARS } from "@portikus/contracts";
import { Button, IconButton } from "@portikus/ui";
import {
	type ClipboardEvent,
	type DragEvent,
	type FormEvent,
	useCallback,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { useStore } from "zustand";
import { endsVoiceShortcut, isVoiceShortcut } from "../voice/shortcut.js";
import { useSpeechInput } from "../voice/useSpeechInput.js";
import { VoiceButton } from "../voice/VoiceButton.js";
import { ComposerChips } from "./ComposerChips.js";
import { BYPASS_WARNING, ComposerPickers } from "./ComposerPickers.js";
import type { ChatStore } from "./chatStore.js";
import { useComposerAttachments } from "./composerAttachments.js";
import "./composer.css";
import { Icon } from "@portikus/ui";

const NOT_SENT = "Your message was not sent because the chat is not connected.";
const VOICE_HINT =
	"Hold Space on this button, or Alt+Shift+M in the message box, to talk.";
const BYPASS_ON = `Bypass permissions is on. ${BYPASS_WARNING}`;

/** A message sent and not yet echoed back by the host. */
interface Sending {
	/** The store's last `seq` when it was sent; the echo comes after it. */
	seq: number;
	text: string;
	keys: string[];
}

export interface ComposerProps {
	store: ChatStore;
	workspaceId: string;
	projectId: string;
	terminalId: string;
}

export function Composer({ store, workspaceId, projectId, terminalId }: ComposerProps) {
	const ids = useId();
	const settings = useStore(store, (state) => state.settings);
	const running = useStore(store, (state) => state.currentTurnId !== null);
	const echoed = useStore(store, (state) => state.lastUserMessageSeq);
	const lastError = useStore(store, (state) => state.lastError);
	const connection = useStore(store, (state) => state.connection);
	const [sending, setSending] = useState<Sending | null>(null);
	const [announced, setAnnounced] = useState("");
	const [text, setText] = useState("");
	const [error, setError] = useState("");
	const [dragging, setDragging] = useState(false);
	const area = useRef<HTMLTextAreaElement | null>(null);
	const picker = useRef<HTMLInputElement | null>(null);
	const textNow = useRef(text);
	textNow.current = text;
	const caret = useRef<number | null>(null);
	const files = useComposerAttachments(workspaceId, projectId);
	const clearFiles = files.clear;
	const bypass = settings?.mode === "bypassPermissions";

	// The echo of the student's own message ends the send; text typed since stays.
	useEffect(() => {
		if (!sending) return;
		if (echoed > sending.seq) {
			if (textNow.current === sending.text) setText("");
			clearFiles(sending.keys);
			setSending(null);
		} else if (lastError && lastError.seq > sending.seq) {
			// The error shows in the conversation; the draft stays to send again.
			setSending(null);
		}
	}, [echoed, lastError, sending, clearFiles]);

	// A new socket may never echo a send the old one carried.
	// biome-ignore lint/correctness/useExhaustiveDependencies: only when the connection changes
	useEffect(() => {
		setSending(null);
	}, [connection]);

	useEffect(() => {
		if (bypass) setAnnounced(BYPASS_ON);
	}, [bypass]);

	const announce = useCallback((text: string) => setAnnounced(text), []);

	useEffect(() => {
		if (files.status !== "") setAnnounced(files.status);
	}, [files.status]);

	const speech = useSpeechInput((words) => insertAtCursor(words));
	const stopSpeech = speech.stop;

	/** Dictated words go where the cursor is, set apart by a space. */
	function insertAtCursor(words: string) {
		const value = textNow.current;
		const start = area.current?.selectionStart ?? value.length;
		const end = area.current?.selectionEnd ?? start;
		const before = value.slice(0, start);
		const lead = before !== "" && !/\s$/.test(before) ? " " : "";
		const next = (before + lead + words + value.slice(end)).slice(
			0,
			MAX_CHAT_TEXT_CHARS,
		);
		textNow.current = next;
		caret.current = Math.min((before + lead + words).length, next.length);
		setText(next);
	}

	// Grow with the text, and put the cursor back after dictation.
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs when the text changes
	useLayoutEffect(() => {
		const box = area.current;
		if (!box) return;
		box.style.blockSize = "auto";
		box.style.blockSize = `${box.scrollHeight}px`;
		if (caret.current !== null) {
			box.setSelectionRange(caret.current, caret.current);
			caret.current = null;
		}
	}, [text]);

	function submit(event?: FormEvent) {
		event?.preventDefault();
		if (files.saving > 0 || sending) return;
		if (text.trim() === "" && files.items.length === 0) return;
		const attachments = files.items.map((item) => ({ path: item.path }));
		const seq = store.getState().lastSeq;
		if (!store.getState().send(text, attachments)) {
			setError(NOT_SENT);
			return;
		}
		stopSpeech();
		setError("");
		setSending({ seq, text, keys: files.items.map((item) => item.key) });
	}

	function onPaste(event: ClipboardEvent) {
		const pasted = Array.from(event.clipboardData.files);
		if (pasted.length === 0) return;
		event.preventDefault();
		void files.add(
			pasted.map((file) =>
				file.name
					? file
					: new File([file], `pasted.${file.type.split("/")[1] ?? "png"}`, {
							type: file.type,
						}),
			),
		);
	}

	function focusText() {
		area.current?.focus();
	}

	function hasFiles(event: DragEvent): boolean {
		return event.dataTransfer.types.includes("Files");
	}

	return (
		<>
			<form
				className={`pk-composer ${dragging ? "is-dragging" : ""}`}
				data-testid="chat-composer"
				onSubmit={submit}
				onDragOver={(event) => {
					if (!hasFiles(event)) return;
					event.preventDefault();
					event.dataTransfer.dropEffect = "copy";
					setDragging(true);
				}}
				onDragLeave={(event) => {
					const next = event.relatedTarget;
					if (next instanceof Node && event.currentTarget.contains(next)) return;
					setDragging(false);
				}}
				onDrop={(event) => {
					setDragging(false);
					if (!hasFiles(event)) return;
					event.preventDefault();
					// The list empties once the handler returns.
					void files.add(Array.from(event.dataTransfer.files));
				}}
			>
				<ComposerChips
					items={files.items}
					saving={files.saving}
					onRemove={files.remove}
					onEmptied={focusText}
				/>
				<label htmlFor={`${ids}-text`} className="sr-only">
					Message Claude Code
				</label>
				<textarea
					ref={area}
					id={`${ids}-text`}
					className="pk-composer-text"
					rows={1}
					maxLength={MAX_CHAT_TEXT_CHARS}
					value={text}
					placeholder="Message Claude Code, or paste or drop images"
					data-testid="chat-composer-input"
					onChange={(event) => setText(event.target.value)}
					onPaste={onPaste}
					onKeyDown={(event) => {
						if (isVoiceShortcut(event.nativeEvent)) {
							event.preventDefault();
							if (!event.repeat) speech.start();
							return;
						}
						if (
							event.key === "Enter" &&
							!event.shiftKey &&
							!event.nativeEvent.isComposing
						) {
							event.preventDefault();
							submit();
						}
					}}
					onKeyUp={(event) => {
						if (speech.state === "listening" && endsVoiceShortcut(event.nativeEvent)) {
							stopSpeech();
						}
					}}
				/>
				<div className="pk-composer-bar">
					<div className="pk-composer-tools">
						<input
							ref={picker}
							type="file"
							multiple={true}
							hidden={true}
							data-testid="chat-composer-file"
							onChange={(event) => {
								void files.add(Array.from(event.target.files ?? []));
								// The same file can be chosen again.
								event.target.value = "";
							}}
						/>
						<IconButton
							icon="plus"
							size="sm"
							label="Attach files"
							data-testid="chat-composer-attach"
							onClick={() => picker.current?.click()}
						/>
						<VoiceButton
							testId={`chat-voice-${terminalId}`}
							statusTestId={`chat-voice-status-${terminalId}`}
							label="Hold to talk"
							hint={VOICE_HINT}
							voice={speech}
							focusTarget={() => area.current?.focus()}
						/>
					</div>
					<ComposerPickers
						settings={settings}
						lastError={lastError}
						warningId={`${ids}-bypass`}
						onSet={(next) => store.getState().set(next)}
						onAnnounce={announce}
					/>
					{running ? (
						<Button
							variant="secondary"
							iconStart="stop"
							data-testid="chat-composer-stop"
							onClick={() => store.getState().interrupt()}
						>
							Stop
						</Button>
					) : (
						<Button
							type="submit"
							variant="primary"
							data-testid="chat-composer-send"
							// Stays focusable while files save; submit waits for them (SPEC.md §25.8).
							aria-disabled={files.saving > 0 || sending !== null || undefined}
							aria-describedby={files.saving > 0 ? `${ids}-saving` : undefined}
						>
							Send
						</Button>
					)}
					{files.saving > 0 ? (
						<span id={`${ids}-saving`} hidden={true}>
							Wait for the files to finish saving.
						</span>
					) : null}
				</div>
				{speech.interim !== "" ? (
					// Shown only: the status region says "Listening…" instead of reading every guess.
					<p
						className="pk-composer-note"
						aria-hidden="true"
						data-testid="chat-voice-interim"
					>
						{speech.interim}
					</p>
				) : null}
				{speech.state !== "listening" && speech.message !== "" ? (
					<p className="pk-composer-note" aria-hidden="true">
						{speech.message}
					</p>
				) : null}
				<p
					className="pk-chat-card-error"
					role="alert"
					data-testid="chat-composer-error"
				>
					{error || files.refusal}
				</p>
			</form>
			{/* One line kept below the box, so the warning never moves the box when it appears. */}
			{bypass ? (
				<p
					id={`${ids}-bypass`}
					className="pk-composer-foot is-warning"
					data-testid="chat-bypass-warning"
				>
					<Icon name="alert" size="sm" />
					{BYPASS_WARNING}
				</p>
			) : (
				<p className="pk-composer-foot">Enter sends. Shift+Enter adds a line.</p>
			)}
			<p
				className="sr-only"
				role="status"
				aria-live="polite"
				data-testid="chat-composer-status"
			>
				{announced}
			</p>
		</>
	);
}
