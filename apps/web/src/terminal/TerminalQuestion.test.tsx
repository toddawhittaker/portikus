import type {
	CodingAgentTerminal,
	TerminalQuestion as Question,
} from "@portikus/contracts";
import { ToastProvider } from "@portikus/ui";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { AgentStatusContext, createAgentStatusStore } from "./codingAgentStatus";
import { QUESTION_GONE, TerminalQuestion } from "./TerminalQuestion";

const WORKSPACE = "22222222-2222-4222-8222-222222222222";
const TERMINAL = "44444444-4444-4444-8444-444444444444";
const ROUTE = `/workspaces/${WORKSPACE}/terminals/${TERMINAL}/question`;

const QUESTION: Question = {
	id: "toolu_01",
	expiresAt: "2026-11-12T05:00:00.000Z",
	questions: [
		{
			question: "Which database?",
			header: "Database",
			multiSelect: false,
			options: [
				{ label: "PostgreSQL", description: "Relational" },
				{ label: "SQLite", description: "A file" },
			],
		},
	],
};

function entry(question?: Question): CodingAgentTerminal {
	return {
		terminalId: TERMINAL,
		agent: "claude",
		state: "needs-input",
		since: "2026-11-12T04:30:00.000Z",
		subagents: [],
		projectId: "33333333-3333-4333-8333-333333333333",
		name: "zsh",
		kind: "terminal",
		...(question ? { question } : {}),
	};
}

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

function respond(status: number, body?: unknown) {
	const fetchMock = vi.fn(
		async (_input: string, _init?: RequestInit) =>
			new Response(body === undefined ? null : JSON.stringify(body), {
				status,
				headers: body === undefined ? {} : { "content-type": "application/json" },
			}),
	);
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

/** The leaf around the card: a pane holding xterm's keyboard field. */
function draw({ visible = true, question = QUESTION as Question | null } = {}) {
	const store = createAgentStatusStore(() => true);
	store.update([entry(question ?? undefined)], true);
	const view = render(
		<ToastProvider>
			<AgentStatusContext.Provider value={store}>
				<section className="pk-term" aria-label="Terminal: zsh">
					<textarea className="xterm-helper-textarea" aria-label="Terminal input" />
					<TerminalQuestion
						workspaceId={WORKSPACE}
						terminalId={TERMINAL}
						visible={visible}
					/>
				</section>
				<input aria-label="Elsewhere" />
			</AgentStatusContext.Provider>
		</ToastProvider>,
	);
	return { store, view };
}

const terminalInput = () => screen.getByRole("textbox", { name: "Terminal input" });
const card = () => screen.findByRole("region", { name: "Claude's question" });
const sentBody = (fetchMock: ReturnType<typeof respond>) =>
	JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));

test("no card shows while Claude Code is not asking", () => {
	draw({ question: null });
	expect(screen.queryByTestId("terminal-question")).toBeNull();
});

test("the card takes focus from the terminal and sends the picked answer", async () => {
	const fetchMock = respond(204);
	draw();
	await card();
	expect(document.activeElement).toBe(
		screen.getByRole("radio", { name: "PostgreSQL" }),
	);
	fireEvent.click(screen.getByRole("radio", { name: "SQLite" }));
	fireEvent.click(screen.getByRole("button", { name: /Submit/ }));
	await waitFor(() => expect(screen.queryByTestId("terminal-question")).toBeNull());
	expect(fetchMock.mock.calls[0]?.[0]).toBe(ROUTE);
	expect(sentBody(fetchMock)).toEqual({
		id: "toolu_01",
		answers: { "Which database?": "SQLite" },
	});
	expect(document.activeElement).toBe(terminalInput());
});

test("Answer in the terminal hands the question back, and focus returns to the terminal", async () => {
	const fetchMock = respond(204);
	draw();
	await card();
	fireEvent.click(screen.getByRole("button", { name: "Answer in the terminal" }));
	await waitFor(() => expect(screen.queryByTestId("terminal-question")).toBeNull());
	expect(sentBody(fetchMock)).toEqual({ id: "toolu_01", inTerminal: true });
	expect(document.activeElement).toBe(terminalInput());
});

test("Escape is not Answer in the terminal", async () => {
	const fetchMock = respond(204);
	draw();
	await card();
	fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
	expect(fetchMock).not.toHaveBeenCalled();
	expect(screen.getByTestId("terminal-question")).toBeTruthy();
});

test("a question no longer waiting says so briefly and clears the card", async () => {
	respond(409, {
		code: "AGENT_UNAVAILABLE",
		message: "Answered in the terminal or timed out",
	});
	draw();
	await card();
	vi.useFakeTimers();
	fireEvent.click(screen.getByRole("button", { name: "Answer in the terminal" }));
	await act(async () => {
		await vi.advanceTimersByTimeAsync(0);
	});
	expect(screen.queryByTestId("terminal-question")).toBeNull();
	expect(screen.getByRole("status").textContent).toBe(QUESTION_GONE);
	await act(async () => {
		await vi.advanceTimersByTimeAsync(4000);
	});
	expect(screen.getByRole("status").textContent).toBe("");
});

test("an answer that fails to send says so and keeps the question", async () => {
	respond(503, {
		code: "AGENT_UNAVAILABLE",
		message: "The workspace is not reachable.",
	});
	draw();
	await card();
	fireEvent.click(screen.getByRole("button", { name: "Answer in the terminal" }));
	expect(await screen.findByText("Your answer was not sent")).toBeTruthy();
	expect(screen.getByText("The workspace is not reachable.")).toBeTruthy();
	expect(await card()).toBeTruthy();
	expect(
		screen.getByRole("button", { name: /Submit/ }).getAttribute("aria-busy"),
	).toBeNull();
});

test("a question answered elsewhere leaves, and the keyboard goes back to the terminal", async () => {
	const { store } = draw();
	await card();
	act(() => {
		store.update([entry()], false);
	});
	expect(screen.queryByTestId("terminal-question")).toBeNull();
	expect(document.activeElement).toBe(terminalInput());
});

test("it does not take the keyboard from another pane or a hidden tab", async () => {
	const elsewhere = draw({ question: null });
	screen.getByRole("textbox", { name: "Elsewhere" }).focus();
	act(() => {
		elsewhere.store.update([entry(QUESTION)], false);
	});
	await card();
	expect(document.activeElement).toBe(
		screen.getByRole("textbox", { name: "Elsewhere" }),
	);
	cleanup();
	draw({ visible: false });
	await card();
	expect(document.activeElement).toBe(document.body);
});
