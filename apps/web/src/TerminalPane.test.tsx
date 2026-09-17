import type { Terminal } from "@portikus/contracts";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { TerminalPane } from "./TerminalPane";

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
