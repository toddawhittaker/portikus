import type { Terminal } from "@portikus/contracts";
import { ToastProvider } from "@portikus/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { createQueryClient } from "./api/queryClient.js";
import {
	decodeOsc52,
	MAX_CLIPBOARD_BYTES,
	SCROLLBACK_LINES,
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
) {
	stubBrowserApis();
	vi.stubGlobal("WebSocket", FakeWebSocket);
	const view = render(
		<QueryClientProvider client={createQueryClient(() => {})}>
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
	expect(dark.red).toBeUndefined();
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
