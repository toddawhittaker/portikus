import { CloseCode, EDITOR_SETTINGS_DEFAULTS } from "@portikus/contracts";
import { QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { Terminal as Xterm } from "@xterm/xterm";
import { afterEach, expect, test, vi } from "vitest";
import { createQueryClient } from "../../api/queryClient.js";
import { editorSettingsKey } from "../../editor/settingsQueries.js";
import {
	HelperTerminal,
	type HelperTerminalProps,
	openClickedLink,
	swallowUnsafeSequences,
} from "./HelperTerminal.js";
import { helperCloseAction } from "./helperClose.js";

const PATH = "/courses/c1/live-help/s1/terminals/t1/ws";

const sockets: FakeWebSocket[] = [];

class FakeWebSocket {
	static readonly OPEN = 1;
	readonly url: string;
	readyState = FakeWebSocket.OPEN;
	binaryType = "blob";
	sent: string[] = [];
	closed = false;
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
		this.closed = true;
	}
}

afterEach(() => {
	cleanup();
	sockets.length = 0;
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

/** jsdom has neither of these, and xterm.js needs both. */
function stubBrowserApis() {
	vi.stubGlobal(
		"matchMedia",
		vi.fn(() => ({
			matches: false,
			addListener: vi.fn(),
			removeListener: vi.fn(),
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
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
	vi.stubGlobal("WebSocket", FakeWebSocket);
}

function renderTerminal(overrides: Partial<HelperTerminalProps> = {}) {
	stubBrowserApis();
	const client = createQueryClient();
	client.setQueryData(editorSettingsKey, EDITOR_SETTINGS_DEFAULTS);
	const props: HelperTerminalProps = {
		path: PATH,
		name: "Terminal 1",
		typing: false,
		onClosed: vi.fn(),
		onDropped: vi.fn(),
		onRetry: vi.fn(),
		onLeave: vi.fn(),
		...overrides,
	};
	const view = render(
		<QueryClientProvider client={client}>
			<HelperTerminal {...props} />
		</QueryClientProvider>,
	);
	const socket = sockets.at(-1);
	if (!socket) throw new Error("no socket opened");
	return { view, props, socket, host: view.getByTestId("helper-terminal") };
}

function paste(view: ReturnType<typeof render>, text: string) {
	const target = view.container.querySelector("textarea");
	if (!target) throw new Error("no xterm textarea");
	const event = new Event("paste", { bubbles: true, cancelable: true });
	Object.defineProperty(event, "clipboardData", {
		value: { items: [], getData: () => text },
	});
	act(() => {
		target.dispatchEvent(event);
	});
}

function inputsSent(socket: FakeWebSocket): string[] {
	return socket.sent
		.map((frame) => JSON.parse(frame) as { type: string; data?: string })
		.filter((frame) => frame.type === "input")
		.map((frame) => frame.data ?? "");
}

test("it attaches to the live help path with a starting size", () => {
	const { socket, host } = renderTerminal();
	expect(socket.url).toMatch(
		/\/courses\/c1\/live-help\/s1\/terminals\/t1\/ws\?cols=80&rows=24$/,
	);
	expect(host.dataset.cols).toBe("80");
	expect(host.dataset.mode).toBe("view");
});

test("a size frame fixes the terminal to the student's pane size", async () => {
	const { socket, host } = renderTerminal();
	act(() => {
		socket.onmessage?.({ data: JSON.stringify({ type: "size", cols: 132, rows: 40 }) });
	});
	await waitFor(() => expect(host.dataset.cols).toBe("132"));
	expect(host.dataset.rows).toBe("40");
	// The helper never asks the student's pane to change size.
	expect(socket.sent.some((frame) => frame.includes('"resize"'))).toBe(false);
});

test("in view mode nothing typed or pasted is sent", () => {
	const { view, socket } = renderTerminal({ typing: false });
	paste(view, "rm -rf ~");
	expect(inputsSent(socket)).toEqual([]);
});

test("in type mode a paste is sent as input, with control characters removed", () => {
	const { view, socket } = renderTerminal({ typing: true });
	paste(view, "ls\u001b[201~ -la");
	expect(inputsSent(socket).join("")).toContain("ls[201~ -la");
	expect(inputsSent(socket).join("")).not.toContain("\u001b[201~");
});

test("a mode change, an end and the student leaving each stop the socket and tell the page", () => {
	for (const [code, action] of [
		[CloseCode.LIVE_HELP_MODE_CHANGED, "reconnect"],
		[CloseCode.LIVE_HELP_ENDED, "ended"],
		[CloseCode.POLICY, "away"],
	] as const) {
		vi.useFakeTimers();
		const { socket, props } = renderTerminal();
		const count = sockets.length;
		act(() => socket.onclose?.({ code }));
		expect(props.onClosed).toHaveBeenCalledWith(action);
		act(() => {
			vi.advanceTimersByTime(60_000);
		});
		// No retry of its own: the page decides when to attach again.
		expect(sockets).toHaveLength(count);
		cleanup();
		vi.useRealTimers();
	}
});

test("any other close is retried as an ordinary drop", () => {
	vi.useFakeTimers();
	const { socket, props } = renderTerminal();
	act(() => socket.onclose?.({ code: 1006 }));
	expect(props.onClosed).not.toHaveBeenCalled();
	act(() => {
		vi.advanceTimersByTime(3_000);
	});
	expect(sockets).toHaveLength(2);
});

test("helperCloseAction maps only the live help close codes", () => {
	expect(helperCloseAction(CloseCode.LIVE_HELP_MODE_CHANGED)).toBe("reconnect");
	expect(helperCloseAction(CloseCode.LIVE_HELP_ENDED)).toBe("ended");
	expect(helperCloseAction(CloseCode.POLICY)).toBe("away");
	expect(helperCloseAction(CloseCode.SESSION_ENDED)).toBeNull();
	expect(helperCloseAction(CloseCode.TOO_MANY_SOCKETS)).toBeNull();
	expect(helperCloseAction(1006)).toBeNull();
});

/** Write to a terminal and wait until xterm has parsed it. */
function written(term: Xterm, data: string): Promise<void> {
	return new Promise((resolve) => term.write(data, resolve));
}

test("OSC 52 clipboard writes and title sequences never reach anything behind the guard", async () => {
	stubBrowserApis();
	const term = new Xterm();
	term.open(document.createElement("div"));
	// Stands in for any clipboard handler xterm or an addon might add.
	const clipboard = vi.fn(() => true);
	term.parser.registerOscHandler(52, clipboard);
	const titles = vi.fn();
	term.onTitleChange(titles);
	swallowUnsafeSequences(term);

	await written(term, "\u001b]52;c;aGVsbG8=\u0007");
	await written(term, "\u001b]0;owned\u0007\u001b]2;owned\u0007");
	expect(clipboard).not.toHaveBeenCalled();
	expect(titles).not.toHaveBeenCalled();
	term.dispose();
});

test("the terminal itself ignores OSC 52 and title output from the student's workspace", async () => {
	const writeText = vi.fn();
	vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
	const before = document.title;
	const { socket } = renderTerminal({ typing: true });
	const encoder = new TextEncoder();
	act(() => {
		socket.onmessage?.({
			data: encoder.encode("\u001b]52;c;aGVsbG8=\u0007\u001b]2;owned\u0007").buffer,
		});
	});
	await new Promise((resolve) => setTimeout(resolve, 50));
	expect(writeText).not.toHaveBeenCalled();
	expect(document.title).toBe(before);
});

test("a clicked link opens in a new tab with no opener, and only for web addresses", () => {
	const open = vi.fn();
	vi.stubGlobal("open", open);
	openClickedLink("https://example.edu/docs");
	expect(open).toHaveBeenCalledWith(
		"https://example.edu/docs",
		"_blank",
		"noopener,noreferrer",
	);
	open.mockClear();
	openClickedLink("javascript:alert(1)");
	openClickedLink("https://user:pw@example.edu/");
	expect(open).not.toHaveBeenCalled();
});

test("Alt+Shift+Q hands the keyboard back to the page", () => {
	const { view, props } = renderTerminal();
	const textarea = view.container.querySelector("textarea");
	if (!textarea) throw new Error("no xterm textarea");
	act(() => {
		textarea.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "Q",
				code: "KeyQ",
				altKey: true,
				shiftKey: true,
				bubbles: true,
			}),
		);
	});
	expect(props.onLeave).toHaveBeenCalled();
});
