import type { Terminal } from "@portikus/contracts";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { SCROLLBACK_LINES, TerminalPane } from "./TerminalPane";

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

function renderPane(onExited = vi.fn(), onCwd = vi.fn()) {
	stubBrowserApis();
	vi.stubGlobal("WebSocket", FakeWebSocket);
	const view = render(
		<TerminalPane
			workspaceId={WORKSPACE}
			projectId={PROJECT}
			terminal={terminal}
			visible={true}
			onExited={onExited}
			onSessionEnded={vi.fn()}
			onCwd={onCwd}
			onFocus={vi.fn()}
			onLeave={vi.fn()}
		/>,
	);
	return { view, onExited, onCwd };
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

test("the terminal keeps a deep scrollback and lets the wheel through", async () => {
	// The wheel is the only way back through it, so nothing the pane installs
	// may cancel a wheel event before xterm.js sees it (SPEC.md §9.1).
	expect(SCROLLBACK_LINES).toBeGreaterThanOrEqual(5_000);

	const { view } = renderPane();
	await waitFor(() => expect(sockets).toHaveLength(1));
	const pane = view.getByTestId(`terminal-pane-${terminal.id}`);
	const screen = pane.querySelector(".xterm-screen") ?? pane;

	const wheel = new WheelEvent("wheel", {
		deltaY: -300,
		bubbles: true,
		cancelable: true,
	});
	act(() => {
		screen.dispatchEvent(wheel);
	});
	expect(wheel.defaultPrevented).toBe(false);
});
