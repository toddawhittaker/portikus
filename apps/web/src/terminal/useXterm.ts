/**
 * One xterm.js instance on a host element, with what every Portikus terminal
 * shares: the colour schemes, fitting to the pane, copy and paste keys,
 * select-to-copy, and OSC 52 copies (SPEC.md §9.1, §24.2). What the terminal
 * talks to is the caller's, through `attach`.
 */
import { SCROLLBACK_LINES, type TerminalTheme } from "@portikus/contracts";
import { useToast } from "@portikus/ui";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal as Xterm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import "./terminal.css";
import { type MutableRefObject, type RefObject, useEffect, useRef } from "react";
import { wrappedUrlsOnRow } from "../links.js";
import { currentPlatform } from "../platform.js";
import { endsVoiceShortcut, isVoiceShortcut } from "../voice/shortcut.js";
import { decide } from "./terminalClipboard.js";

/** Quiet time after the pane's last size change before the size is sent. */
export const RESIZE_SETTLE_MS = 100;

/**
 * The two terminal colour schemes. They match the
 * `--terminal-*` and `--ansi-*` tokens in packages/ui/src/theme.css, which
 * colour the chrome around the terminal; xterm.js needs the values directly.
 * The scrollbar thumb is the terminal's muted foreground, quiet until the
 * pointer is on it: xterm.js would otherwise derive it from the text colour,
 * which is far too loud.
 */
const DARK_THEME = {
	background: "#11100e",
	foreground: "#e4dfd4",
	cursor: "#e8c37a",
	selectionBackground: "#3a4a48",
	scrollbarSliderBackground: "#9a938666",
	scrollbarSliderHoverBackground: "#9a9386b3",
	scrollbarSliderActiveBackground: "#9a9386cc",
	// xterm's default palette fails AA on this ground.
	black: "#11100e",
	brightBlack: "#857f73",
	red: "#e07a6e",
	brightRed: "#f09a8f",
	green: "#8fc28a",
	brightGreen: "#a9d6a4",
	yellow: "#e0bb6c",
	brightYellow: "#ecd08e",
	blue: "#86a7d9",
	brightBlue: "#a6c0e6",
	magenta: "#c49ad0",
	brightMagenta: "#d6b5df",
	cyan: "#79c1b8",
	brightCyan: "#9ad3cb",
	white: "#cfc9bd",
	brightWhite: "#f2eee6",
};

const LIGHT_THEME = {
	background: "#fdfcfa",
	foreground: "#23211d",
	cursor: "#8a5a00",
	selectionBackground: "#d9e8e5",
	scrollbarSliderBackground: "#5a554c40",
	scrollbarSliderHoverBackground: "#5a554c80",
	scrollbarSliderActiveBackground: "#5a554ca6",
	// The default ANSI palette is written for a dark ground, so a light
	// terminal needs its own or half the colours are unreadable.
	black: "#23211d",
	brightBlack: "#5a554c",
	red: "#a4342a",
	brightRed: "#c14437",
	green: "#2e6e34",
	brightGreen: "#35793b",
	yellow: "#855b00",
	brightYellow: "#946800",
	blue: "#3f5a8c",
	brightBlue: "#4f70ab",
	magenta: "#8a3ea0",
	brightMagenta: "#a44fbd",
	cyan: "#24605c",
	brightCyan: "#2c7a74",
	white: "#6e685d",
	brightWhite: "#23211d",
};

/** The xterm theme for one of the two schemes (contracts/settings.ts). */
export function terminalTheme(theme: TerminalTheme): Record<string, string> {
	return theme === "light" ? LIGHT_THEME : DARK_THEME;
}

/**
 * The most a program in a terminal may put on the system clipboard in one
 * OSC 52 request. Terminal output is untrusted, so a payload larger than this
 * is dropped rather than truncated (SPEC.md §24.2).
 */
export const MAX_CLIPBOARD_BYTES = 100 * 1024;

/** Firefox and older browsers may not expose clipboard reading at all. */
function canReadClipboard(): boolean {
	return typeof navigator.clipboard?.readText === "function";
}

/**
 * The text an OSC 52 copy request carries. The payload is base64, and the
 * bytes inside it are UTF-8, so a URL with an accented character survives.
 * Anything that is not valid base64 is treated as an empty copy.
 */
export function decodeOsc52(encoded: string): string {
	try {
		const binary = atob(encoded);
		const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
		return new TextDecoder().decode(bytes);
	} catch {
		return "";
	}
}

/**
 * Pasted text with control characters removed, keeping tab, line feed and
 * carriage return. xterm does not strip an end-of-paste marker (ESC[201~)
 * inside the text, so planted clipboard text could otherwise leave the
 * bracket early and run a command (SPEC.md §24).
 */
export function sanitizePaste(text: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point.
	return text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}

/** The only picture types a paste saves as a file. */
const PASTE_IMAGE_TYPES = ["image/png", "image/jpeg"];

/**
 * The picture type when a paste is a png or jpeg and nothing else. Anything
 * with text in it, or any other type, stays a text paste.
 */
export function pastedImageType(types: readonly string[]): string | null {
	if (types.length === 0) return null;
	if (!types.every((type) => PASTE_IMAGE_TYPES.includes(type))) return null;
	return types[0] ?? null;
}

/** Copy to the system clipboard, ignoring a browser that refuses. */
async function writeClipboard(text: string): Promise<void> {
	if (text === "") return;
	try {
		await navigator.clipboard?.writeText(text);
	} catch {
		// Permission denied or no clipboard: nothing the student can act on.
	}
}

/** What `attach` gets to work with on a fresh terminal. */
export interface XtermTools {
	/** The element xterm.js is open in. */
	container: HTMLDivElement;
	/** Fit xterm.js to the pane, unless the pane has no box to measure. */
	fit: () => void;
}

/** The caller's connection to a terminal, made by `attach`. */
export interface XtermSession {
	/** The pane's box has settled at a new size; `fit` has not run yet. */
	resized: () => void;
	dispose: () => void;
}

export interface UseXtermOptions {
	host: RefObject<HTMLDivElement | null>;
	/** Shown in OSC 52 copy notices. */
	name: string;
	theme: TerminalTheme;
	screenReaderMode: boolean;
	visible: boolean;
	/** Take the keyboard when the terminal first appears. Read at mount only. */
	focusOnMount: boolean;
	/** The id of the hint that tells a screen reader how to leave. */
	describedBy: string;
	/** The user clicked in the terminal. */
	onFocus: () => void;
	/** Alt+Shift+Q: move focus out of the terminal. */
	onLeave: () => void;
	/** A URL in the output was activated. */
	openUrl: (uri: string) => void;
	/** Alt+Shift+M pressed (true) or released (false): hold to talk. */
	onVoiceHold?: (held: boolean) => void;
	/** Set to a function that types dictated text into this terminal. */
	dictation?: MutableRefObject<((text: string) => void) | null>;
	/** A paste that is a png or jpeg alone. Without this it is ignored. */
	pasteImage?: (image: Blob, type: string) => void | Promise<void>;
	/**
	 * Connect the terminal once it is open. A new `attach` builds a new
	 * terminal, so keep it stable for as long as the terminal should live.
	 */
	attach: (term: Xterm, tools: XtermTools) => XtermSession;
}

/**
 * The element stays mounted while hidden, so scrollback survives a tab
 * switch; a hidden pane is fitted again when it comes back into view.
 */
export function useXterm({
	host,
	name,
	theme,
	screenReaderMode,
	visible,
	focusOnMount,
	describedBy,
	onFocus,
	onLeave,
	openUrl,
	pasteImage,
	onVoiceHold,
	dictation,
	attach,
}: UseXtermOptions): void {
	const xterm = useRef<Xterm | null>(null);
	const fit = useRef<FitAddon | null>(null);
	const toast = useToast();

	// Callbacks the long-lived effect reads through a ref, so that a new
	// render does not tear down the terminal and what it is attached to.
	const handlers = useRef({
		onFocus,
		onLeave,
		openUrl,
		pasteImage,
		onVoiceHold,
		toast,
		name,
	});
	handlers.current = {
		onFocus,
		onLeave,
		openUrl,
		pasteImage,
		onVoiceHold,
		toast,
		name,
	};
	const dictationRef = useRef(dictation);
	dictationRef.current = dictation;
	const visibleRef = useRef(visible);
	visibleRef.current = visible;
	const focusOnMountRef = useRef(focusOnMount);
	focusOnMountRef.current = focusOnMount;

	// The scheme can change while the terminal is open, so it is set on the
	// live instance rather than only at construction.
	const themeRef = useRef(theme);
	themeRef.current = theme;
	useEffect(() => {
		if (xterm.current) xterm.current.options.theme = terminalTheme(theme);
	}, [theme]);

	const screenReaderRef = useRef(screenReaderMode);
	screenReaderRef.current = screenReaderMode;
	useEffect(() => {
		if (xterm.current) xterm.current.options.screenReaderMode = screenReaderMode;
	}, [screenReaderMode]);

	useEffect(() => {
		const container = host.current;
		if (!container) return;

		// True while the keyboard is in this pane; a copy nobody asked for is not
		// allowed to reach the system clipboard (SPEC.md §24.2).
		let focused = false;
		// Alt+Shift+M is down; a keyup elsewhere would never reach this pane,
		// so leaving the pane lets go too.
		let voiceHeld = false;
		const onFocusIn = () => {
			focused = true;
		};
		const onFocusOut = () => {
			focused = false;
			if (voiceHeld) {
				voiceHeld = false;
				handlers.current.onVoiceHold?.(false);
			}
		};
		container.addEventListener("focusin", onFocusIn);
		container.addEventListener("focusout", onFocusOut);

		const term = new Xterm({
			fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
			fontSize: 13,
			theme: terminalTheme(themeRef.current),
			convertEol: false,
			// Ordinary output keeps this many lines. CSI 3 J, which `clear` sends, erases them.
			scrollback: SCROLLBACK_LINES,
			// Programs pick their own colours too; lift any that miss WCAG AA.
			minimumContrastRatio: 4.5,
			screenReaderMode: screenReaderRef.current,
		});
		const openUrl = (uri: string) => handlers.current.openUrl(uri);

		const fitAddon = new FitAddon();
		term.loadAddon(fitAddon);
		// Registered before the web-links addon: where two providers offer a
		// link over the same cells, xterm.js keeps the one registered first, and
		// a URL that wrapped should be one link rather than the fragment the
		// addon finds on this row (SPEC.md §14.9).
		term.registerLinkProvider({
			provideLinks(lineNumber, callback) {
				const links = wrappedUrlsOnRow(
					lineNumber,
					(y) => term.buffer.active.getLine(y - 1)?.translateToString(true) ?? null,
					term.cols,
				).map((link) => ({
					range: link.range,
					text: link.text,
					activate: () => openUrl(link.text),
				}));
				callback(links.length > 0 ? links : undefined);
			},
		});
		term.loadAddon(new WebLinksAddon((_event, uri) => openUrl(uri)));
		// A program in the pane copies by emitting OSC 52, which tmux passes
		// through (SPEC.md §9, §10). A read request ("?") is ignored: nothing in
		// the workspace needs to be handed the student's clipboard.
		term.parser.registerOscHandler(52, (data) => {
			const encoded = data.split(";")[1];
			if (encoded === undefined || encoded === "?") return true;
			// Only the pane the student is actually working in may copy, and only
			// a payload small enough to be a real copy (SPEC.md §24.2).
			if (!visibleRef.current || !focused) return true;
			const text = decodeOsc52(encoded);
			if (text === "") return true;
			// The workspace's own shim allows more than this, so a student can
			// ask for a copy that is refused here. Say so rather than letting
			// the paste come back empty for no visible reason.
			if (new TextEncoder().encode(text).length > MAX_CLIPBOARD_BYTES) {
				handlers.current.toast.show({
					title: `A program in ${handlers.current.name} tried to copy more than 100 KB; nothing was copied.`,
				});
				return true;
			}
			void writeClipboard(text);
			handlers.current.toast.show({
				title: `Copied to your clipboard by a program in ${handlers.current.name}`,
			});
			return true;
		});
		term.open(container);
		term.textarea?.setAttribute("aria-describedby", describedBy);
		xterm.current = term;
		fit.current = fitAddon;
		fitAddon.fit();
		if (focusOnMountRef.current && visibleRef.current) term.focus();

		function fitIfMeasurable() {
			// A pane with no box on screen cannot be measured; keep the last size.
			if (container?.clientWidth !== 0 && container?.clientHeight !== 0) {
				fitAddon.fit();
			}
		}

		const session = attach(term, { container, fit: fitIfMeasurable });

		/**
		 * Every keyboard paste arrives as the browser's paste event. It is
		 * handled here rather than by xterm: text is sanitized and typed once,
		 * and a lone picture goes to `pasteImage`, so its bytes never reach
		 * the terminal.
		 */
		function onPaste(event: ClipboardEvent) {
			const data = event.clipboardData;
			if (!data) return;
			event.preventDefault();
			event.stopPropagation();
			const items = Array.from(data.items ?? []);
			const type = pastedImageType(items.map((item) => item.type));
			if (!type) {
				term.paste(sanitizePaste(data.getData("text/plain")));
				return;
			}
			const image = items[0]?.getAsFile();
			if (image) void handlers.current.pasteImage?.(image, type);
		}
		container.addEventListener("paste", onPaste, { capture: true });

		/** A right-click has no paste event, so read the clipboard's items. */
		async function pasteFromMenu() {
			// term.paste brackets the text when the program asked for it.
			if (typeof navigator.clipboard?.read === "function") {
				try {
					const items = await navigator.clipboard.read();
					const type = pastedImageType(items.flatMap((item) => item.types));
					const first = items[0];
					if (type && first) {
						await handlers.current.pasteImage?.(await first.getType(type), type);
						return;
					}
					const textItem = items.find((item) => item.types.includes("text/plain"));
					if (textItem) {
						const blob = await textItem.getType("text/plain");
						term.paste(sanitizePaste(await blob.text()));
					}
				} catch {
					// Refused: nothing the student can act on.
				}
				return;
			}
			if (!canReadClipboard()) return;
			try {
				term.paste(sanitizePaste(await navigator.clipboard.readText()));
			} catch {
				// Firefox may refuse readText.
			}
		}

		// Dictated text is already free of control characters, so no Enter.
		const dictationTarget = dictationRef.current;
		if (dictationTarget) dictationTarget.current = (text) => term.paste(text);

		const platform = currentPlatform();
		term.attachCustomKeyEventHandler((event) => {
			// Alt+Shift+M listens while held.
			const voice = handlers.current.onVoiceHold;
			if (voice) {
				if (event.type === "keydown" && isVoiceShortcut(event)) {
					event.preventDefault();
					if (!voiceHeld) {
						voiceHeld = true;
						voice(true);
					}
					return false;
				}
				if (event.type === "keyup" && voiceHeld && endsVoiceShortcut(event)) {
					voiceHeld = false;
					voice(false);
					return false;
				}
			}
			if (
				event.type === "keydown" &&
				event.altKey &&
				event.shiftKey &&
				event.key.toLowerCase() === "q"
			) {
				event.preventDefault();
				handlers.current.onLeave();
				return false;
			}
			const action = decide(event, term.hasSelection(), platform);
			if (action === "copy") {
				const selection = term.getSelection();
				void writeClipboard(selection);
				clearSelection();
				return false;
			}
			if (action === "paste") {
				// The browser's own paste event follows and lands exactly once:
				// xterm types text, and onPaste saves a picture.
				return false;
			}
			return true;
		});

		// Selecting text copies it, as it does in a UNIX terminal.
		const selection = term.onSelectionChange(() => {
			if (term.hasSelection()) void writeClipboard(term.getSelection());
		});

		/** Let go of both the terminal's selection and the browser's. */
		function clearSelection() {
			term.clearSelection();
			// The browser settles its own drag selection after the event that
			// asked for the copy, so let go of it once that has happened.
			setTimeout(() => window.getSelection()?.removeAllRanges(), 0);
		}

		function onContextMenu(event: MouseEvent) {
			event.preventDefault();
			if (term.hasSelection()) {
				void writeClipboard(term.getSelection());
				clearSelection();
				return;
			}
			void pasteFromMenu();
		}
		container.addEventListener("contextmenu", onContextMenu);

		function onPointerDown() {
			handlers.current.onFocus();
		}
		container.addEventListener("pointerdown", onPointerDown);

		// Wait for the box to settle: every size sent makes tmux reflow and a
		// full-screen app like Claude Code redraw, and redraws for sizes already
		// gone land on the wrong rows.
		let settle: ReturnType<typeof setTimeout> | undefined;
		const observer = new ResizeObserver(() => {
			if (settle !== undefined) clearTimeout(settle);
			settle = setTimeout(() => {
				settle = undefined;
				if (container.clientWidth === 0 || container.clientHeight === 0) return;
				session.resized();
			}, RESIZE_SETTLE_MS);
		});
		observer.observe(container);

		return () => {
			if (dictationTarget) dictationTarget.current = null;
			if (voiceHeld) handlers.current.onVoiceHold?.(false);
			session.dispose();
			if (settle !== undefined) clearTimeout(settle);
			observer.disconnect();
			container.removeEventListener("contextmenu", onContextMenu);
			container.removeEventListener("paste", onPaste, { capture: true });
			container.removeEventListener("focusin", onFocusIn);
			container.removeEventListener("focusout", onFocusOut);
			container.removeEventListener("pointerdown", onPointerDown);
			selection.dispose();
			term.dispose();
			xterm.current = null;
			fit.current = null;
		};
	}, [host, attach, describedBy]);

	useEffect(() => {
		if (visible) fit.current?.fit();
	}, [visible]);
}
