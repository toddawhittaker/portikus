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
import { ChatView } from "./ChatView";
import { requestSubagentView } from "./subagentView.js";

/**
 * The read-only subagent view (SPEC.md §8.3, §10.8, §25.8): opened from a
 * background Agent card or the project list, fed only by `subagent` frames,
 * nested subagents with Back, and the keyboard moved in and back out.
 */

const WORKSPACE = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const TERMINAL = "11111111-1111-4111-8111-111111111111";
const CALL = "toolu_bg";
const LAUNCH = "Async agent launched successfully.\nagentId: a1";

class FakeSocket {
	static all: FakeSocket[] = [];
	static OPEN = 1;
	readyState = 0;
	sent: { type: string; toolUseId?: string }[] = [];
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

/** One frame of a subagent's conversation, numbered on its own sequence. */
function sub(
	toolUseId: string,
	n: number,
	type: string,
	body: Record<string, unknown> = {},
) {
	frame({
		type: "subagent",
		sessionId: TERMINAL,
		toolUseId,
		event: { type, sessionId: TERMINAL, seq: n, ...body },
	});
}

function watches() {
	return latest().sent.filter((message) => message.type.startsWith("subagent."));
}

beforeEach(() => {
	seq = 0;
	FakeSocket.all = [];
	vi.stubGlobal("WebSocket", FakeSocket);
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

function draw() {
	render(
		<QueryClientProvider client={new QueryClient()}>
			<ToastProvider>
				<ChatView
					workspaceId={WORKSPACE}
					projectId={PROJECT}
					terminalId={TERMINAL}
					visible={true}
					focused={false}
					onLeave={() => {}}
				/>
			</ToastProvider>
		</QueryClientProvider>,
	);
	act(() => {
		latest().readyState = 1;
		latest().onopen?.();
	});
	emit("snapshot", { cards: [], turnRunning: false, truncated: false });
	emit("turn.started", { at: 1000 });
	emit("tool.started", {
		id: CALL,
		name: "Agent",
		title: "Count the routes",
		input: {
			description: "Count the routes",
			prompt: "Count them.",
			run_in_background: true,
		},
	});
	emit("tool.output", { id: CALL, part: { type: "text", text: LAUNCH } });
	emit("tool.finished", { id: CALL, isError: false });
	emit("turn.finished", { at: 2000, status: "done" });
}

function openFromCard() {
	const card = screen.getByTestId(`chat-tool-${CALL}`) as HTMLDetailsElement;
	card.open = true;
	const button = within(card).getByRole("button", { name: "Show its conversation" });
	button.focus();
	fireEvent.click(button);
	return button;
}

test("the Agent card opens a read-only panel that watches the subagent and moves the keyboard in", () => {
	draw();
	const button = openFromCard();
	const panel = screen.getByTestId("subagent-panel");
	expect(within(panel).getByRole("heading", { level: 2 }).textContent).toBe(
		"Subagent Count the routes",
	);
	expect(document.activeElement).toBe(within(panel).getByRole("heading", { level: 2 }));
	expect(screen.getByTestId("subagent-note").textContent).toContain(
		"ask Claude in the chat below",
	);
	expect(watches()).toEqual([{ type: "subagent.watch", toolUseId: CALL }]);
	// The log behind the panel is out of the keyboard's reach.
	expect(screen.getByTestId("chat-scroll").hasAttribute("inert")).toBe(true);
	expect(button).toBeTruthy();
});

test("subagent frames fill the panel's own conversation and leave the chat's alone", () => {
	draw();
	openFromCard();
	sub(CALL, 0, "snapshot", { cards: [], turnRunning: true, truncated: false });
	sub(CALL, 1, "turn.started", { at: 1500 });
	sub(CALL, 2, "message", { id: "p", role: "user", markdown: "Count them." });
	sub(CALL, 3, "message", { id: "m1", role: "assistant", markdown: "Found 4 routes." });
	// Another subagent's frame is not this panel's.
	sub("toolu_other", 4, "message", {
		id: "x",
		role: "assistant",
		markdown: "Not mine",
	});
	const panel = screen.getByTestId("subagent-panel");
	expect(panel.textContent).toContain("Found 4 routes.");
	expect(panel.textContent).not.toContain("Not mine");
	expect(screen.getByTestId("subagent-announcer").textContent).toBe(
		"The subagent is working.",
	);
	sub(CALL, 4, "turn.finished", { at: 3000, status: "done" });
	expect(screen.getByTestId("subagent-announcer").textContent).toBe(
		"The subagent finished.",
	);
	// The chat's own sequence goes on unbroken.
	emit("message", { id: "later", role: "assistant", markdown: "Chat goes on" });
	expect(screen.getByTestId("chat-scroll").textContent).toContain("Chat goes on");
	expect(screen.getByTestId("chat-scroll").textContent).not.toContain(
		"Found 4 routes.",
	);
});

test("Escape closes the panel, unwatches, and gives the keyboard back to the card's button", () => {
	draw();
	const button = openFromCard();
	fireEvent.keyDown(screen.getByTestId("subagent-panel"), { key: "Escape" });
	expect(screen.queryByTestId("subagent-panel")).toBeNull();
	expect(watches().at(-1)).toEqual({ type: "subagent.unwatch", toolUseId: CALL });
	expect(document.activeElement).toBe(button);
	expect(screen.getByTestId("chat-scroll").hasAttribute("inert")).toBe(false);
});

test("a nested subagent opens in the same panel, and Back returns to its parent", () => {
	draw();
	openFromCard();
	sub(CALL, 0, "snapshot", { cards: [], turnRunning: true, truncated: false });
	sub(CALL, 1, "turn.started", { at: 1500 });
	sub(CALL, 2, "tool.started", {
		id: "toolu_nested",
		name: "Agent",
		title: "Read the router",
		input: {
			description: "Read the router",
			prompt: "Read it.",
			run_in_background: true,
		},
	});
	sub(CALL, 3, "tool.output", {
		id: "toolu_nested",
		part: { type: "text", text: LAUNCH },
	});
	sub(CALL, 4, "tool.finished", { id: "toolu_nested", isError: false });
	const panel = screen.getByTestId("subagent-panel");
	const nested = within(panel).getByTestId(
		"chat-tool-toolu_nested",
	) as HTMLDetailsElement;
	nested.open = true;
	fireEvent.click(
		within(nested).getByRole("button", { name: "Show its conversation" }),
	);
	expect(within(panel).getByRole("heading", { level: 2 }).textContent).toBe(
		"Subagent Read the router",
	);
	expect(watches().slice(-2)).toEqual([
		{ type: "subagent.unwatch", toolUseId: CALL },
		{ type: "subagent.watch", toolUseId: "toolu_nested" },
	]);
	const back = within(panel).getByRole("button", { name: "Back to Count the routes" });
	expect(back.textContent).toBe("Back");
	fireEvent.click(back);
	expect(within(panel).getByRole("heading", { level: 2 }).textContent).toBe(
		"Subagent Count the routes",
	);
	expect(document.activeElement).toBe(within(panel).getByRole("heading", { level: 2 }));
	expect(watches().at(-1)).toEqual({ type: "subagent.watch", toolUseId: CALL });
	expect(within(panel).queryByTestId("subagent-back")).toBeNull();
});

test("the close button closes it, and a reconnected socket is asked to watch again", () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	try {
		draw();
		openFromCard();
		const first = latest();
		act(() => first.onclose?.({ code: 1006 }));
		act(() => {
			vi.runOnlyPendingTimers();
		});
		expect(latest()).not.toBe(first);
		act(() => {
			latest().readyState = 1;
			latest().onopen?.();
		});
		expect(watches()).toEqual([{ type: "subagent.watch", toolUseId: CALL }]);
		fireEvent.click(screen.getByRole("button", { name: "Close the subagent view" }));
		expect(screen.queryByTestId("subagent-panel")).toBeNull();
	} finally {
		vi.useRealTimers();
	}
});

test("a subagent picked in the project list opens its panel", () => {
	draw();
	act(() =>
		requestSubagentView(TERMINAL, { toolUseId: CALL, title: "Count the routes" }),
	);
	expect(screen.getByTestId("subagent-panel").dataset.toolId).toBe(CALL);
	sub(CALL, 0, "snapshot", { cards: [], turnRunning: false, truncated: false });
	expect(screen.getByTestId("subagent-empty").textContent).toBe(
		"Nothing to show for this subagent.",
	);
	// Closing it puts the keyboard on the Agent card's row in the chat.
	fireEvent.keyDown(screen.getByTestId("subagent-panel"), { key: "Escape" });
	expect(document.activeElement).toBe(
		screen.getByTestId(`chat-tool-${CALL}`).querySelector("summary"),
	);
});

test("a foreground Agent card opens its subagent too; a failed one and other tools do not", () => {
	draw();
	emit("turn.started", { at: 3000 });
	emit("tool.started", {
		id: "toolu_fg",
		name: "Agent",
		title: "Read the router",
		input: { description: "Read the router", prompt: "Read it." },
	});
	emit("tool.started", {
		id: "toolu_failed",
		name: "Agent",
		title: "Broken",
		input: { description: "Broken", prompt: "x" },
	});
	emit("tool.finished", { id: "toolu_failed", isError: true });
	emit("tool.started", {
		id: "toolu_read",
		name: "Read",
		title: "a.ts",
		input: { file_path: "a.ts" },
	});
	const button = (id: string) =>
		within(screen.getByTestId(`chat-tool-${id}`)).queryByRole("button", {
			name: "Show its conversation",
		});
	expect(button("toolu_failed")).toBeNull();
	expect(button("toolu_read")).toBeNull();
	const running = button("toolu_fg");
	expect(running).not.toBeNull();
	fireEvent.click(running as HTMLElement);
	expect(screen.getByTestId("subagent-panel").dataset.toolId).toBe("toolu_fg");
	expect(watches().at(-1)).toEqual({ type: "subagent.watch", toolUseId: "toolu_fg" });
});
