import type { Terminal } from "@portikus/contracts";
import { ToastProvider } from "@portikus/ui";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import {
	decodeOsc52,
	MAX_CLIPBOARD_BYTES,
	SCROLLBACK_LINES,
	TerminalPane,
} from "./TerminalPane";

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

function renderPane(onExited = vi.fn(), onCwd = vi.fn(), visible = true) {
	stubBrowserApis();
	vi.stubGlobal("WebSocket", FakeWebSocket);
	const view = render(
		<ToastProvider>
			<TerminalPane
				workspaceId={WORKSPACE}
				projectId={PROJECT}
				terminal={terminal}
				visible={visible}
				onExited={onExited}
				onSessionEnded={vi.fn()}
				onCwd={onCwd}
				onFocus={vi.fn()}
				onLeave={vi.fn()}
			/>
		</ToastProvider>,
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
