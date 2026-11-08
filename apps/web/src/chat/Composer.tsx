/**
 * The chat's message box (SPEC.md §8.3, §10.8): a growing Markdown editor
 * (composerEditor.ts), attached files, the settings pickers, the microphone
 * and Send. Enter sends, Shift+Enter starts a line; while a turn runs, Stop
 * sits beside Send. Dictation is typed into the box and never sent on its
 * own (SPEC.md §25.10). The draft is cleared only when the host echoes the
 * message back, so a send it refuses leaves the text and files in place to
 * try again.
 */
import { MAX_CHAT_TEXT_CHARS } from "@portikus/contracts";
import { Icon, IconButton } from "@portikus/ui";
import type { Editor } from "@tiptap/core";
import {
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
import { currentPlatform } from "../platform.js";
import { endsVoiceShortcut, isVoiceShortcut } from "../voice/shortcut.js";
import { useSpeechInput } from "../voice/useSpeechInput.js";
import { VoiceButton } from "../voice/VoiceButton.js";
import { ComposerChips } from "./ComposerChips.js";
import { BYPASS_WARNING, ComposerPickers } from "./ComposerPickers.js";
import type { ChatStore } from "./chatStore.js";
import { useComposerAttachments } from "./composerAttachments.js";
import {
	composerText,
	createComposerEditor,
	inCodeBlock,
	insertAtCursor,
} from "./composerEditor.js";
import "./composer.css";

const NOT_SENT = "Your message was not sent because the chat is not connected.";
const COUNT = new Intl.NumberFormat();
const tooLong = (length: number) =>
	`Your message was not sent because it is ${COUNT.format(length)} characters long, over the limit of ${COUNT.format(MAX_CHAT_TEXT_CHARS)}. Shorten it and send again.`;
const VOICE_HINT =
	"Hold Space on this button, or Alt+Shift+M in the message box, to talk.";
const BYPASS_ON = `Bypass permissions is on. ${BYPASS_WARNING}`;
const PLACEHOLDER = "Message Claude Code, or paste or drop images";
const KEY_HINT = "Enter sends. Shift+Enter adds a line.";
const CODE_HINT = `In code, Enter adds a line. ${currentPlatform() === "mac" ? "Cmd" : "Ctrl"}+Enter sends.`;
const SAVING = "Wait for the files to finish saving.";
const WORKING = "Claude is working. Press Enter in the message box to send this next.";

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
	const [error, setError] = useState("");
	const [dragging, setDragging] = useState(false);
	const [inCode, setInCode] = useState(false);
	const host = useRef<HTMLDivElement | null>(null);
	const editor = useRef<Editor | null>(null);
	const picker = useRef<HTMLInputElement | null>(null);
	const files = useComposerAttachments(workspaceId, projectId);
	const clearFiles = files.clear;
	const bypass = settings?.mode === "bypassPermissions";

	// The echo of the student's own message ends the send; text typed since stays.
	useEffect(() => {
		if (!sending) return;
		if (echoed > sending.seq) {
			const box = editor.current;
			if (box && composerText(box) === sending.text) box.commands.clearContent(true);
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

	const speech = useSpeechInput((words) => {
		if (editor.current) insertAtCursor(editor.current, words);
	});
	const stopSpeech = speech.stop;

	function submit(event?: FormEvent) {
		event?.preventDefault();
		if (files.saving > 0 || sending) return;
		const text = editor.current ? composerText(editor.current) : "";
		if (text.trim() === "" && files.items.length === 0) return;
		if (text.length > MAX_CHAT_TEXT_CHARS) {
			setError(tooLong(text.length));
			return;
		}
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

	function addPasted(pasted: File[]) {
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

	function onKeyDown(event: KeyboardEvent): boolean {
		if (!isVoiceShortcut(event)) return false;
		event.preventDefault();
		if (!event.repeat) speech.start();
		return true;
	}

	function onKeyUp(event: KeyboardEvent) {
		if (speech.state === "listening" && endsVoiceShortcut(event)) stopSpeech();
	}

	// The editor lives outside React; it reaches this render's handlers through here.
	const handlers = useRef({ submit, addPasted, onKeyDown, onKeyUp });
	handlers.current = { submit, addPasted, onKeyDown, onKeyUp };

	useLayoutEffect(() => {
		const element = host.current;
		if (!element) return;
		const made = createComposerEditor({
			element,
			attributes: {
				id: `${ids}-text`,
				role: "textbox",
				"aria-multiline": "true",
				"aria-label": "Message Claude Code",
				"aria-placeholder": PLACEHOLDER,
				// The key hint, or the bypass warning in its place.
				"aria-describedby": `${ids}-hint ${ids}-bypass`,
				class: "pk-composer-text",
				"data-testid": "chat-composer-input",
			},
			placeholder: PLACEHOLDER,
			onSend: () => handlers.current.submit(),
			onFiles: (pasted) => handlers.current.addPasted(pasted),
			onKeyDown: (event) => handlers.current.onKeyDown(event),
			onKeyUp: (event) => handlers.current.onKeyUp(event),
			onChange: (changed) => setInCode(inCodeBlock(changed)),
		});
		editor.current = made;
		return () => {
			editor.current = null;
			made.destroy();
		};
	}, [ids]);

	const focusText = useCallback(() => editor.current?.view.focus(), []);

	function hasFiles(event: DragEvent): boolean {
		return event.dataTransfer.types.includes("Files");
	}

	const waitReason = files.saving > 0 ? SAVING : running ? WORKING : "";

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
				<div ref={host} className="pk-composer-field" />
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
					</div>
					<ComposerPickers
						settings={settings}
						lastError={lastError}
						warningId={`${ids}-bypass`}
						onSet={(next) => store.getState().set(next)}
						onAnnounce={announce}
					/>
					<div className="pk-composer-actions">
						<VoiceButton
							testId={`chat-voice-${terminalId}`}
							statusTestId={`chat-voice-status-${terminalId}`}
							label="Hold to talk"
							hint={VOICE_HINT}
							voice={speech}
							focusTarget={focusText}
						/>
						{running ? (
							<IconButton
								icon="stop"
								label="Stop"
								variant="secondary"
								className="pk-composer-send"
								data-testid="chat-composer-stop"
								onClick={() => store.getState().interrupt()}
							/>
						) : null}
						<IconButton
							type="submit"
							icon="arrow-up"
							label="Send"
							shortcut={["Enter"]}
							className="pk-composer-send is-send"
							data-testid="chat-composer-send"
							// Stays focusable while it waits, and says why (SPEC.md §25.8).
							aria-disabled={waitReason !== "" || sending !== null || undefined}
							aria-describedby={waitReason !== "" ? `${ids}-wait` : undefined}
							onClick={(event) => {
								// A turn is running: Enter in the box still queues the message.
								if (running) event.preventDefault();
							}}
						/>
					</div>
					{waitReason !== "" ? (
						<span id={`${ids}-wait`} hidden={true}>
							{waitReason}
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
				<p
					id={`${ids}-hint`}
					className="pk-composer-foot"
					data-testid="chat-composer-hint"
				>
					{inCode ? CODE_HINT : KEY_HINT}
				</p>
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
