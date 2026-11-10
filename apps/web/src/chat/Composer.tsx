/**
 * The chat's message box (SPEC.md §8.3, §10.8): a growing Markdown editor
 * (composerEditor.ts), attached files, the settings pickers, the microphone
 * and Send. Enter sends, Shift+Enter starts a line; while a turn runs, Stop
 * sits beside Send, a message sent then reaches Claude at its next step, and
 * Escape stops the turn. Up in an empty box brings back the last message
 * sent, held in memory only. A paste of more than LONG_PASTE_LINES lines is
 * attached as a text file instead of filling the box. Dictation is typed
 * into the box and never sent on its own (SPEC.md §25.10). The draft is
 * cleared only when the host echoes the message back, so a send it refuses
 * leaves the text and files in place to try again. `/` at the start lists
 * slash commands and `@` lists project files (ComposerCommandMenu.tsx).
 * While the text starts with `!` it is a shell command: the box wears a
 * "Shell" label and monospace text, says so once, and opens neither menu.
 */
import { MAX_CHAT_TEXT_CHARS } from "@portikus/contracts";
import { Icon, IconButton } from "@portikus/ui";
import type { Editor, JSONContent } from "@tiptap/core";
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
import {
	ComposerCommandMenu,
	optionId,
	selectCommands,
	useComposerMenu,
} from "./ComposerCommandMenu.js";
import { BYPASS_WARNING, ComposerPickers } from "./ComposerPickers.js";
import type { ChatStore } from "./chatStore.js";
import { lineText, useComposerAttachments } from "./composerAttachments.js";
import {
	type ComposerMenu,
	type ComposerMenuKind,
	chooseFromMenu,
	clearMenuText,
	composerText,
	createComposerEditor,
	forgetLongPaste,
	inCodeBlock,
	inShellMode,
	insertAtCursor,
	insertPlainText,
	setMenuAria,
	showInterim,
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
/** The placeholder's advice, said on focus: a combobox may not carry aria-placeholder. */
const TIPS = "Type / for commands or @ for files. Paste or drop images to attach them.";
const KEY_HINT =
	"Enter sends, Shift+Enter adds a line, Up brings back your last message.";
const RUNNING_HINT = "Enter sends without stopping Claude. Esc stops it.";
const CODE_HINT = `In code, Enter adds a line. ${currentPlatform() === "mac" ? "Cmd" : "Ctrl"}+Enter sends.`;
const SAVING = "Wait for the files to finish saving.";
const SENDING = "Wait for your last message to reach Claude.";
// Said once on entering a block: the visible hint is only a description, read on focus.
const CODE_ANNOUNCED = `In a code block. ${CODE_HINT} Press Enter three times at the end to leave it.`;
const SHELL_ANNOUNCED = "Shell command mode";
const SHELL_HINT =
	"Shell command. Enter runs it in the project folder, and Claude sees the output with your next message.";
const PASTED_NAME = "pasted-text.txt";

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
	const commands = useStore(store, selectCommands);
	const [sending, setSending] = useState<Sending | null>(null);
	const [announced, setAnnounced] = useState("");
	const [error, setError] = useState("");
	const [dragging, setDragging] = useState(false);
	const [inCode, setInCode] = useState(false);
	const [shell, setShell] = useState(false);
	const [menu, setMenu] = useState<ComposerMenu | null>(null);
	/** The menu's list shows only while the box holds focus. */
	const [focused, setFocused] = useState(false);
	const menuModel = useComposerMenu(menu, commands, workspaceId, projectId);
	const listId = `${ids}-menu`;
	const listShown = menu !== null && focused && menuModel.options.length > 0;
	const activeOption = optionId(listId, menuModel.active);
	const host = useRef<HTMLDivElement | null>(null);
	const editor = useRef<Editor | null>(null);
	const picker = useRef<HTMLInputElement | null>(null);
	/** The last message sent, for Up to bring back; never stored (SPEC.md §25.10). */
	const lastSent = useRef<JSONContent | null>(null);
	/** Stop holds the keyboard; when it goes with the turn, the box takes it (SPEC.md §25.8). */
	const stopFocused = useRef(false);
	/** Long pastes so far, so each gets its own file and chip name. */
	const pastes = useRef(0);
	/** The last long paste's chip, to take back if the same text is pasted again at once. */
	const lastLongPaste = useRef<Promise<string[]> | null>(null);
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

	// Emptied on leaving the block, so entering the next one is announced again.
	useEffect(() => {
		setAnnounced((now) =>
			inCode ? CODE_ANNOUNCED : now === CODE_ANNOUNCED ? "" : now,
		);
	}, [inCode]);

	// Said once as the mode turns on, and emptied as it turns off so the next entry is said again.
	useEffect(() => {
		setAnnounced((now) =>
			shell ? SHELL_ANNOUNCED : now === SHELL_ANNOUNCED ? "" : now,
		);
	}, [shell]);

	useLayoutEffect(() => {
		if (running || !stopFocused.current) return;
		stopFocused.current = false;
		const lost =
			document.activeElement === null || document.activeElement === document.body;
		if (lost) editor.current?.view.dom.focus({ preventScroll: true });
	}, [running]);

	const announce = useCallback((text: string) => setAnnounced(text), []);

	// The box is the menu's combobox: it says whether the list is shown and which option is current.
	useEffect(() => {
		if (editor.current)
			setMenuAria(editor.current, {
				controls: listShown ? listId : null,
				active: activeOption,
			});
	}, [listShown, listId, activeOption]);

	useEffect(() => {
		if (files.status !== "") setAnnounced(files.status);
	}, [files.status]);

	const speech = useSpeechInput((words) => {
		if (editor.current) insertAtCursor(editor.current, words);
	});
	const stopSpeech = speech.stop;

	useEffect(() => {
		if (editor.current) showInterim(editor.current, speech.interim);
	}, [speech.interim]);

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
		// The file just sent must not be deleted by a quick repeat of its paste.
		if (editor.current) forgetLongPaste(editor.current);
		lastLongPaste.current = null;
		setError("");
		if (text.trim() !== "" && editor.current)
			lastSent.current = editor.current.getJSON();
		setSending({ seq, text, keys: files.items.map((item) => item.key) });
	}

	function addLongPaste(text: string, lines: number) {
		pastes.current += 1;
		const name =
			pastes.current === 1 ? PASTED_NAME : `pasted-text-${pastes.current}.txt`;
		lastLongPaste.current = files.add(
			[new File([text], name, { type: "text/plain" })],
			{ lines, text },
		);
	}

	/**
	 * Put a long paste's text in the box at the cursor and delete its file.
	 * Refused once a message that names the file is on its way: the file stays.
	 */
	function insertInline(key: string) {
		const item = files.items.find((entry) => entry.key === key);
		const box = editor.current;
		if (!item || item.text === null || item.lines === null || !box || sending) return;
		insertPlainText(box.view, item.text);
		files.discard(key, `Inserted ${lineText(item.lines)} as text.`);
		box.view.focus();
	}

	/** The same long text pasted again at once: the editor has put it inline, so its chip goes. */
	function repaste(lines: number) {
		const chip = lastLongPaste.current;
		lastLongPaste.current = null;
		void chip?.then((keys) => {
			for (const key of keys) files.discard(key, `Pasted ${lineText(lines)} inline.`);
		});
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

	/** A menu opened or changed, or the menu of kind `closed` shut. */
	function onMenu(next: ComposerMenu | null, closed?: ComposerMenuKind) {
		setMenu((now) => next ?? (now?.kind === closed ? null : now));
	}

	/** Put the menu's option in the box, or for a terminal-only command, point the way. */
	function choose(index: number) {
		const option = menuModel.options[index];
		const box = editor.current;
		if (!option || !box || !menu) return;
		if (option.insert !== null) {
			chooseFromMenu(box, menu, option.insert);
			return;
		}
		const picker = option.control
			? host.current
					?.closest("form")
					?.querySelector<HTMLElement>(`[data-testid="${option.control}"]`)
			: null;
		if (!picker) {
			setAnnounced(`${option.label} works only in the terminal, so it is not sent.`);
			return;
		}
		// The picker does the command's job here: the typed command goes and the picker opens.
		clearMenuText(box, menu);
		picker.focus();
		picker.dispatchEvent(
			new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
		);
	}

	/** Keys while a menu is open: arrows move, Enter or Tab chooses; Escape the editor handles. */
	function onMenuKey(event: KeyboardEvent): boolean {
		if (!listShown) return false;
		if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false;
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			menuModel.move(event.key === "ArrowDown" ? 1 : -1);
			return true;
		}
		if (event.key === "Enter" || event.key === "Tab") {
			event.preventDefault();
			choose(menuModel.active);
			return true;
		}
		return false;
	}

	function onKeyDown(event: KeyboardEvent): boolean {
		const plain = !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey;
		if (plain && event.key === "Escape" && running && !menuOpen() && menu === null) {
			event.preventDefault();
			store.getState().interrupt();
			return true;
		}
		const box = editor.current;
		if (plain && event.key === "ArrowUp" && box?.isEmpty && lastSent.current) {
			event.preventDefault();
			box.chain().setContent(lastSent.current).focus("end").run();
			return true;
		}
		if (!isVoiceShortcut(event)) return false;
		event.preventDefault();
		if (!event.repeat) speech.start();
		return true;
	}

	/** A picker's menu is open, and Escape is its to close. */
	function menuOpen(): boolean {
		return (
			host.current?.closest("form")?.querySelector('[aria-expanded="true"]') != null
		);
	}

	function onKeyUp(event: KeyboardEvent) {
		if (speech.state === "listening" && endsVoiceShortcut(event)) stopSpeech();
	}

	// The editor lives outside React; it reaches this render's handlers through here.
	const handlers = useRef({
		submit,
		addPasted,
		addLongPaste,
		repaste,
		onKeyDown,
		onKeyUp,
		onMenu,
		onMenuKey,
	});
	handlers.current = {
		submit,
		addPasted,
		addLongPaste,
		repaste,
		onKeyDown,
		onKeyUp,
		onMenu,
		onMenuKey,
	};

	useLayoutEffect(() => {
		const element = host.current;
		if (!element) return;
		const made = createComposerEditor({
			element,
			attributes: {
				id: `${ids}-text`,
				// A combobox, for the `/` and `@` menus (SPEC.md §25.8).
				role: "combobox",
				"aria-autocomplete": "list",
				"aria-label": "Message Claude Code",
				// The tips, then the key hint or the bypass warning in its place.
				"aria-describedby": `${ids}-tips ${ids}-hint ${ids}-bypass`,
				class: "pk-composer-text",
				"data-testid": "chat-composer-input",
			},
			placeholder: PLACEHOLDER,
			onSend: () => handlers.current.submit(),
			onFiles: (pasted) => handlers.current.addPasted(pasted),
			onLongPaste: (text, lines) => handlers.current.addLongPaste(text, lines),
			onRepaste: (lines) => handlers.current.repaste(lines),
			onKeyDown: (event) => handlers.current.onKeyDown(event),
			onKeyUp: (event) => handlers.current.onKeyUp(event),
			onChange: (changed) => {
				setInCode(inCodeBlock(changed));
				setShell(inShellMode(changed));
			},
			onMenu: (next, closed) => handlers.current.onMenu(next, closed),
			onMenuKey: (event) => handlers.current.onMenuKey(event),
		});
		editor.current = made;
		made.on("focus", () => setFocused(true));
		made.on("blur", () => setFocused(false));
		return () => {
			editor.current = null;
			made.destroy();
		};
	}, [ids]);

	const focusText = useCallback(() => editor.current?.view.focus(), []);

	function hasFiles(event: DragEvent): boolean {
		return event.dataTransfer.types.includes("Files");
	}

	const waitReason = files.saving > 0 ? SAVING : sending !== null ? SENDING : "";

	return (
		<>
			<form
				className={`pk-composer ${dragging ? "is-dragging" : ""} ${shell ? "is-shell" : ""}`}
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
					onInsert={sending ? undefined : insertInline}
					onEmptied={focusText}
				/>
				<ComposerCommandMenu
					listId={listId}
					menu={menu}
					model={menuModel}
					shown={focused}
					onChoose={choose}
				/>
				<div className="pk-composer-line">
					{/* Spoken by the status line and the hint; the label is for the eye. */}
					{shell ? (
						<span
							className="pk-composer-shell"
							aria-hidden="true"
							data-testid="chat-composer-shell"
						>
							Shell
						</span>
					) : null}
					<div ref={host} className="pk-composer-field" />
				</div>
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
						store={store}
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
								onFocus={() => {
									stopFocused.current = true;
								}}
								onBlur={(event) => {
									// A blur from being removed leaves the flag for the effect above.
									if (event.currentTarget.isConnected) stopFocused.current = false;
								}}
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
							aria-disabled={waitReason !== "" || undefined}
							aria-describedby={waitReason !== "" ? `${ids}-wait` : undefined}
						/>
					</div>
					{waitReason !== "" ? (
						<span id={`${ids}-wait`} hidden={true}>
							{waitReason}
						</span>
					) : null}
				</div>
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
					{shell ? SHELL_HINT : inCode ? CODE_HINT : running ? RUNNING_HINT : KEY_HINT}
				</p>
			)}
			<span id={`${ids}-tips`} hidden={true}>
				{TIPS}
			</span>
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
