import type { CodingAgentTerminal } from "@portikus/contracts";
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
import {
	AgentStatusContext,
	createAgentStatusStore,
} from "../terminal/codingAgentStatus.js";
import { ChatView } from "./ChatView";
import { boxText, typeInto } from "./composerTesting.js";

/**
 * The side conversation's pane (SPEC.md §10.2, §25.8): opened by `/btw`
 * only from a host that lists it, fed only by `side` frames, one question
 * at a time with Stop, closed with `side.end`, back after a reload, and
 * the keyboard moved in and back out.
 */

const WORKSPACE = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const TERMINAL = "11111111-1111-4111-8111-111111111111";

class FakeSocket {
	static all: FakeSocket[] = [];
	static OPEN = 1;
	readyState = 0;
	sent: { type: string; text?: string }[] = [];
	onopen: (() => void) | null = null;
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onclose: ((event: { code: number }) => void) | null = null;
	constructor(public url: string) {
		FakeSocket.all.push(this);
	}
	send(data: string) {
		this.sent.push(JSON.parse(data));
	}
	close() {}
}

let seq = 0;

function latest(): FakeSocket {
	const socket = FakeSocket.all.at(-1);
	if (!socket) throw new Error("no socket");
	return socket;
}

function frame(data: object) {
	act(() => latest().onmessage?.({ data: JSON.stringify(data) }));
}

function emit(type: string, body: Record<string, unknown> = {}) {
	frame({ type, sessionId: TERMINAL, seq: seq++, ...body });
}

/** One frame of the side conversation, numbered on its own sequence. */
function side(n: number, type: string, body: Record<string, unknown> = {}) {
	frame({
		type: "side",
		sessionId: TERMINAL,
		event: { type, sessionId: TERMINAL, seq: n, ...body },
	});
}

const sideSent = () =>
	latest().sent.filter((message) => message.type.startsWith("side."));

beforeEach(() => {
	seq = 0;
	FakeSocket.all = [];
	vi.stubGlobal("WebSocket", FakeSocket);
	// jsdom has no layout; the editor scrolls a choice into view through these.
	Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
	Range.prototype.getBoundingClientRect = () => new DOMRect();
	Element.prototype.scrollIntoView = () => {};
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

function draw({
	agent = "claude",
	btw = true,
	title,
}: {
	agent?: "claude" | "codex";
	btw?: boolean;
	title?: string;
} = {}) {
	const status = createAgentStatusStore(() => true);
	if (title) {
		status.update(
			[{ terminalId: TERMINAL, title } as unknown as CodingAgentTerminal],
			true,
		);
	}
	render(
		<QueryClientProvider client={new QueryClient()}>
			<ToastProvider>
				<AgentStatusContext.Provider value={status}>
					<ChatView
						workspaceId={WORKSPACE}
						projectId={PROJECT}
						terminalId={TERMINAL}
						visible={true}
						focused={false}
						onLeave={() => {}}
					/>
				</AgentStatusContext.Provider>
			</ToastProvider>
		</QueryClientProvider>,
	);
	act(() => {
		latest().readyState = 1;
		latest().onopen?.();
	});
	emit("snapshot", { cards: [], turnRunning: false, truncated: false });
	emit("settings", { agent, model: "opus", effort: "medium", mode: "default" });
	emit("commands", {
		commands: btw
			? [{ name: "btw", description: "Ask a side question", terminalOnly: false }]
			: [],
	});
}

const composer = () => screen.getByTestId("chat-composer-input");

/** Type into the chat's message box and send it as typed. */
function sendFromChat(text: string) {
	act(() => composer().focus());
	typeInto(composer(), text);
	fireEvent.keyDown(composer(), { key: "Escape" });
	fireEvent.keyDown(composer(), { key: "Enter" });
}

function sideBox(): HTMLTextAreaElement {
	return screen.getByTestId("side-composer") as HTMLTextAreaElement;
}

function askFromSide(text: string) {
	act(() => sideBox().focus());
	fireEvent.change(sideBox(), { target: { value: text } });
	fireEvent.keyDown(sideBox(), { key: "Enter" });
}

test("/btw opens a labelled side pane named for the chat, with the keyboard in its box", () => {
	draw({ title: "Fix the parser" });
	expect(screen.queryByTestId("side-panel")).toBeNull();
	sendFromChat("/btw");
	const panel = screen.getByRole("region", { name: "Side: Fix the parser" });
	expect(panel.dataset.testid).toBe("side-panel");
	expect(document.activeElement).toBe(sideBox());
	expect(sideSent()).toEqual([]);
	// The chat's own conversation never saw it.
	expect(latest().sent.filter((message) => message.type === "send")).toEqual([]);
	expect(within(panel).getByTestId("side-empty").textContent).toContain(
		"Ask a quick question",
	);
	expect(panel.textContent).toContain("without tools");
});

test("an untitled chat is named for its agent's tab", () => {
	draw();
	sendFromChat("/btw");
	expect(screen.getByRole("heading", { level: 2 }).textContent).toBe(
		"Side: Claude Code (GUI)",
	);
});

test("/btw with a question asks it, and the keyboard waits on Stop until the answer", () => {
	draw();
	sendFromChat("/btw why is the build slow?");
	expect(sideSent()).toEqual([{ type: "side.ask", text: "why is the build slow?" }]);
	expect(sideBox().disabled).toBe(true);
	expect(document.activeElement).toBe(screen.getByTestId("side-stop"));
	side(0, "snapshot", { cards: [], turnRunning: true, truncated: false });
	side(1, "turn.started", { at: 1000 });
	side(2, "message", { id: "q", role: "user", markdown: "why is the build slow?" });
	side(3, "text.delta", { messageId: "a", text: "The tests run twice." });
	const panel = screen.getByTestId("side-panel");
	expect(panel.textContent).toContain("The tests run twice.");
	expect(screen.getByTestId("side-announcer").textContent).toBe("Claude is answering.");
	// The side conversation never enters the chat's own log.
	expect(screen.getByTestId("chat-scroll").textContent).not.toContain(
		"The tests run twice.",
	);
	side(4, "turn.finished", { at: 2000, status: "done" });
	expect(screen.getByTestId("side-announcer").textContent).toBe("Claude answered.");
	expect(screen.queryByTestId("side-stop")).toBeNull();
	expect(sideBox().disabled).toBe(false);
	expect(document.activeElement).toBe(sideBox());
});

test("the side box asks one question at a time, and Stop stops it", () => {
	draw();
	sendFromChat("/btw");
	askFromSide("  What does fold.ts do?  ");
	expect(sideSent()).toEqual([{ type: "side.ask", text: "What does fold.ts do?" }]);
	expect(sideBox().value).toBe("");
	// Send says why it waits, and stays in reach.
	const send = screen.getByTestId("side-send");
	expect(send.getAttribute("aria-disabled")).toBe("true");
	side(0, "snapshot", { cards: [], turnRunning: true, truncated: false });
	side(1, "turn.started", { at: 1000 });
	fireEvent.click(send);
	fireEvent.click(screen.getByRole("button", { name: "Stop the side question" }));
	expect(sideSent()).toEqual([
		{ type: "side.ask", text: "What does fold.ts do?" },
		{ type: "side.stop" },
	]);
	side(2, "turn.finished", { at: 1500, status: "interrupted" });
	expect(screen.getByTestId("side-announcer").textContent).toBe(
		"The side question was stopped.",
	);
	// A blank question is not sent.
	askFromSide("   ");
	expect(sideSent()).toHaveLength(2);
});

test("a question over the limit is not sent and says so", () => {
	draw();
	sendFromChat("/btw");
	askFromSide("x".repeat(4001));
	expect(sideSent()).toEqual([]);
	expect(
		within(screen.getByTestId("side-panel")).getByRole("alert").textContent,
	).toContain("4,001 characters");
	expect(sideBox().getAttribute("aria-invalid")).toBe("true");
});

test("/btw while a side question runs is refused in the chat's box", () => {
	draw();
	sendFromChat("/btw first?");
	sendFromChat("/btw second?");
	expect(sideSent()).toEqual([{ type: "side.ask", text: "first?" }]);
	const box = composer().closest("form") as HTMLElement;
	expect(within(box).getByRole("alert").textContent).toContain(
		"A side question is still running.",
	);
	expect(boxText(composer())).toBe("/btw second?");
});

test("Close sends side.end, forgets the conversation and puts the keyboard back in the chat's box", () => {
	draw();
	sendFromChat("/btw why?");
	side(0, "snapshot", { cards: [], turnRunning: true, truncated: false });
	side(1, "message", { id: "q", role: "user", markdown: "why?" });
	fireEvent.click(screen.getByTestId("side-close"));
	expect(sideSent()).toEqual([
		{ type: "side.ask", text: "why?" },
		{ type: "side.end" },
	]);
	expect(screen.queryByTestId("side-panel")).toBeNull();
	expect(document.activeElement).toBe(composer());
});

test("the host's replay after a reload reopens the pane with its conversation, leaving the keyboard alone", () => {
	draw();
	side(0, "snapshot", { cards: [], turnRunning: false, truncated: false });
	side(1, "message", { id: "q", role: "user", markdown: "Earlier question" });
	side(2, "message", { id: "a", role: "assistant", markdown: "Earlier answer" });
	const panel = screen.getByTestId("side-panel");
	expect(panel.textContent).toContain("Earlier answer");
	expect(document.activeElement).not.toBe(sideBox());
	// A new snapshot (a /clear, or a host that restarted) ends it.
	emit("snapshot", { cards: [], turnRunning: false, truncated: false });
	expect(screen.queryByTestId("side-panel")).toBeNull();
});

test("the host's empty side snapshot, as another browser closes it, closes the pane here", () => {
	draw();
	sendFromChat("/btw why?");
	side(0, "snapshot", { cards: [], turnRunning: true, truncated: false });
	side(1, "turn.started", { at: 1000 });
	side(2, "message", { id: "q", role: "user", markdown: "why?" });
	side(0, "snapshot", { cards: [], turnRunning: false, truncated: false });
	expect(screen.queryByTestId("side-panel")).toBeNull();
});

test("a failed side question shows the host's answer and frees the box", () => {
	draw();
	sendFromChat("/btw why?");
	side(0, "snapshot", { cards: [], turnRunning: true, truncated: false });
	side(1, "turn.started", { at: 1000 });
	side(2, "message", { id: "q", role: "user", markdown: "why?" });
	side(3, "message", {
		id: "e",
		role: "assistant",
		markdown: "That side question did not get an answer. Try again.",
	});
	side(4, "turn.finished", { at: 1500, status: "error" });
	expect(screen.getByTestId("side-panel").textContent).toContain(
		"did not get an answer",
	);
	expect(screen.getByTestId("side-announcer").textContent).toBe(
		"The side question failed.",
	);
	expect(sideBox().disabled).toBe(false);
});

test("a Codex chat says its side answers may run read-only commands", () => {
	draw({ agent: "codex" });
	sendFromChat("/btw");
	expect(screen.getByTestId("side-panel").textContent).toContain(
		"may run read-only commands",
	);
});

test("a host that does not list btw gets no side pane and no side message", () => {
	draw({ btw: false });
	sendFromChat("/btw why?");
	expect(screen.queryByTestId("side-panel")).toBeNull();
	expect(sideSent()).toEqual([]);
});
