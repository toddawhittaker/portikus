import { CloseCode } from "@portikus/contracts";
import { ToastProvider } from "@portikus/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { sessionEnded } from "../api/sessionEnded.js";
import { MAX_RECONNECT_ATTEMPTS, RECONNECT_MS } from "../terminal/terminalSocket.js";
import { ChatView } from "./ChatView";

vi.mock("../api/sessionEnded.js", () => ({ sessionEnded: vi.fn() }));

const WORKSPACE = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const TERMINAL = "11111111-1111-4111-8111-111111111111";

class FakeSocket {
	static all: FakeSocket[] = [];
	static OPEN = 1;
	readyState = 0;
	sent: unknown[] = [];
	closed = false;
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onclose: ((event: { code: number }) => void) | null = null;
	constructor(public url: string) {
		FakeSocket.all.push(this);
	}
	send(data: string) {
		this.sent.push(JSON.parse(data));
	}
	close() {
		this.closed = true;
	}
}

let seq = 0;

function latest(): FakeSocket {
	const socket = FakeSocket.all.at(-1);
	if (!socket) throw new Error("no socket");
	return socket;
}

function open() {
	act(() => {
		latest().readyState = 1;
		latest().onopen?.();
	});
}

function emit(type: string, body: Record<string, unknown> = {}) {
	act(() => {
		latest().onmessage?.({
			data: JSON.stringify({ type, sessionId: TERMINAL, seq: seq++, ...body }),
		});
	});
}

function snapshot(body: Record<string, unknown> = {}) {
	emit("snapshot", {
		messages: [],
		cards: [],
		turnRunning: false,
		truncated: false,
		...body,
	});
}

beforeEach(() => {
	seq = 0;
	FakeSocket.all = [];
	vi.stubGlobal("WebSocket", FakeSocket);
	vi.useFakeTimers({
		toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
	});
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.mocked(sessionEnded).mockClear();
});

function draw() {
	const view = render(
		<QueryClientProvider
			client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
		>
			<ToastProvider>
				<ChatView
					workspaceId={WORKSPACE}
					projectId={PROJECT}
					terminalId={TERMINAL}
					visible={true}
				/>
			</ToastProvider>
		</QueryClientProvider>,
	);
	open();
	return view;
}

test("it connects to the tab's chat socket and shows a skeleton until the snapshot", () => {
	draw();
	expect(latest().url).toBe(
		`ws://${location.host}/workspaces/${WORKSPACE}/terminals/${TERMINAL}/chat`,
	);
	expect(screen.getByTestId("chat-loading")).toBeTruthy();
	snapshot();
	expect(screen.getByText("No messages yet")).toBeTruthy();
});

test("a streamed turn shows Working, then folds its work into Worked for", () => {
	draw();
	snapshot({
		messages: [{ id: "u0", role: "user", markdown: "Fix the bug" }],
		truncated: true,
	});
	expect(screen.getByText("Earlier messages are not shown")).toBeTruthy();
	// Past the replay of history, so this turn is timed live.
	act(() => vi.advanceTimersByTime(2_000));
	emit("turn.started");
	emit("text.delta", { messageId: "a1", text: "Looking at " });
	emit("text.delta", { messageId: "a1", text: "**the code**" });
	expect(screen.getByText("the code").tagName).toBe("STRONG");
	expect(screen.getByTestId("chat-working").textContent).toBe("Working 0m 0s");
	act(() => vi.advanceTimersByTime(12_000));
	expect(screen.getByTestId("chat-working").textContent).toBe("Working 0m 12s");
	expect(screen.getByTestId("chat-announcer").textContent).toBe("Claude is working.");

	emit("message", { id: "a1", role: "assistant", markdown: "Looking at **the code**" });
	emit("tool.started", {
		id: "t1",
		name: "Bash",
		title: "pnpm test",
		input: { command: "pnpm test" },
	});
	emit("tool.finished", { id: "t1", isError: false });
	emit("message", { id: "a2", role: "assistant", markdown: "Still checking" });
	emit("message", { id: "a3", role: "assistant", markdown: "Fixed it." });
	act(() => vi.advanceTimersByTime(211_000));
	emit("turn.finished", { status: "done" });

	expect(screen.queryByTestId("chat-working")).toBeNull();
	const worked = screen.getByTestId("chat-worked");
	expect(worked.querySelector("summary")?.textContent).toBe("Worked for 3m 43s");
	expect(within(worked).getByText("Still checking")).toBeTruthy();
	expect(within(worked).getByTestId("chat-tool-t1")).toBeTruthy();
	const shown = screen
		.getAllByTestId("chat-assistant-message")
		.filter((li) => !worked.contains(li));
	expect(shown.map((li) => li.textContent)).toEqual([
		"Claude said:Looking at the code",
		"Claude said:Fixed it.",
	]);
	expect(screen.getByTestId("chat-announcer").textContent).toBe("Claude finished.");
});

test("a question card is pinned, announced, answered, and cleared on card.resolved", () => {
	draw();
	snapshot();
	emit("question.requested", {
		id: "q1",
		questions: [
			{
				question: "Which?",
				header: "Pick",
				multiSelect: false,
				options: [
					{ label: "A", description: "" },
					{ label: "B", description: "" },
				],
			},
		],
	});
	expect(screen.getByTestId("chat-announcer").textContent).toBe(
		"Claude has a question: Which?",
	);
	expect(document.activeElement).toBe(screen.getByRole("radio", { name: "A" }));
	const radio = screen.getByRole("radio", { name: "B" });
	fireEvent.click(radio);
	fireEvent.click(screen.getByRole("button", { name: "Send answer" }));
	expect(latest().sent).toEqual([
		{ type: "question.answer", id: "q1", answers: { "Which?": "B" } },
	]);
	emit("card.resolved", { id: "q1" });
	expect(screen.queryByTestId("chat-question-card")).toBeNull();
	// The answered card took the focus with it; it goes to the composer.
	expect(document.activeElement).toBe(screen.getByTestId("chat-composer-input"));
});

test("a card resolved elsewhere goes, and the next waiting card shows", () => {
	draw();
	const permission = (id: string) => ({
		type: "permission",
		id,
		toolName: "Bash",
		title: "",
		input: { command: "ls" },
		options: [{ id: "allow", label: "Allow" }],
	});
	snapshot({ cards: [permission("p1"), permission("p2")] });
	expect(screen.getByTestId("chat-cards-waiting").textContent).toBe(
		"1 more request is waiting",
	);
	emit("card.resolved", { id: "p1" });
	expect(screen.getAllByTestId("chat-permission-card")).toHaveLength(1);
	expect(screen.queryByTestId("chat-cards-waiting")).toBeNull();
	fireEvent.click(screen.getByRole("button", { name: "Allow" }));
	expect(latest().sent).toEqual([
		{ type: "permission.answer", id: "p2", optionId: "allow" },
	]);
});

test("the composer sends what was typed", () => {
	draw();
	snapshot();
	const box = screen.getByTestId("chat-composer-input");
	fireEvent.change(box, { target: { value: "Add a test" } });
	fireEvent.keyDown(box, { key: "Enter" });
	expect(latest().sent).toEqual([
		{ type: "send", text: "Add a test", attachments: [] },
	]);
	expect((box as HTMLTextAreaElement).value).toBe("");
});

test("a dropped socket reconnects and takes a fresh snapshot", () => {
	draw();
	snapshot({ messages: [{ id: "a1", role: "assistant", markdown: "before" }] });
	act(() => latest().onclose?.({ code: 1006 }));
	expect(screen.getByTestId("chat-connection").textContent).toBe("Reconnecting…");
	// The conversation stays on screen while reconnecting.
	expect(screen.getByText("before")).toBeTruthy();
	act(() => vi.advanceTimersByTime(RECONNECT_MS));
	expect(FakeSocket.all).toHaveLength(2);
	open();
	seq = 0;
	snapshot({ messages: [{ id: "a1", role: "assistant", markdown: "after" }] });
	expect(screen.getByText("after")).toBeTruthy();
	expect(screen.getByTestId("chat-connection").textContent).toBe("");
});

test("retrying stops after repeated failures and says what to do", () => {
	draw();
	for (let attempt = 0; attempt < MAX_RECONNECT_ATTEMPTS; attempt++) {
		act(() => latest().onclose?.({ code: 1006 }));
		act(() => vi.advanceTimersByTime(60_000));
	}
	expect(screen.getByTestId("chat-connection").textContent).toBe(
		"This chat lost its connection. Reload the page to try again.",
	);
});

test("a tab that is not a chat says so, and a signed-out session hands over", () => {
	draw();
	act(() => latest().onclose?.({ code: CloseCode.NOT_FOUND }));
	expect(screen.getByTestId("chat-connection").textContent).toContain(
		"no longer available",
	);
	cleanup();
	draw();
	act(() => latest().onclose?.({ code: CloseCode.SESSION_ENDED }));
	expect(sessionEnded).toHaveBeenCalledTimes(1);
});

test("unmounting closes the socket", () => {
	const view = draw();
	const socket = latest();
	view.unmount();
	expect(socket.closed).toBe(true);
});

test("history replayed after the snapshot folds its turns without a made-up length", () => {
	draw();
	snapshot({ messages: [{ id: "u0", role: "user", markdown: "Earlier question" }] });
	emit("turn.started");
	emit("message", { id: "a1", role: "assistant", markdown: "First look" });
	emit("tool.started", { id: "t1", name: "Read", title: "a.ts", input: {} });
	emit("tool.finished", { id: "t1", isError: false });
	emit("message", { id: "a2", role: "assistant", markdown: "Answer" });
	emit("turn.finished", { status: "done" });
	emit("message", { id: "u1", role: "user", markdown: "Still running?" });
	emit("turn.started");
	expect(screen.getByTestId("chat-worked").querySelector("summary")?.textContent).toBe(
		"Worked",
	);
	expect(screen.getByTestId("chat-working").textContent).toBe("Working");
	const users = screen.getAllByTestId("chat-user-message").map((li) => li.textContent);
	expect(users).toEqual(["You said:Earlier question", "You said:Still running?"]);
});

test("too many open sockets stops retrying and says what to do", () => {
	draw();
	act(() => latest().onclose?.({ code: CloseCode.TOO_MANY_SOCKETS }));
	act(() => vi.advanceTimersByTime(60_000));
	expect(FakeSocket.all).toHaveLength(1);
	expect(screen.getByTestId("chat-connection").textContent).toContain("too many chats");
});

test("an answer or message on a closed socket says it was not sent", () => {
	draw();
	snapshot({
		cards: [
			{
				type: "permission",
				id: "p1",
				toolName: "Bash",
				title: "",
				input: {},
				options: [{ id: "allow", label: "Allow" }],
			},
		],
	});
	act(() => {
		latest().readyState = 3;
		latest().onclose?.({ code: 1006 });
	});
	fireEvent.click(screen.getByRole("button", { name: "Allow" }));
	expect(screen.getByTestId("chat-permission-card").textContent).toContain(
		"Your answer was not sent",
	);
	const box = screen.getByTestId("chat-composer-input");
	fireEvent.change(box, { target: { value: "hello" } });
	fireEvent.keyDown(box, { key: "Enter" });
	expect(screen.getByText(/Your message was not sent/)).toBeTruthy();
	expect((box as HTMLTextAreaElement).value).toBe("hello");
});

test("scrolling up stops the view following new text", () => {
	draw();
	snapshot();
	const box = document.querySelector<HTMLElement>(".pk-chat-scroll");
	if (!box) throw new Error("no scroll box");
	Object.defineProperty(box, "scrollHeight", { value: 2000, configurable: true });
	Object.defineProperty(box, "clientHeight", { value: 400, configurable: true });
	box.scrollTop = 100;
	fireEvent.scroll(box);
	emit("message", { id: "a1", role: "assistant", markdown: "new" });
	expect(box.scrollTop).toBe(100);
});
