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
import { type LayoutStore, LayoutStoreContext } from "../layout/store.js";
import { MAX_RECONNECT_ATTEMPTS, RECONNECT_MS } from "../terminal/terminalSocket.js";
import { speakingId } from "../voice/speak.js";
import { ChatView } from "./ChatView";
import { boxText, setText } from "./composerTesting.js";
import { installFakeSpeech, removeFakeSpeech } from "./speechTesting.js";

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

function draw({ focused = false, onLeave = vi.fn() } = {}) {
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
					focused={focused}
					onLeave={onLeave}
				/>
			</ToastProvider>
		</QueryClientProvider>,
	);
	open();
	return { ...view, onLeave };
}

/** One finished turn, as the host replays it: real times, one frame each. */
function replayTurn(at: number, ms: number, user: string, answer: string) {
	emit("message", { id: `u-${at}`, role: "user", markdown: user });
	emit("turn.started", { at });
	emit("message", { id: `a-${at}`, role: "assistant", markdown: answer });
	emit("turn.finished", { at: at + ms, status: "done" });
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

test("a starter prompt fills an empty message box to edit, keeps a draft, and sends nothing", () => {
	draw();
	snapshot();
	const empty = screen.getByTestId("chat-empty");
	expect(empty.textContent).toContain("kept in your workspace, not by Portikus");
	const starters = within(empty).getAllByRole("button");
	expect(starters.map((button) => button.textContent)).toEqual([
		"Explain how this project is organised",
		"Find a bug and explain it before fixing it",
		"Write tests for the main file",
	]);
	const box = screen.getByTestId("chat-composer-input");
	const sent = latest().sent.length;
	const writeTests = within(empty).getByRole("button", {
		name: "Write tests for the main file",
	});
	fireEvent.click(writeTests);
	expect(boxText(box)).toBe("Write tests for the main file");
	expect(document.activeElement).toBe(box);
	// A draft the student typed is never thrown away.
	setText(box, "my own words");
	writeTests.focus();
	fireEvent.click(within(empty).getByRole("button", { name: /^Explain how/ }));
	expect(boxText(box)).toBe("my own words");
	expect(document.activeElement).toBe(box);
	expect(latest().sent).toHaveLength(sent);
	// Once a conversation exists the starters go.
	emit("message", { id: "u1", role: "user", markdown: "hi" });
	expect(screen.queryByTestId("chat-empty")).toBeNull();
});

test("a streamed turn shows Working, then folds its work into Worked for", () => {
	draw();
	snapshot({ truncated: true });
	emit("message", { id: "u0", role: "user", markdown: "Fix the bug" });
	expect(screen.getByText("Earlier messages are not shown")).toBeTruthy();
	emit("turn.started", { at: Date.now() });
	emit("text.delta", { messageId: "a1", text: "Looking at " });
	emit("text.delta", { messageId: "a1", text: "**the code**" });
	expect(screen.getByText("the code").tagName).toBe("STRONG");
	expect(screen.getByTestId("chat-working").textContent).toBe(
		"Writing a reply · 0m 0s",
	);
	act(() => vi.advanceTimersByTime(12_000));
	expect(screen.getByTestId("chat-working").textContent).toBe(
		"Writing a reply · 0m 12s",
	);
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
	emit("turn.finished", { at: Date.now() + 211_000, status: "done" });

	expect(screen.queryByTestId("chat-working")).toBeNull();
	const worked = screen.getByTestId("chat-worked");
	expect(worked.querySelector("summary")?.textContent).toBe(
		"Worked for 3m 43s1 tool call",
	);
	expect(within(worked).getByText("Still checking")).toBeTruthy();
	expect(within(worked).getByTestId("chat-tool-t1")).toBeTruthy();
	const shown = screen
		.getAllByTestId("chat-assistant-message")
		.filter((li) => !worked.contains(li));
	expect(shown.map((li) => li.textContent)).toEqual([
		"Looking at the code",
		"Fixed it.",
	]);
	// The turn carries Claude's byline once.
	expect(within(screen.getByTestId("chat-turn")).getAllByText("Claude")).toHaveLength(
		1,
	);
	expect(screen.getByTestId("chat-announcer").textContent).toBe("Claude finished.");
});

test("what Claude asked stays in view after the turn, with each answer or Skipped", () => {
	draw();
	snapshot();
	emit("turn.started", { at: Date.now() });
	emit("message", { id: "a1", role: "assistant", markdown: "Let me ask." });
	emit("tool.started", {
		id: "q1",
		name: "AskUserQuestion",
		title: "AskUserQuestion",
		input: { questions: [{ question: "Which?" }, { question: "Why?" }] },
	});
	expect(screen.getByTestId("chat-asked-outcome").textContent).toBe("Needs your input");
	emit("tool.output", {
		id: "q1",
		part: {
			type: "text",
			text: 'Your questions have been answered: "Which?"="B". You can now continue with these answers in mind.',
		},
	});
	emit("tool.finished", { id: "q1", isError: false });
	emit("tool.started", { id: "t1", name: "Read", title: "a.ts", input: {} });
	emit("tool.finished", { id: "t1", isError: false });
	emit("message", { id: "a2", role: "assistant", markdown: "Done." });
	emit("turn.finished", { at: Date.now() + 1000, status: "done" });

	const asked = screen.getByTestId("chat-asked");
	expect(screen.getByTestId("chat-worked").contains(asked)).toBe(false);
	expect(asked.querySelector("summary")?.textContent).toBe("Asked 2 questionsAnswered");
	expect(
		within(asked)
			.getAllByRole("definition")
			.map((dd) => dd.textContent),
	).toEqual(["B", "Skipped"]);
	expect(screen.getByTestId("chat-worked").querySelector("summary")?.textContent).toBe(
		"Worked for 0m 1s1 tool call",
	);
});

test("a result in a form not read is shown once, under all the questions", () => {
	draw();
	snapshot();
	emit("turn.started", { at: Date.now() });
	emit("tool.started", {
		id: "q1",
		name: "AskUserQuestion",
		title: "AskUserQuestion",
		input: { questions: [{ question: "Which?" }, { question: "Why?" }] },
	});
	emit("tool.output", {
		id: "q1",
		part: { type: "text", text: "Picked B, for speed." },
	});
	emit("tool.finished", { id: "q1", isError: false });
	emit("turn.finished", { at: Date.now() + 1000, status: "done" });

	const asked = screen.getByTestId("chat-asked");
	expect(
		within(asked)
			.getAllByRole("term")
			.map((dt) => dt.textContent),
	).toEqual(["Which?", "Why?"]);
	expect(
		within(asked)
			.getAllByRole("definition")
			.map((dd) => dd.textContent),
	).toEqual(["Picked B, for speed."]);
	expect(screen.getByTestId("chat-asked-outcome").textContent).toBe("Answered");
});

test("the Working line says Awaiting approval while a permission card is open", () => {
	draw();
	snapshot();
	emit("turn.started", { at: Date.now() });
	emit("tool.started", {
		id: "p1",
		name: "Bash",
		title: "pnpm test",
		input: { command: "pnpm test" },
	});
	emit("permission.requested", {
		id: "p1",
		toolName: "Bash",
		title: "pnpm test",
		input: { command: "pnpm test" },
		options: [{ id: "allow", label: "Allow once" }],
	});
	const working = () => screen.getByTestId("chat-working").textContent ?? "";
	expect(working()).toMatch(/^Awaiting approval · /);
	// The card's own header carries the one needs-input tag.
	expect(
		screen
			.getByTestId("chat-permission-card")
			.querySelector("[data-testid=chat-needs-input]")?.textContent,
	).toBe("Needs your input");
	emit("card.resolved", { id: "p1" });
	expect(working()).toMatch(/^Running pnpm test · /);
	// Its row says it the same way.
	expect(screen.getByTestId("chat-tool-p1").querySelector("summary")?.textContent).toBe(
		"Running pnpm test",
	);
});

test("a permission card whose tool call has not arrived still reads Awaiting approval", () => {
	draw();
	snapshot();
	emit("turn.started", { at: Date.now() });
	emit("permission.requested", {
		id: "p9",
		toolName: "Bash",
		title: "pytest",
		input: { command: "pytest" },
		options: [{ id: "allow", label: "Allow once" }],
	});
	expect(screen.getByTestId("chat-working").textContent).toMatch(
		/^Awaiting approval · /,
	);
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
	fireEvent.click(screen.getByRole("button", { name: "Submit" }));
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
		"1 more request is waiting.",
	);
	expect(screen.getByTestId("chat-announcer").textContent).toBe(
		"Claude wants to use Bash. 1 more request is waiting.",
	);
	emit("card.resolved", { id: "p1" });
	expect(screen.getAllByTestId("chat-permission-card")).toHaveLength(1);
	expect(screen.queryByTestId("chat-cards-waiting")).toBeNull();
	fireEvent.click(screen.getByRole("button", { name: "Allow" }));
	expect(latest().sent).toEqual([
		{ type: "permission.answer", id: "p2", optionId: "allow" },
	]);
});

test("the composer sends what was typed, and clears it when the host echoes it", () => {
	draw();
	snapshot();
	const box = screen.getByTestId("chat-composer-input");
	setText(box, "Add a test");
	fireEvent.keyDown(box, { key: "Enter" });
	expect(latest().sent).toEqual([
		{ type: "send", text: "Add a test", attachments: [] },
	]);
	// Not yet echoed: the draft stays, and a second Enter does not send it again.
	expect(boxText(box)).toBe("Add a test");
	fireEvent.keyDown(box, { key: "Enter" });
	expect(latest().sent).toHaveLength(1);
	emit("message", { id: "u1", role: "user", markdown: "Add a test" });
	expect(boxText(box)).toBe("");
});

test("a send the host refuses keeps the draft to try again", () => {
	draw();
	snapshot();
	const box = screen.getByTestId("chat-composer-input");
	setText(box, "Look at this");
	fireEvent.keyDown(box, { key: "Enter" });
	emit("error", { message: "That picture is not a PNG." });
	expect(screen.getByTestId("chat-error").textContent).toContain("not a PNG");
	expect(boxText(box)).toBe("Look at this");
	fireEvent.keyDown(box, { key: "Enter" });
	expect(latest().sent).toHaveLength(2);
});

test("typing in the composer keeps the keyboard when a card arrives", () => {
	draw();
	snapshot();
	const box = screen.getByTestId("chat-composer-input");
	box.focus();
	setText(box, "and also");
	emit("permission.requested", {
		id: "p1",
		toolName: "Bash",
		title: "",
		input: { command: "rm -rf build" },
		options: [{ id: "allow", label: "Allow" }],
	});
	expect(document.activeElement).toBe(box);
	// Enter sends the message; it never answers the card.
	fireEvent.keyDown(box, { key: "Enter" });
	expect(latest().sent).toEqual([{ type: "send", text: "and also", attachments: [] }]);
	expect(screen.getByTestId("chat-announcer").textContent).toBe(
		"Claude wants to use Bash.",
	);
});

test("a chat opened as the focused pane puts the keyboard in its message box", () => {
	draw({ focused: true });
	expect(document.activeElement).toBe(screen.getByTestId("chat-composer-input"));
});

test("Alt+Shift+Q leaves the chat for the tab strip", () => {
	const { onLeave } = draw();
	snapshot();
	fireEvent.keyDown(screen.getByTestId("chat-composer-input"), {
		key: "Q",
		altKey: true,
		shiftKey: true,
	});
	expect(onLeave).toHaveBeenCalledTimes(1);
});

test("a card shown again by a new snapshot can be answered again", () => {
	draw();
	const card = {
		type: "permission",
		id: "p1",
		toolName: "Bash",
		title: "",
		input: { command: "ls" },
		options: [{ id: "allow", label: "Allow" }],
	};
	snapshot({ cards: [card] });
	fireEvent.click(screen.getByRole("button", { name: "Allow" }));
	expect(screen.getByRole("button", { name: "Allow" }).getAttribute("aria-busy")).toBe(
		"true",
	);
	// The answer was lost with the connection; the host still holds the card.
	act(() => latest().onclose?.({ code: 1006 }));
	act(() => vi.advanceTimersByTime(RECONNECT_MS));
	open();
	act(() => vi.advanceTimersByTime(5));
	snapshot({ cards: [card] });
	const allow = screen.getByRole("button", { name: "Allow" });
	expect(allow.getAttribute("aria-busy")).toBeNull();
	fireEvent.click(allow);
	expect(latest().sent).toEqual([
		{ type: "permission.answer", id: "p1", optionId: "allow" },
	]);
});

test("a dropped socket reconnects and takes a fresh snapshot", () => {
	draw();
	snapshot();
	emit("message", { id: "a1", role: "assistant", markdown: "before" });
	act(() => latest().onclose?.({ code: 1006 }));
	expect(screen.getByTestId("chat-connection").textContent).toBe("Reconnecting…");
	// The conversation stays on screen while reconnecting.
	expect(screen.getByText("before")).toBeTruthy();
	act(() => vi.advanceTimersByTime(RECONNECT_MS));
	expect(FakeSocket.all).toHaveLength(2);
	open();
	seq = 0;
	snapshot();
	emit("message", { id: "a1", role: "assistant", markdown: "after" });
	expect(screen.getByText("after")).toBeTruthy();
	expect(screen.queryByText("before")).toBeNull();
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

test("history replayed after the snapshot keeps each turn's real length", () => {
	draw();
	const now = Date.now();
	snapshot({ turnRunning: true });
	emit("message", { id: "u0", role: "user", markdown: "Earlier question" });
	emit("turn.started", { at: now - 600_000 });
	emit("message", { id: "a1", role: "assistant", markdown: "First look" });
	emit("tool.started", { id: "t1", name: "Read", title: "a.ts", input: {} });
	emit("tool.finished", { id: "t1", isError: false });
	emit("message", { id: "a2", role: "assistant", markdown: "Answer" });
	emit("turn.finished", { at: now - 600_000 + 223_000, status: "done" });
	emit("message", { id: "u1", role: "user", markdown: "Still running?" });
	emit("turn.started", { at: now - 34_000 });
	expect(screen.getByTestId("chat-worked").querySelector("summary")?.textContent).toBe(
		"Worked for 3m 43s1 tool call",
	);
	expect(screen.getByTestId("chat-working").textContent).toBe("Working 0m 34s");
	const users = screen.getAllByTestId("chat-user-message").map((li) => li.textContent);
	expect(users).toEqual(["You said:Earlier question", "You said:Still running?"]);
	replayTurn(now, 5_000, "More", "Done");
	expect(screen.getAllByTestId("chat-worked")).toHaveLength(1);
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
	setText(box, "hello");
	fireEvent.keyDown(box, { key: "Enter" });
	expect(screen.getByText(/Your message was not sent/)).toBeTruthy();
	expect(boxText(box)).toBe("hello");
});

test("scrolling up stops the view following new text", () => {
	draw();
	snapshot();
	const box = document.querySelector<HTMLElement>(".pk-chat-scroll");
	if (!box) throw new Error("no scroll box");
	Object.defineProperty(box, "scrollHeight", { value: 2000, configurable: true });
	Object.defineProperty(box, "clientHeight", { value: 400, configurable: true });
	box.scrollTop = 1600;
	fireEvent.scroll(box);
	box.scrollTop = 100;
	fireEvent.scroll(box);
	const jump = screen.getByRole("button", { name: "Jump to latest" });
	// Nothing new yet: no dot.
	expect(jump.getAttribute("data-fresh")).toBeNull();
	emit("message", { id: "a1", role: "assistant", markdown: "new" });
	expect(box.scrollTop).toBe(100);
	expect(jump.getAttribute("data-fresh")).toBe("true");
	expect(jump.getAttribute("aria-describedby")).toBeTruthy();
	expect(
		document.getElementById(jump.getAttribute("aria-describedby") ?? "")?.textContent,
	).toBe("Something new arrived below");
	// The way back to the end, which hands the keyboard to the message box.
	fireEvent.click(screen.getByRole("button", { name: "Jump to latest" }));
	expect(box.scrollTop).toBe(2000);
	expect(screen.queryByRole("button", { name: "Jump to latest" })).toBeNull();
	expect(document.activeElement).toBe(screen.getByTestId("chat-composer-input"));
});

test("Escape, sending and closing the chat each stop a reply being read", () => {
	installFakeSpeech();
	try {
		const view = draw();
		snapshot();
		emit("message", { id: "a1", role: "assistant", markdown: "Hello there." });
		const root = screen.getByTestId(`chat-view-${TERMINAL}`);

		fireEvent.click(screen.getByRole("button", { name: "Read aloud" }));
		expect(speakingId()).toBe("a1");
		fireEvent.keyDown(root, { key: "Escape" });
		expect(speakingId()).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Read aloud" }));
		const box = screen.getByTestId("chat-composer-input");
		setText(box, "Thanks");
		fireEvent.keyDown(box, { key: "Enter" });
		expect(speakingId()).toBeNull();

		fireEvent.click(screen.getByRole("button", { name: "Read aloud" }));
		expect(speakingId()).toBe("a1");
		view.unmount();
		expect(speakingId()).toBeNull();
	} finally {
		removeFakeSpeech();
	}
});

test("Escape in an open menu closes the menu and leaves the speech going", () => {
	installFakeSpeech();
	try {
		draw();
		snapshot();
		emit("message", { id: "a1", role: "assistant", markdown: "Hello there." });
		fireEvent.click(screen.getByRole("button", { name: "Read aloud" }));
		const trigger = document.createElement("button");
		trigger.setAttribute("aria-haspopup", "menu");
		trigger.setAttribute("aria-expanded", "true");
		document.body.append(trigger);
		fireEvent.keyDown(screen.getByTestId(`chat-view-${TERMINAL}`), { key: "Escape" });
		expect(speakingId()).toBe("a1");
		trigger.remove();
	} finally {
		removeFakeSpeech();
	}
});

test("a finished turn is read aloud when the project's switch is on, and its tools are not", async () => {
	installFakeSpeech();
	try {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					model: "default",
					effort: "high",
					mode: "default",
					readAloud: true,
				}),
			),
		);
		const synth = globalThis.speechSynthesis as unknown as {
			spoken: { text: string }[];
		};
		draw();
		snapshot();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(0);
		});
		expect(
			screen
				// In the closed options panel.
				.getByRole("switch", { name: "Read replies aloud", hidden: true })
				.getAttribute("aria-checked"),
		).toBe("true");
		emit("turn.started", { at: 1 });
		emit("message", { id: "a1", role: "assistant", markdown: "On it." });
		emit("tool.started", { id: "t1", name: "Bash", title: "ls", input: {} });
		emit("tool.output", { id: "t1", part: { type: "text", text: "SECRET OUTPUT" } });
		emit("tool.finished", { id: "t1", isError: false });
		emit("message", { id: "a2", role: "assistant", markdown: "All finished." });
		expect(synth.spoken).toHaveLength(0);
		emit("turn.finished", { at: 2, status: "done" });
		expect(speakingId()).toBe("a2");
		expect(synth.spoken.map((one) => one.text)).toEqual(["All finished."]);
	} finally {
		removeFakeSpeech();
	}
});

test("a shell command's end is announced when it leaves running, in words", () => {
	draw();
	snapshot();
	const announcer = () => screen.getByTestId("chat-announcer").textContent;
	const command = (body: Record<string, unknown>) =>
		emit("shell", {
			id: "s1",
			command: "ls",
			output: "",
			truncated: false,
			exitCode: null,
			state: "running",
			...body,
		});
	command({});
	expect(announcer()).toBe("");
	command({ state: "done", exitCode: 0 });
	expect(announcer()).toBe("Command finished.");
	command({ id: "s2", state: "running" });
	expect(announcer()).toBe("");
	command({ id: "s2", state: "done", exitCode: 127 });
	expect(announcer()).toBe("Command failed with exit code 127.");
	command({ id: "s3", state: "running" });
	command({ id: "s3", state: "done", exitCode: null });
	expect(announcer()).toBe("Command stopped.");
	// Anything newer in the chat takes the announcement back.
	emit("message", { id: "u1", role: "user", markdown: "thanks" });
	expect(announcer()).toBe("");
});

/** The chat inside a work area whose project is or is not a Git repository. */
function drawInWorkArea(repo: boolean) {
	const openFile = vi.fn();
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
	});
	client.setQueryData(["git-status", WORKSPACE, PROJECT, true], { repo });
	client.setQueryData(
		["projects", WORKSPACE, "active"],
		[{ id: PROJECT, slug: "demo" }],
	);
	const layout = { getState: () => ({ openFile }) } as unknown as LayoutStore;
	render(
		<QueryClientProvider client={client}>
			<LayoutStoreContext.Provider value={layout}>
				<ToastProvider>
					<ChatView
						workspaceId={WORKSPACE}
						projectId={PROJECT}
						terminalId={TERMINAL}
						visible={true}
						focused={false}
						onLeave={vi.fn()}
					/>
				</ToastProvider>
			</LayoutStoreContext.Provider>
		</QueryClientProvider>,
	);
	open();
	snapshot();
	emit("turn.started", { at: Date.now() });
	emit("tool.started", {
		id: "e1",
		name: "Edit",
		title: "Edit",
		input: {
			file_path: "/home/student/projects/demo/src/a.ts",
			old_string: "x",
			new_string: "y",
		},
	});
	emit("tool.finished", { id: "e1", isError: false });
	emit("message", { id: "a1", role: "assistant", markdown: "Changed it." });
	emit("turn.finished", { at: Date.now() + 1_000, status: "done" });
	fireEvent.click(screen.getByRole("button", { name: "src/a.ts" }));
	return openFile;
}

test("a changed file opens in its diff when the project is a Git repository", () => {
	expect(drawInWorkArea(true)).toHaveBeenCalledWith("src/a.ts", { diff: true });
});

test("a changed file opens in the editor when the project is not a Git repository", () => {
	expect(drawInWorkArea(false)).toHaveBeenCalledWith("src/a.ts", undefined);
});

function codexSettings() {
	emit("settings", {
		agent: "codex",
		model: "gpt-5.5",
		effort: "medium",
		mode: "onRequest",
	});
}

test("a Codex chat names Codex in its empty state and announcements", () => {
	draw();
	snapshot();
	codexSettings();
	expect(screen.getByTestId("chat-empty").textContent).toContain(
		"Ask Codex about this project below",
	);
	const announcer = () => screen.getByTestId("chat-announcer").textContent;
	emit("turn.started", { at: Date.now() });
	expect(announcer()).toBe("Codex is working.");
	emit("question.requested", {
		id: "q1",
		questions: [
			{ question: "Which branch?", header: "Branch", multiSelect: false, options: [] },
		],
	});
	expect(announcer()).toBe("Codex has a question: Which branch?");
	emit("card.resolved", { id: "q1" });
	emit("turn.finished", { at: Date.now(), status: "interrupted" });
	expect(announcer()).toBe("Codex stopped.");
});

/** The chat in a work area that can swap it, with the terminal calls it makes. */
function drawSwappable() {
	const layout = { replaceLeaf: vi.fn(), setFocused: vi.fn() };
	const calls: { method: string; url: string; body?: unknown }[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init?: RequestInit) => {
			const method = init?.method ?? "GET";
			calls.push({
				method,
				url: String(url),
				...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
			});
			if (method === "POST" && String(url).endsWith("/terminals")) {
				return Response.json({
					id: "44444444-4444-4444-8444-444444444444",
					workspaceId: WORKSPACE,
					name: "Codex",
					cwd: "/home/student/projects/demo",
					position: 1,
					projectId: PROJECT,
					createdAt: "2026-01-01T00:00:00.000Z",
					theme: "dark",
					kind: "chat",
					agent: "codex",
					endedAt: null,
				});
			}
			if (method === "DELETE") return new Response(null, { status: 204 });
			return Response.json({});
		}),
	);
	render(
		<QueryClientProvider
			client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
		>
			<LayoutStoreContext.Provider
				value={{ getState: () => layout } as unknown as LayoutStore}
			>
				<ToastProvider>
					<ChatView
						workspaceId={WORKSPACE}
						projectId={PROJECT}
						terminalId={TERMINAL}
						visible={true}
						focused={false}
						onLeave={vi.fn()}
					/>
				</ToastProvider>
			</LayoutStoreContext.Provider>
		</QueryClientProvider>,
	);
	open();
	return { layout, calls };
}

function chooseAgent(name: string) {
	fireEvent.click(screen.getByTestId("composer-options"));
	fireEvent.keyDown(screen.getByTestId("composer-agent"), { key: "Enter" });
	const menu = screen.getByRole("menu", { name: /^Agent / });
	fireEvent.click(within(menu).getByRole("menuitemradio", { name }));
}

test("choosing Codex in an empty chat makes a Codex chat in its place and closes this one, with no warning", async () => {
	const { layout, calls } = drawSwappable();
	snapshot();
	emit("settings", { agent: "claude", model: "opus", effort: "medium", mode: "auto" });
	chooseAgent("Codex");
	await vi.waitFor(() =>
		expect(calls.some((call) => call.method === "DELETE")).toBe(true),
	);
	const terminals = `/workspaces/${WORKSPACE}/terminals`;
	expect(calls.filter((call) => call.method !== "GET")).toEqual([
		{
			method: "POST",
			url: terminals,
			body: { projectId: PROJECT, agent: "codex", kind: "chat" },
		},
		{ method: "DELETE", url: `${terminals}/${TERMINAL}` },
	]);
	expect(layout.replaceLeaf).toHaveBeenCalledWith(
		TERMINAL,
		"44444444-4444-4444-8444-444444444444",
	);
	expect(layout.setFocused).toHaveBeenCalledWith(
		"44444444-4444-4444-8444-444444444444",
	);
	// Nothing went to the agent: the swap is the work area's, not the host's.
	expect(latest().sent).toEqual([]);
});

test("a chat with history keeps its agent: the other is not offered yet", () => {
	const { calls } = drawSwappable();
	snapshot();
	emit("settings", { agent: "claude", model: "opus", effort: "medium", mode: "auto" });
	replayTurn(1_000, 1_000, "hi", "hello");
	chooseAgent("Codex");
	expect(calls.filter((call) => call.method !== "GET")).toEqual([]);
});

test("a card carrying a plan is announced as the agent's plan, and the byline names the chat's agent", () => {
	draw();
	snapshot();
	codexSettings();
	emit("message", { id: "a1", role: "assistant", markdown: "Here is my answer." });
	const log = screen.getByRole("list", { name: "Conversation" });
	expect(within(log).getByText("Codex")).toBeTruthy();
	expect(within(log).queryByText("Claude")).toBeNull();
	emit("permission.requested", {
		id: "cx-plan",
		toolName: "plan",
		title: "Implement this plan?",
		input: {},
		plan: "1. Read the test.",
		options: [
			{ id: "implement", label: "Implement the plan", decision: "allowed" },
			{ id: "keep", label: "Keep planning", decision: "denied" },
		],
	});
	expect(screen.getByTestId("chat-announcer").textContent).toBe(
		"Codex has a plan for you to review.",
	);
});
