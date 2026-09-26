import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	EDITOR_SETTINGS_DEFAULTS,
	MAX_UPLOAD_BYTES,
	type Terminal,
} from "@portikus/contracts";
import { ToastProvider } from "@portikus/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { createQueryClient } from "./api/queryClient.js";
import { editorSettingsKey } from "./editor/settingsQueries.js";
import {
	decodeOsc52,
	MAX_CLIPBOARD_BYTES,
	PASTE_NAME_TRIES,
	pastedImageType,
	pastedPathInput,
	pastePath,
	SCROLLBACK_LINES,
	sanitizePaste,
	TerminalPane,
	terminalTheme,
} from "./TerminalPane";

const opened = vi.hoisted(() => ({
	terminals: [] as import("@xterm/xterm").Terminal[],
}));

vi.mock("@xterm/xterm", async () => {
	const actual = await vi.importActual<typeof import("@xterm/xterm")>("@xterm/xterm");
	class RecordingTerminal extends actual.Terminal {
		constructor(options?: ConstructorParameters<typeof actual.Terminal>[0]) {
			super(options);
			opened.terminals.push(this);
		}
	}
	return { ...actual, Terminal: RecordingTerminal };
});

vi.mock("@tanstack/react-router", () => ({ useNavigate: () => vi.fn() }));

const WORKSPACE = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";

const terminal: Terminal = {
	id: "44444444-4444-4444-8444-444444444444",
	workspaceId: WORKSPACE,
	name: "zsh",
	cwd: "/home/student/projects/todo-api",
	position: 0,
	projectId: PROJECT,
	createdAt: "2026-01-01T00:00:00.000Z",
	endedAt: null,
	theme: "dark",
};

const sockets: FakeWebSocket[] = [];

class FakeWebSocket {
	static readonly OPEN = 1;
	readonly url: string;
	readyState = FakeWebSocket.OPEN;
	binaryType = "arraybuffer";
	sent: string[] = [];
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onclose: ((event: { code: number }) => void) | null = null;

	constructor(url: string) {
		this.url = url;
		sockets.push(this);
	}

	send(data: string) {
		this.sent.push(data);
	}

	close() {
		this.readyState = 3;
	}
}

afterEach(() => {
	cleanup();
	sockets.length = 0;
	opened.terminals.length = 0;
	vi.unstubAllGlobals();
});

/** jsdom has neither of these, and xterm.js needs both. */
function stubBrowserApis() {
	vi.stubGlobal(
		"matchMedia",
		vi.fn(() => ({
			matches: false,
			media: "",
			onchange: null,
			addListener: vi.fn(),
			removeListener: vi.fn(),
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			dispatchEvent: () => false,
		})),
	);
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
}

function renderPane(
	onExited = vi.fn(),
	onCwd = vi.fn(),
	visible = true,
	overrides: Partial<Terminal> = {},
	focusOnMount = false,
	client = createQueryClient(() => {}),
) {
	stubBrowserApis();
	vi.stubGlobal("WebSocket", FakeWebSocket);
	const view = render(
		<QueryClientProvider client={client}>
			<ToastProvider>
				<TerminalPane
					workspaceId={WORKSPACE}
					projectId={PROJECT}
					terminal={{ ...terminal, ...overrides }}
					visible={visible}
					focusOnMount={focusOnMount}
					onExited={onExited}
					onSessionEnded={vi.fn()}
					onCwd={onCwd}
					onFocus={vi.fn()}
					onLeave={vi.fn()}
				/>
			</ToastProvider>
		</QueryClientProvider>,
	);
	return { view, onExited, onCwd };
}

/** Put the keyboard in the pane, the way clicking it does. */
function focusPane(view: ReturnType<typeof render>) {
	const surface = view.container.querySelector(".pk-terminal-surface");
	if (!surface) throw new Error("no terminal surface");
	act(() => {
		surface.dispatchEvent(new Event("focusin", { bubbles: true }));
	});
}

test("the pane opens a socket for its terminal and reports it as connected", async () => {
	const { view } = renderPane();
	await waitFor(() => expect(sockets).toHaveLength(1));
	expect(sockets[0]?.url).toContain(
		`/workspaces/${WORKSPACE}/terminals/${terminal.id}/ws`,
	);

	act(() => {
		sockets[0]?.onopen?.();
	});
	const pane = view.getByTestId(`terminal-pane-${terminal.id}`);
	await waitFor(() => expect(pane.getAttribute("data-connected")).toBe("true"));
});

test("an exit frame tells the work area the terminal is gone", async () => {
	const { onExited } = renderPane();
	await waitFor(() => expect(sockets).toHaveLength(1));

	act(() => {
		sockets[0]?.onopen?.();
		sockets[0]?.onmessage?.({ data: JSON.stringify({ type: "exit" }) });
	});
	expect(onExited).toHaveBeenCalledWith(terminal.id);
});

test("a terminal lost to a restart closes its pane and says why in a toast", async () => {
	const { view, onExited } = renderPane();
	await waitFor(() => expect(sockets).toHaveLength(1));

	act(() => {
		sockets[0]?.onopen?.();
		sockets[0]?.onmessage?.({
			data: JSON.stringify({
				type: "error",
				code: "TERMINAL_NOT_FOUND",
				reason: "out_of_memory",
				at: "2026-09-26T08:00:00.000Z",
			}),
		});
	});
	expect(onExited).toHaveBeenCalledWith(terminal.id);
	const toast = await view.findByText(
		"Your workspace ran out of memory and its terminals were restarted.",
	);
	expect(toast.closest("[role=alert]")).not.toBeNull();
});

test("the first output frame makes the pane say its size again", async () => {
	renderPane();
	await waitFor(() => expect(sockets).toHaveLength(1));
	const socket = sockets[0];
	if (!socket) throw new Error("no socket");
	const announced = new URL(socket.url, "http://localhost").searchParams;

	// A resize sent between the connect and the first output can be lost: the
	// socket may not be open yet, and the agent may not have started the PTY.
	// Output means both are ready, so the size has to be said again, or tmux
	// keeps drawing a screen taller than the pane and the shell prompt scrolls
	// out of view (SPEC.md §9.7).
	act(() => {
		socket.onopen?.();
		socket.onmessage?.({ data: new ArrayBuffer(5) });
	});

	const resizes = socket.sent
		.map((raw) => JSON.parse(raw) as { type: string; cols: number; rows: number })
		.filter((frame) => frame.type === "resize");
	expect(resizes).toHaveLength(1);
	expect(resizes[0]?.cols).toBe(Number(announced.get("cols")));
	expect(resizes[0]?.rows).toBe(Number(announced.get("rows")));

	// Only the first frame: every later byte must not cost a resize.
	act(() => {
		socket.onmessage?.({ data: new ArrayBuffer(4) });
	});
	expect(socket.sent.filter((raw) => raw.includes("resize"))).toHaveLength(1);
});

test("a close before any exit is retried, not reported as an exit", async () => {
	const { onExited } = renderPane();
	await waitFor(() => expect(sockets).toHaveLength(1));

	act(() => {
		sockets[0]?.onclose?.({ code: 1006 });
	});
	expect(onExited).not.toHaveBeenCalled();
});

test("a cwd frame is reported to the owner of the pane", async () => {
	const { onCwd } = renderPane();
	await waitFor(() => expect(sockets).toHaveLength(1));

	act(() => {
		sockets[0]?.onmessage?.({ data: JSON.stringify({ type: "cwd", path: "/tmp" }) });
	});
	expect(onCwd).toHaveBeenCalledWith("/tmp");

	// A frame with no path is not a directory report and is ignored.
	act(() => {
		sockets[0]?.onmessage?.({ data: JSON.stringify({ type: "cwd" }) });
	});
	expect(onCwd).toHaveBeenCalledTimes(1);
});

/** Send one wheel event over the terminal and say whether it was cancelled. */
function wheelOver(pane: HTMLElement, deltaY: number): boolean {
	const target = pane.querySelector(".xterm-screen") ?? pane;
	const wheel = new WheelEvent("wheel", { deltaY, bubbles: true, cancelable: true });
	act(() => {
		target.dispatchEvent(wheel);
	});
	return wheel.defaultPrevented;
}

/** The input frames this pane's socket has sent. */
function inputs(): string[] {
	return (sockets[0]?.sent ?? [])
		.map((frame) => JSON.parse(frame) as { type: string; data?: string })
		.filter((frame) => frame.type === "input")
		.map((frame) => frame.data ?? "");
}

test("the wheel scrolls the terminal's own output at a shell prompt", async () => {
	// The scrollback is what the wheel moves through, and nothing the pane
	// installs may cancel the event before xterm.js sees it (SPEC.md §9.1).
	expect(SCROLLBACK_LINES).toBeGreaterThanOrEqual(5_000);

	const { view } = renderPane();
	await waitFor(() => expect(sockets).toHaveLength(1));
	const pane = view.getByTestId(`terminal-pane-${terminal.id}`);

	expect(wheelOver(pane, -300)).toBe(false);
	expect(inputs()).toEqual([]);
});

test("the wheel becomes arrow keys while a full-screen program has the terminal", async () => {
	const { view } = renderPane();
	await waitFor(() => expect(sockets).toHaveLength(1));
	const pane = view.getByTestId(`terminal-pane-${terminal.id}`);

	act(() => {
		sockets[0]?.onmessage?.({
			data: JSON.stringify({ type: "screen", alternate: true }),
		});
	});

	// Up the wheel, up the cursor, and xterm.js never sees the event.
	expect(wheelOver(pane, -300)).toBe(true);
	const up = inputs().join("");
	expect(up).toContain("\u001b[A");
	expect(up).not.toContain("\u001b[B");

	expect(wheelOver(pane, 300)).toBe(true);
	expect(inputs().join("")).toContain("\u001b[B");

	// And when the program lets the screen go, the wheel scrolls again.
	act(() => {
		sockets[0]?.onmessage?.({
			data: JSON.stringify({ type: "screen", alternate: false }),
		});
	});
	const before = inputs().length;
	expect(wheelOver(pane, -300)).toBe(false);
	expect(inputs()).toHaveLength(before);
});

/** jsdom has no clipboard; give it one the test can watch. */
function stubClipboard(clipboard: Record<string, unknown>) {
	Object.defineProperty(navigator, "clipboard", {
		value: clipboard,
		configurable: true,
	});
}

/** An OSC 52 request as a program in the pane writes it, as output bytes. */
function osc52(payload: string): ArrayBuffer {
	const esc = String.fromCharCode(27);
	const bell = String.fromCharCode(7);
	const text = `${esc}]52;${payload}${bell}`;
	const bytes = new Uint8Array(text.length);
	for (let at = 0; at < text.length; at += 1) bytes[at] = text.charCodeAt(at);
	return bytes.buffer;
}

test("an OSC 52 copy from the focused pane reaches the clipboard and says so", async () => {
	const writeText = vi.fn(async () => undefined);
	stubClipboard({ writeText });
	const { view } = renderPane();
	await waitFor(() => expect(sockets).toHaveLength(1));
	focusPane(view);

	const url = "https://accounts.example.com/oauth?code=abc123";
	act(() => {
		sockets[0]?.onmessage?.({ data: osc52(`c;${btoa(url)}`) });
	});

	await waitFor(() => expect(writeText).toHaveBeenCalledWith(url));
	// The student is told, so a clipboard change is never silent (SPEC.md §24.2).
	await waitFor(() =>
		expect(
			view.getByText(`Copied to your clipboard by a program in ${terminal.name}`),
		).toBeTruthy(),
	);
});

test("an OSC 52 copy from a pane that does not have focus is refused", async () => {
	const writeText = vi.fn(async () => undefined);
	stubClipboard({ writeText });
	renderPane();
	await waitFor(() => expect(sockets).toHaveLength(1));

	// Nobody is typing here, so nobody asked for a copy (SPEC.md §24.2).
	act(() => {
		sockets[0]?.onmessage?.({ data: osc52(`c;${btoa("stolen")}`) });
	});

	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(writeText).not.toHaveBeenCalled();
});

test("an OSC 52 copy from a hidden pane is refused even with focus", async () => {
	const writeText = vi.fn(async () => undefined);
	stubClipboard({ writeText });
	const { view } = renderPane(vi.fn(), vi.fn(), false);
	await waitFor(() => expect(sockets).toHaveLength(1));
	focusPane(view);

	act(() => {
		sockets[0]?.onmessage?.({ data: osc52(`c;${btoa("stolen")}`) });
	});

	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(writeText).not.toHaveBeenCalled();
});

test("an OSC 52 payload larger than the cap is dropped", async () => {
	const writeText = vi.fn(async () => undefined);
	stubClipboard({ writeText });
	const { view } = renderPane();
	await waitFor(() => expect(sockets).toHaveLength(1));
	focusPane(view);

	const huge = "a".repeat(MAX_CLIPBOARD_BYTES + 1);
	act(() => {
		sockets[0]?.onmessage?.({ data: osc52(`c;${btoa(huge)}`) });
	});

	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(writeText).not.toHaveBeenCalled();
	// The workspace's own shim allows a megabyte, so the student has to be
	// told why the paste is going to be empty.
	await waitFor(() =>
		expect(
			view.getByText(
				`A program in ${terminal.name} tried to copy more than 100 KB; nothing was copied.`,
			),
		).toBeTruthy(),
	);
});

test("an OSC 52 read request is ignored rather than handing over the clipboard", async () => {
	const writeText = vi.fn(async () => undefined);
	const readText = vi.fn(async () => "secret");
	stubClipboard({ writeText, readText });
	renderPane();
	await waitFor(() => expect(sockets).toHaveLength(1));

	act(() => {
		sockets[0]?.onmessage?.({ data: osc52("c;?") });
	});

	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(readText).not.toHaveBeenCalled();
	expect(writeText).not.toHaveBeenCalled();
});

test("an OSC 52 payload that is not base64 copies nothing", () => {
	expect(decodeOsc52("not base64!!")).toBe("");
});

/** Issue #239: the light scheme is a light ground with readable ANSI colours. */
test("the light terminal theme is light and has its own ANSI palette", () => {
	const dark = terminalTheme("dark");
	const light = terminalTheme("light");

	expect(dark.background).toBe("#11100e");
	expect(light.background).toBe("#fdfcfa");
	expect(light.foreground).toBe("#23211d");
	// The default palette is written for a dark ground, so light brings its own.
	expect(light.red).toBeDefined();
	expect(dark.red).toBeDefined();
});

/** The relative luminance of a #rrggbb colour, as WCAG 2 defines it. */
function luminance(hex: string): number {
	const channels = [1, 3, 5]
		.map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255)
		.map((value) =>
			value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4,
		);
	return (
		0.2126 * (channels[0] ?? 0) +
		0.7152 * (channels[1] ?? 0) +
		0.0722 * (channels[2] ?? 0)
	);
}

/** The WCAG 2 contrast ratio between two colours, from 1 to 21. */
function contrastRatio(first: string, second: string): number {
	const a = luminance(first);
	const b = luminance(second);
	return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** Ordinary text has to clear WCAG AA against the ground it is drawn on. */
const CONTRAST_FLOOR = 4.5;

const ANSI_NAMES = [
	"black",
	"red",
	"green",
	"yellow",
	"blue",
	"magenta",
	"cyan",
	"white",
	"brightBlack",
	"brightRed",
	"brightGreen",
	"brightYellow",
	"brightBlue",
	"brightMagenta",
	"brightCyan",
	"brightWhite",
];

/**
 * Issue #267: on the pilot, line numbers and hints from Claude Code were
 * invisible on the light ground. Every one of the sixteen ANSI colours, and
 * the ordinary foreground, must be readable against it.
 */
test("every light ANSI colour is readable on the light background", () => {
	const light = terminalTheme("light");
	expect(ANSI_NAMES).toHaveLength(16);
	const background = light.background as string;
	for (const name of ANSI_NAMES) {
		const colour = light[name];
		expect(colour, `${name} is missing from the light palette`).toBeDefined();
		const ratio = contrastRatio(colour as string, background);
		expect(
			ratio,
			`${name} (${colour}) is only ${ratio.toFixed(2)}:1 on the light background`,
		).toBeGreaterThanOrEqual(CONTRAST_FLOOR);
	}
	expect(contrastRatio(light.foreground as string, background)).toBeGreaterThanOrEqual(
		CONTRAST_FLOOR,
	);
});

/**
 * Issue #360: xterm's own defaults failed contrast on the dark ground. Every
 * dark ANSI colour but black, which programs use as a background, must clear
 * AA on it.
 */
test("every dark ANSI colour except black is readable on the dark background", () => {
	const dark = terminalTheme("dark");
	const background = dark.background as string;
	for (const name of ANSI_NAMES.filter((name) => name !== "black")) {
		const colour = dark[name];
		expect(colour, `${name} is missing from the dark palette`).toBeDefined();
		const ratio = contrastRatio(colour as string, background);
		expect(
			ratio,
			`${name} (${colour}) is only ${ratio.toFixed(2)}:1 on the dark background`,
		).toBeGreaterThanOrEqual(CONTRAST_FLOOR);
	}
});

/** Issue #360: the dark palette is the design's --ansi-* tokens, not a copy that drifts. */
test("the dark ANSI palette matches the dark --ansi-* tokens in theme.css", () => {
	const css = readFileSync(
		resolve(import.meta.dirname, "../../../packages/ui/src/theme.css"),
		"utf8",
	);
	const block = css.slice(css.indexOf('[data-terminal-theme="dark"] {'));
	const dark = terminalTheme("dark");
	for (const name of ANSI_NAMES) {
		const token = `--ansi-${name.replace(/[A-Z]/, (c) => `-${c.toLowerCase()}`)}`;
		const match = new RegExp(`${token}: (#[0-9a-f]{6});`).exec(block);
		expect(match?.[1], token).toBe(dark[name]);
	}
});

/** The light palette is the design's light --ansi-* tokens, so the two cannot drift. */
test("the light ANSI palette matches the light --ansi-* tokens in theme.css", () => {
	const css = readFileSync(
		resolve(import.meta.dirname, "../../../packages/ui/src/theme.css"),
		"utf8",
	);
	const start = css.indexOf('[data-terminal-theme="light"] {');
	expect(start).toBeGreaterThan(-1);
	const block = css.slice(start, css.indexOf("}", start));
	const light = terminalTheme("light");
	for (const name of ANSI_NAMES) {
		const token = `--ansi-${name.replace(/[A-Z]/, (c) => `-${c.toLowerCase()}`)}`;
		const match = new RegExp(`${token}: (#[0-9a-f]{6});`).exec(block);
		expect(match?.[1], token).toBe(light[name]);
	}
});

/** Issue #357: before the settings arrive a terminal uses the default. */
test("a terminal starts in the default screen-reader mode", async () => {
	renderPane();
	await waitFor(() => expect(opened.terminals).toHaveLength(1));
	expect(opened.terminals[0]?.options.screenReaderMode).toBe(
		EDITOR_SETTINGS_DEFAULTS.screenReaderMode,
	);
});

/** Issue #357: the student's setting turns it on, and a change applies without a reload. */
test("the screen-reader setting turns the mode on and off in an open terminal", async () => {
	const client = createQueryClient(() => {});
	const settings = {
		...EDITOR_SETTINGS_DEFAULTS,
		screenReaderMode: true,
		timezones: [],
	};
	client.setQueryData(editorSettingsKey, settings);
	renderPane(vi.fn(), vi.fn(), true, {}, false, client);
	await waitFor(() => expect(opened.terminals).toHaveLength(1));
	expect(opened.terminals[0]?.options.screenReaderMode).toBe(true);

	act(() => {
		client.setQueryData(editorSettingsKey, { ...settings, screenReaderMode: false });
	});
	await waitFor(() =>
		expect(opened.terminals[0]?.options.screenReaderMode).toBe(false),
	);
	expect(opened.terminals).toHaveLength(1);
});

/** Issue #360: colours a program picks itself are lifted to AA too. */
test("the terminal enforces a 4.5:1 minimum contrast", async () => {
	renderPane();
	await waitFor(() => expect(opened.terminals).toHaveLength(1));
	expect(opened.terminals[0]?.options.minimumContrastRatio).toBe(4.5);
});

/** Issue #359: Tab stays in the shell, so the way out is described on the input. */
test("the terminal input describes Alt+Shift+Q as the way out", async () => {
	const { view } = renderPane();
	await waitFor(() => expect(sockets).toHaveLength(1));
	const textarea = view.container.querySelector("textarea.xterm-helper-textarea");
	const id = textarea?.getAttribute("aria-describedby");
	expect(id).toBeTruthy();
	expect(document.getElementById(id as string)?.textContent).toContain("Alt+Shift+Q");
});

/** Issue #363: connection changes are announced from a status region. */
test("the reconnecting and lost flags sit in a status region", async () => {
	const { view } = renderPane();
	await waitFor(() => expect(sockets).toHaveLength(1));
	const status = view.getByRole("status");
	expect(status.textContent).toBe("");

	act(() => {
		sockets[0]?.onclose?.({ code: 1006 });
	});
	expect(status.textContent).toContain("Reconnecting");

	act(() => {
		sockets[0]?.onclose?.({ code: 1008 });
	});
	await waitFor(() => expect(status.textContent).toContain("lost its connection"));
});

/** Output bytes a program in the pane wrote, as the socket delivers them. */
function outputBytes(text: string): ArrayBuffer {
	const bytes = new Uint8Array(text.length);
	for (let at = 0; at < text.length; at += 1) bytes[at] = text.charCodeAt(at);
	return bytes.buffer;
}

/** The input frames this pane's socket has sent. */
function sentInput(): string {
	return (sockets[0]?.sent ?? [])
		.map((frame) => JSON.parse(frame) as { type: string; data?: string })
		.filter((frame) => frame.type === "input")
		.map((frame) => frame.data ?? "")
		.join("");
}

/**
 * Issues #267 and #268: xterm.js 6 answers the OSC 11 background query by
 * itself, and the pane paints the scheme its own terminal row carries. So a
 * program that asks is told the real background of that one terminal.
 */
test("a program asking for the background colour is told this terminal's", async () => {
	renderPane(vi.fn(), vi.fn(), true, { theme: "light" });
	await waitFor(() => expect(sockets).toHaveLength(1));
	act(() => {
		sockets[0]?.onopen?.();
	});
	act(() => {
		sockets[0]?.onmessage?.({
			data: outputBytes(`${String.fromCharCode(27)}]11;?${String.fromCharCode(7)}`),
		});
	});
	// The light ground is #fdfcfa, which xterm reports as an rgb: triple.
	await waitFor(() => expect(sentInput()).toContain("]11;rgb:fd"));
});

test("a dark terminal reports the dark background instead", async () => {
	renderPane();
	await waitFor(() => expect(sockets).toHaveLength(1));
	act(() => {
		sockets[0]?.onopen?.();
	});
	act(() => {
		sockets[0]?.onmessage?.({
			data: outputBytes(`${String.fromCharCode(27)}]11;?${String.fromCharCode(7)}`),
		});
	});
	await waitFor(() => expect(sentInput()).toContain("]11;rgb:11"));
});

/**
 * Issue #264: a pane that is born focused takes the keyboard, so the first
 * keystroke after "New terminal here" reaches the new shell.
 */
test("a pane created focused takes the keyboard", async () => {
	const { view } = renderPane(vi.fn(), vi.fn(), true, {}, true);
	await waitFor(() => expect(sockets).toHaveLength(1));
	const textarea = view.container.querySelector("textarea.xterm-helper-textarea");
	expect(textarea).not.toBeNull();
	expect(document.activeElement).toBe(textarea);
});

test("a pane created unfocused leaves the keyboard alone", async () => {
	const { view } = renderPane();
	await waitFor(() => expect(sockets).toHaveLength(1));
	const textarea = view.container.querySelector("textarea.xterm-helper-textarea");
	expect(document.activeElement).not.toBe(textarea);
});

/** Lines from the top of the scrollback up to, but not including, the cursor. */
function linesAboveCursor(term: import("@xterm/xterm").Terminal): number {
	const buffer = term.buffer.active;
	return buffer.baseY + buffer.cursorY;
}

/**
 * Issue #335: `clear` on TERM=xterm-256color sends the terminfo clear and
 * then erase-scrollback (CSI 3 J). After that sequence nothing is left above
 * the cursor. Ordinary output still keeps the scrollback limit.
 */
test("clear erases the scrollback and ordinary output still keeps it", async () => {
	renderPane();
	await waitFor(() => expect(sockets).toHaveLength(1));
	const term = opened.terminals.at(-1);
	if (!term) throw new Error("no terminal");
	expect(term.options.scrollback).toBe(SCROLLBACK_LINES);

	let filled = "";
	for (let line = 1; line <= term.rows + 8; line += 1) filled += `line ${line}\r\n`;
	act(() => {
		sockets[0]?.onmessage?.({ data: outputBytes(filled) });
	});
	await waitFor(() => expect(linesAboveCursor(term)).toBeGreaterThan(0));

	// Cursor home, erase the visible screen, erase the saved lines.
	act(() => {
		sockets[0]?.onmessage?.({ data: outputBytes("\u001b[H\u001b[2J\u001b[3J") });
	});
	await waitFor(() => expect(linesAboveCursor(term)).toBe(0));

	// The limit is unchanged, so later output can scroll again.
	expect(term.options.scrollback).toBe(SCROLLBACK_LINES);
	act(() => {
		sockets[0]?.onmessage?.({
			data: outputBytes("still here\r\n".repeat(term.rows + 3)),
		});
	});
	await waitFor(() => expect(linesAboveCursor(term)).toBeGreaterThan(0));
	expect(term.buffer.active.length).toBeLessThanOrEqual(SCROLLBACK_LINES + term.rows);
});

// Image paste (Epic 9.2 brief, "Done").

test("only a lone png or jpeg becomes a picture paste", () => {
	expect(pastedImageType(["image/png"])).toBe("image/png");
	expect(pastedImageType(["image/jpeg"])).toBe("image/jpeg");
	// Text beside a picture stays a text paste.
	expect(pastedImageType(["text/plain", "image/png"])).toBeNull();
	expect(pastedImageType(["image/png", "text/html"])).toBeNull();
	// Other picture types are not part of this epic.
	expect(pastedImageType(["image/gif"])).toBeNull();
	expect(pastedImageType(["image/webp"])).toBeNull();
	expect(pastedImageType([])).toBeNull();
});

test("a pasted picture gets a name Portikus chose under .portikus/pastes", () => {
	const now = new Date("2026-09-22T13:40:00.123Z");
	expect(pastePath(now, "image/png")).toBe(".portikus/pastes/2026-09-22T13-40-00.png");
	expect(pastePath(now, "image/jpeg")).toBe(
		".portikus/pastes/2026-09-22T13-40-00.jpeg",
	);
});

test("a second paste in the same second gets -2, then -3, before the extension", () => {
	const now = new Date("2026-09-22T13:40:00Z");
	expect(pastePath(now, "image/png", 2)).toBe(
		".portikus/pastes/2026-09-22T13-40-00-2.png",
	);
	expect(pastePath(now, "image/jpeg", 3)).toBe(
		".portikus/pastes/2026-09-22T13-40-00-3.jpeg",
	);
});

test("the shell gets the absolute home path, a space, and no newline", () => {
	expect(pastedPathInput("todo-api", ".portikus/pastes/a.png")).toBe(
		"/home/student/projects/todo-api/.portikus/pastes/a.png ",
	);
});

const PNG_BYTES = "\u0089PNG-image-bytes";

interface Call {
	method: string;
	url: string;
	headers: Record<string, string>;
	body: unknown;
}

function json(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/** A fake API: the project list, and a record of every file call. */
function stubFileApi(existing: string[] = []): Call[] {
	const calls: Call[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: string, init: RequestInit = {}) => {
			const url = String(input);
			// The pane reads the screen-reader setting (issue #357); not a file call.
			if (url === "/me/settings") return json(500, { code: "INTERNAL", message: "" });
			if (url.endsWith("/projects?state=active")) {
				return json(200, {
					projects: [
						{
							id: PROJECT,
							workspaceId: WORKSPACE,
							slug: "todo-api",
							name: "todo-api",
							path: "/home/student/projects/todo-api",
							state: "active",
							source: "new",
							isGitRepo: true,
							missing: false,
							createdAt: "2026-01-01T00:00:00.000Z",
							archivedAt: null,
						},
					],
				});
			}
			calls.push({
				method: init.method ?? "GET",
				url,
				headers: (init.headers ?? {}) as Record<string, string>,
				body: init.body,
			});
			// `.portikus` already holds checks.json in this project.
			if (url.endsWith("/mkdir") && String(init.body).includes('".portikus"')) {
				return json(409, { code: "FILE_EXISTS", message: "exists" });
			}
			if (url.endsWith("/mkdir")) return json(201, {});
			if (existing.some((path) => url.endsWith(encodeURIComponent(path)))) {
				return json(409, { code: "FILE_EXISTS", message: "exists" });
			}
			return json(200, { etag: "e1", size: PNG_BYTES.length });
		}),
	);
	return calls;
}

/** Fire the browser's paste event on the terminal, carrying `items`. */
function firePaste(view: ReturnType<typeof render>, items: unknown[]): Event {
	const target = view.container.querySelector("textarea");
	if (!target) throw new Error("no xterm textarea");
	const event = new Event("paste", { bubbles: true, cancelable: true });
	const text = items.some((item) => (item as { type: string }).type === "text/plain")
		? "typed-text"
		: "";
	Object.defineProperty(event, "clipboardData", {
		value: { items, getData: () => text },
	});
	act(() => {
		target.dispatchEvent(event);
	});
	return event;
}

function rightClick(view: ReturnType<typeof render>) {
	const surface = view.container.querySelector(".pk-terminal-surface");
	act(() => {
		surface?.dispatchEvent(
			new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
		);
	});
}

function inputsSent(): string[] {
	return (sockets[0]?.sent ?? [])
		.map((raw) => JSON.parse(raw) as { type: string; data?: string })
		.filter((message) => message.type === "input")
		.map((message) => message.data ?? "");
}

/** A connected pane whose project list, and so its slug, has loaded. */
async function loadedPane(existing: string[] = []) {
	const calls = stubFileApi(existing);
	const { view } = renderPane();
	await waitFor(() => expect(sockets).toHaveLength(1));
	act(() => sockets[0]?.onopen?.());
	await waitFor(() => expect(fetch).toHaveBeenCalled());
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	return { view, calls };
}

test("pasting a png saves it in the project and types only its path", async () => {
	const { view, calls } = await loadedPane();
	vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-09-22T13:40:00Z") });
	const image = new File([PNG_BYTES], "clipboard-name.png", { type: "image/png" });

	const event = firePaste(view, [
		{ kind: "file", type: "image/png", getAsFile: () => image },
	]);
	vi.useRealTimers();
	expect(event.defaultPrevented).toBe(true);

	const path = ".portikus/pastes/2026-09-22T13-40-00.png";
	await waitFor(() =>
		expect(inputsSent()).toEqual([`/home/student/projects/todo-api/${path} `]),
	);
	// .portikus, then .portikus/pastes, then the file, which must not exist yet.
	expect(calls.map((call) => call.method)).toEqual(["POST", "POST", "PUT"]);
	expect(calls[0]?.body).toBe(JSON.stringify({ path: ".portikus" }));
	expect(calls[1]?.body).toBe(JSON.stringify({ path: ".portikus/pastes" }));
	const put = calls[2];
	expect(put?.url).toBe(
		`/workspaces/${WORKSPACE}/projects/${PROJECT}/file?path=${encodeURIComponent(path)}`,
	);
	expect(put?.headers["if-none-match"]).toBe("*");
	expect(put?.body).toBe(image);
	// The clipboard's own name is ignored, and no bytes reach the shell.
	expect(put?.url).not.toContain("clipboard-name");
	expect(inputsSent().join("")).not.toContain("PNG");
});

test("a jpeg paste is saved with a .jpeg name", async () => {
	const { view, calls } = await loadedPane();
	const image = new File([PNG_BYTES], "x", { type: "image/jpeg" });
	firePaste(view, [{ kind: "file", type: "image/jpeg", getAsFile: () => image }]);
	await waitFor(() =>
		expect(inputsSent()[0]).toMatch(/\.portikus\/pastes\/[^/ ]+\.jpeg $/),
	);
	expect(calls.at(-1)?.url).toMatch(/\.jpeg$/);
});

test("a paste with text beside a picture is left to the text paste", async () => {
	const { view, calls } = await loadedPane();
	firePaste(view, [
		{ kind: "string", type: "text/plain", getAsFile: () => null },
		{ kind: "file", type: "image/png", getAsFile: () => new File([PNG_BYTES], "p") },
	]);
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	expect(calls).toEqual([]);
	// xterm types the text, exactly once.
	await waitFor(() => expect(inputsSent()).toEqual(["typed-text"]));
});

test("a picture over the upload cap is refused and nothing is written", async () => {
	const { view, calls } = await loadedPane();
	const huge = { size: MAX_UPLOAD_BYTES + 1, type: "image/png" };
	firePaste(view, [{ kind: "file", type: "image/png", getAsFile: () => huge }]);
	await waitFor(() => expect(view.getByText(/MB or smaller/)).toBeTruthy());
	expect(calls).toEqual([]);
	expect(inputsSent()).toEqual([]);
});

test("right-click pastes a picture even where readText is missing", async () => {
	const { view, calls } = await loadedPane();
	const image = new Blob([PNG_BYTES], { type: "image/png" });
	stubClipboard({
		read: async () => [{ types: ["image/png"], getType: async () => image }],
	});
	rightClick(view);
	await waitFor(() =>
		expect(inputsSent()[0]).toMatch(
			/^\/home\/student\/projects\/todo-api\/\.portikus\/pastes\/.+\.png $/,
		),
	);
	expect(calls.at(-1)?.body).toBe(image);
});

test("right-click with text on the clipboard types the text", async () => {
	const { view, calls } = await loadedPane();
	const readText = vi.fn(async () => "hello");
	stubClipboard({
		read: async () => [
			{
				types: ["text/plain", "image/png"],
				getType: async () => new Blob(["hello"], { type: "text/plain" }),
			},
		],
		readText,
	});
	rightClick(view);
	await waitFor(() => expect(inputsSent()).toEqual(["hello"]));
	expect(calls).toEqual([]);
	expect(readText).not.toHaveBeenCalled();
});

test("right-click text paste is bracketed when the program asks, and reads once", async () => {
	const { view } = await loadedPane();
	act(() => {
		sockets[0]?.onmessage?.({ data: outputBytes("\u001b[?2004h") });
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	const read = vi.fn(async () => [
		{
			types: ["text/plain"],
			getType: async () => new Blob(["ls\npwd"], { type: "text/plain" }),
		},
	]);
	const readText = vi.fn(async () => "wrong");
	stubClipboard({ read, readText });
	rightClick(view);
	await waitFor(() =>
		expect(inputsSent().join("")).toBe("\u001b[200~ls\rpwd\u001b[201~"),
	);
	expect(read).toHaveBeenCalledTimes(1);
	expect(readText).not.toHaveBeenCalled();
});

test("right-click falls back to readText through the same bracketed paste", async () => {
	const { view } = await loadedPane();
	act(() => {
		sockets[0]?.onmessage?.({ data: outputBytes("\u001b[?2004h") });
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	stubClipboard({ readText: async () => "echo hi" });
	rightClick(view);
	await waitFor(() =>
		expect(inputsSent().join("")).toBe("\u001b[200~echo hi\u001b[201~"),
	);
});

test("two pastes in the same second never overwrite: the second gets -2", async () => {
	const first = ".portikus/pastes/2026-09-22T13-40-00.png";
	const { view, calls } = await loadedPane([first]);
	vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-09-22T13:40:00Z") });
	const image = new File([PNG_BYTES], "p.png", { type: "image/png" });
	firePaste(view, [{ kind: "file", type: "image/png", getAsFile: () => image }]);
	vi.useRealTimers();
	const second = ".portikus/pastes/2026-09-22T13-40-00-2.png";
	await waitFor(() =>
		expect(inputsSent()).toEqual([`/home/student/projects/todo-api/${second} `]),
	);
	const puts = calls.filter((call) => call.method === "PUT");
	expect(puts).toHaveLength(2);
	for (const put of puts) expect(put.headers["if-none-match"]).toBe("*");
});

test("when every name is taken the paste fails with a toast", async () => {
	const now = new Date("2026-09-22T13:40:00Z");
	const taken = Array.from({ length: PASTE_NAME_TRIES }, (_, i) =>
		pastePath(now, "image/png", i + 1),
	);
	const { view, calls } = await loadedPane(taken);
	vi.useFakeTimers({ toFake: ["Date"], now });
	firePaste(view, [
		{ kind: "file", type: "image/png", getAsFile: () => new File([PNG_BYTES], "p") },
	]);
	vi.useRealTimers();
	await waitFor(() => expect(view.getByText(/already exists/)).toBeTruthy());
	expect(calls.filter((call) => call.method === "PUT")).toHaveLength(PASTE_NAME_TRIES);
	expect(inputsSent()).toEqual([]);
});

// Pastejacking (SPEC.md §24): planted text must not close the paste bracket.

const HOSTILE = "safe\u001b[201~rm -rf ~\n";
const BRACKETED = "\u001b[200~safe[201~rm -rf ~\r\u001b[201~";

test("the paste sanitizer drops control characters but keeps tab and newlines", () => {
	expect(sanitizePaste(HOSTILE)).toBe("safe[201~rm -rf ~\n");
	expect(sanitizePaste("a\tb\r\nc")).toBe("a\tb\r\nc");
	expect(sanitizePaste("a\u0000\u0007\u0008b\u007fc")).toBe("abc");
	expect(sanitizePaste("x\u0080\u009by\u009fz")).toBe("xyz");
	// Printable text beyond the C1 range is left alone.
	expect(sanitizePaste("café  ü 😀")).toBe("café  ü 😀");
});

async function bracketedPane() {
	const pane = await loadedPane();
	act(() => {
		sockets[0]?.onmessage?.({ data: outputBytes("\u001b[?2004h") });
	});
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 20));
	});
	return pane;
}

test("a keyboard paste is sanitized and lands once inside the bracket", async () => {
	const { view } = await bracketedPane();
	const target = view.container.querySelector("textarea");
	const event = new Event("paste", { bubbles: true, cancelable: true });
	Object.defineProperty(event, "clipboardData", {
		value: {
			items: [{ kind: "string", type: "text/plain", getAsFile: () => null }],
			getData: (type: string) => (type === "text/plain" ? HOSTILE : ""),
		},
	});
	act(() => {
		target?.dispatchEvent(event);
	});
	expect(event.defaultPrevented).toBe(true);
	await waitFor(() => expect(inputsSent().join("")).toBe(BRACKETED));
});

test("a right-click paste is sanitized", async () => {
	const { view } = await bracketedPane();
	stubClipboard({
		read: async () => [
			{
				types: ["text/plain"],
				getType: async () => new Blob([HOSTILE], { type: "text/plain" }),
			},
		],
	});
	rightClick(view);
	await waitFor(() => expect(inputsSent().join("")).toBe(BRACKETED));
});

test("the readText fallback is sanitized too", async () => {
	const { view } = await bracketedPane();
	stubClipboard({ readText: async () => HOSTILE });
	rightClick(view);
	await waitFor(() => expect(inputsSent().join("")).toBe(BRACKETED));
});
