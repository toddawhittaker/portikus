import type { AssistantStatus } from "@portikus/contracts";
import {
	act,
	cleanup,
	fireEvent,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { FakeWebSocket, json, renderApp, stubFetch, USER } from "../test-utils.js";
import { useAssistant } from "./AssistantContext.js";

const ADMIN = {
	...USER,
	id: "33333333-3333-4333-8333-333333333333",
	displayName: "Carol Admin",
	role: "administrator" as const,
};
const CONVERSATION_ID = "44444444-4444-4444-8444-444444444444";
const OLDER_ID = "55555555-5555-4555-8555-555555555555";

function summary(id: string, title: string, lastActiveAt: string) {
	return {
		id,
		title,
		courseId: null,
		context: null,
		readOnly: false,
		tokensUsed: 0,
		createdAt: "2026-11-01T00:00:00.000Z",
		lastActiveAt,
	};
}

/** A socket that records what the page sends and lets the test push frames in. */
class Socket extends FakeWebSocket {
	sent: unknown[] = [];
	override send(data?: unknown) {
		this.sent.push(JSON.parse(String(data)));
	}
	open() {
		this.readyState = 1;
		this.onopen?.();
	}
	push(frame: Record<string, unknown>) {
		this.onmessage?.({
			data: JSON.stringify({ sessionId: CONVERSATION_ID, ...frame }),
		});
	}
}

function lastSocket(): Socket {
	const socket = FakeWebSocket.last;
	if (!(socket instanceof Socket)) throw new Error("no socket");
	return socket;
}

interface Server {
	status: AssistantStatus;
	conversations: ReturnType<typeof summary>[];
	created: unknown[];
	deleted: string[];
	createStatus?: number;
}

function stubServer(server: Server, user: typeof ADMIN | typeof USER = ADMIN) {
	return stubFetch((url, init) => {
		const method = init?.method ?? "GET";
		if (url === "/auth/me") return json(200, user);
		if (url === "/admin/root-shell") return json(200, { enabled: false });
		if (url === "/assistant/status") return json(200, server.status);
		if (url === "/assistant/conversations" && method === "POST") {
			if (server.createStatus) {
				return json(server.createStatus, {
					code: "AI_NOT_ENABLED",
					message: "The built-in AI is switched off.",
					reason: "off",
				});
			}
			server.created.push(JSON.parse(String(init?.body)));
			const made = summary(CONVERSATION_ID, "", "2026-11-15T10:00:00.000Z");
			server.conversations = [made, ...server.conversations];
			return json(201, made);
		}
		if (url === "/assistant/conversations") {
			return json(200, { conversations: server.conversations });
		}
		if (url.startsWith("/assistant/conversations/") && method === "DELETE") {
			const id = url.split("/").at(-1) ?? "";
			server.deleted.push(id);
			server.conversations = server.conversations.filter((one) => one.id !== id);
			return json(204, null);
		}
		return json(404, { error: "not stubbed" });
	});
}

function server(overrides: Partial<Server> = {}): Server {
	return {
		status: { enabled: true, reason: null },
		conversations: [],
		created: [],
		deleted: [],
		...overrides,
	};
}

beforeEach(() => {
	FakeWebSocket.all = [];
	FakeWebSocket.last = null;
	vi.stubGlobal("WebSocket", Socket);
	vi.stubGlobal("requestAnimationFrame", (run: () => void) => setTimeout(run, 0));
});
afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

async function openPanel() {
	const button = await screen.findByRole("button", { name: "Assistant" });
	fireEvent.click(button);
	const panel = await screen.findByRole("complementary", { name: "Assistant" });
	return { button, panel };
}

test("the Assistant button opens the panel with focus inside, and Escape closes it back to the button", async () => {
	stubServer(server());
	renderApp("/admin/users");
	const { button, panel } = await openPanel();
	expect(button.getAttribute("aria-expanded")).toBe("true");
	expect(document.activeElement).toBe(
		within(panel).getByRole("heading", { name: "Assistant" }),
	);
	await within(panel).findByTestId("assistant-empty");

	fireEvent.keyDown(document.activeElement as Element, { key: "Escape" });
	await waitFor(() => expect(screen.queryByTestId("assistant-panel")).toBeNull());
	await waitFor(() => expect(document.activeElement).toBe(button));
	expect(button.getAttribute("aria-expanded")).toBe("false");
});

test("the close button closes the panel and returns focus", async () => {
	stubServer(server());
	renderApp("/admin/users");
	const { button, panel } = await openPanel();
	fireEvent.click(within(panel).getByRole("button", { name: "Close the assistant" }));
	await waitFor(() => expect(document.activeElement).toBe(button));
});

test("conversations are listed newest first and one is deleted behind a confirm", async () => {
	const state = server({
		conversations: [
			summary(OLDER_ID, "Older question", "2026-11-10T10:00:00.000Z"),
			summary(CONVERSATION_ID, "Newer question", "2026-11-14T10:00:00.000Z"),
		],
	});
	stubServer(state);
	renderApp("/admin/users");
	const { panel } = await openPanel();
	const rows = await within(panel).findAllByTestId("assistant-conversation");
	expect(rows.map((row) => row.textContent?.slice(0, 14))).toEqual([
		"Newer question",
		"Older question",
	]);

	fireEvent.click(
		within(rows[1] as HTMLElement).getByRole("button", {
			name: "Delete Older question",
		}),
	);
	const confirm = await screen.findByTestId("assistant-delete-confirm");
	fireEvent.click(within(confirm).getByRole("button", { name: "Delete conversation" }));
	await waitFor(() => expect(state.deleted).toEqual([OLDER_ID]));
	await waitFor(() =>
		expect(within(panel).getAllByTestId("assistant-conversation")).toHaveLength(1),
	);
	// Escape in a confirm closes only the confirm, never the panel.
	fireEvent.click(within(panel).getByRole("button", { name: "Delete Newer question" }));
	const again = await screen.findByTestId("assistant-delete-confirm");
	fireEvent.keyDown(again, { key: "Escape" });
	await waitFor(() =>
		expect(screen.queryByTestId("assistant-delete-confirm")).toBeNull(),
	);
	expect(screen.getByTestId("assistant-panel")).toBeTruthy();
	expect(state.deleted).toEqual([OLDER_ID]);
});

test("a turn runs end to end over the socket: ask, a read tool, a change card, approve, a reply", async () => {
	const state = server();
	stubServer(state);
	renderApp("/admin/users");
	const { panel } = await openPanel();
	fireEvent.click(
		await within(panel).findByRole("button", { name: "New conversation" }),
	);
	await waitFor(() => expect(state.created).toEqual([{}]));
	await waitFor(() => expect(FakeWebSocket.last).not.toBeNull());
	const socket = lastSocket();
	expect(socket.url).toMatch(
		new RegExp(`/assistant/conversations/${CONVERSATION_ID}/socket$`),
	);

	act(() => {
		socket.open();
		socket.push({
			type: "snapshot",
			seq: 0,
			cards: [],
			turnRunning: false,
			truncated: false,
		});
	});
	await within(panel).findByTestId("assistant-conv-empty");
	expect(within(panel).getByTestId("assistant-note").textContent).toMatch(
		/kept 30 days and only you can see them/,
	);

	const box = within(panel).getByRole("textbox", { name: "Message the assistant" });
	fireEvent.change(box, { target: { value: "Who is signed in?" } });
	// Shift+Enter is a new line, not a send.
	fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
	expect(socket.sent).toEqual([]);
	fireEvent.keyDown(box, { key: "Enter" });
	expect(socket.sent).toEqual([
		{ type: "send", text: "Who is signed in?", attachments: [] },
	]);
	expect((box as HTMLTextAreaElement).value).toBe("");

	act(() => {
		socket.push({
			type: "message",
			seq: 1,
			id: "m1",
			role: "user",
			markdown: "Who is signed in?",
		});
		socket.push({ type: "turn.started", seq: 2, at: Date.now() });
		socket.push({
			type: "tool.started",
			seq: 3,
			id: "t1",
			name: "users_list",
			title: "List users",
			input: {},
		});
	});
	expect(screen.getByTestId("assistant-announcer").textContent).toBe(
		"The assistant is working.",
	);
	// Stop takes Send's place while the turn runs.
	fireEvent.click(within(panel).getByRole("button", { name: "Stop" }));
	expect(socket.sent.at(-1)).toEqual({ type: "interrupt" });

	act(() => {
		socket.push({ type: "tool.finished", seq: 4, id: "t1", isError: false });
		socket.push({
			type: "tool.started",
			seq: 5,
			id: "t2",
			name: "users_disable",
			title: "Disable a user",
			input: { userId: "u1" },
		});
		socket.push({
			type: "permission.requested",
			seq: 6,
			id: "t2",
			toolName: "users_disable",
			title: "Disable a user's account",
			input: { userId: "u1" },
			risk: "change",
			options: [
				{ id: "allow", label: "Allow", decision: "allowed" },
				{ id: "deny", label: "Deny", decision: "denied" },
			],
		});
	});
	const card = await within(panel).findByTestId("approval-card");
	expect(within(card).getByRole("heading").textContent).toBe(
		"Disable a user's account",
	);
	expect(screen.getByTestId("assistant-announcer").textContent).toBe(
		"Approval needed: Disable a user's account.",
	);
	// The new card takes the keyboard.
	expect(document.activeElement).toBe(
		within(card).getByRole("button", { name: "Approve" }),
	);
	fireEvent.click(within(card).getByRole("button", { name: "Approve" }));
	expect(socket.sent.at(-1)).toEqual({
		type: "permission.answer",
		id: "t2",
		optionId: "allow",
	});

	act(() => {
		socket.push({ type: "card.resolved", seq: 7, id: "t2", decision: "allowed" });
		socket.push({ type: "tool.finished", seq: 8, id: "t2", isError: false });
		socket.push({
			type: "message",
			seq: 9,
			id: "m2",
			role: "assistant",
			markdown: "Carol is signed in.",
		});
		socket.push({ type: "turn.finished", seq: 10, status: "done", at: Date.now() });
	});
	expect(await within(panel).findByText("Carol is signed in.")).toBeTruthy();
	// The reply is the assistant's, never a coding agent's.
	const bylines = [...panel.querySelectorAll(".pk-chat-author")].map(
		(one) => one.textContent,
	);
	expect(bylines.length).toBeGreaterThan(0);
	expect(new Set(bylines)).toEqual(new Set(["Assistant"]));
	expect(within(panel).getByTestId("approval-outcome").textContent).toBe("Approved");
	expect(screen.getByTestId("assistant-announcer").textContent).toBe(
		"The assistant replied.",
	);
});

test("a destructive card sends the typed confirmation; a denial shows the outcome", async () => {
	stubServer(
		server({
			conversations: [summary(CONVERSATION_ID, "Clean up", "2026-11-14T10:00:00.000Z")],
		}),
	);
	renderApp("/admin/users");
	const { panel } = await openPanel();
	fireEvent.click(await within(panel).findByRole("button", { name: /^Clean up/ }));
	await waitFor(() => expect(FakeWebSocket.last).not.toBeNull());
	const socket = lastSocket();
	const destructive = {
		type: "permission",
		toolName: "users_delete",
		title: "Delete a user",
		input: { userId: "u1" },
		risk: "destructive",
		confirmText: "users_delete",
		options: [
			{ id: "allow", label: "Allow", decision: "allowed" },
			{ id: "deny", label: "Deny", decision: "denied" },
		],
	};
	act(() => {
		socket.open();
		socket.push({
			type: "snapshot",
			seq: 0,
			cards: [
				{ ...destructive, id: "d1" },
				{ ...destructive, id: "d2" },
			],
			turnRunning: true,
			truncated: false,
		});
	});
	const card = await within(panel).findByTestId("approval-card");
	expect(within(card).getByText("1 more waiting")).toBeTruthy();
	const approve = within(card).getByRole("button", {
		name: "Approve",
	}) as HTMLButtonElement;
	expect(approve.disabled).toBe(true);
	fireEvent.change(within(card).getByLabelText("Type users_delete to approve"), {
		target: { value: "users_delete" },
	});
	fireEvent.click(approve);
	expect(socket.sent.at(-1)).toEqual({
		type: "permission.answer",
		id: "d1",
		optionId: "allow",
		confirmation: "users_delete",
	});

	act(() =>
		socket.push({ type: "card.resolved", seq: 1, id: "d1", decision: "allowed" }),
	);
	const next = await within(panel).findByTestId("approval-card");
	await waitFor(() => expect(next.getAttribute("data-decision")).toBeNull());
	fireEvent.click(within(panel).getByRole("button", { name: "Deny" }));
	expect(socket.sent.at(-1)).toEqual({
		type: "permission.answer",
		id: "d2",
		optionId: "deny",
	});
	act(() =>
		socket.push({ type: "card.resolved", seq: 2, id: "d2", decision: "denied" }),
	);
	expect((await within(panel).findByTestId("approval-outcome")).textContent).toBe(
		"Denied",
	);
});

test("an administrator sees why the assistant is off and a link to the AI settings", async () => {
	stubServer(server({ status: { enabled: false, reason: "no-key" } }));
	renderApp("/admin/users");
	const { panel } = await openPanel();
	const off = await within(panel).findByTestId("assistant-off");
	expect(off.textContent).toMatch(/no AI key/);
	expect(
		within(off).getByRole("link", { name: "AI settings" }).getAttribute("href"),
	).toBe("/admin/ai");
	expect(within(panel).queryByRole("button", { name: "New conversation" })).toBeNull();
});

test("a start the server refuses as not enabled shows the plain line", async () => {
	stubServer(server({ createStatus: 409 }));
	renderApp("/admin/users");
	const { panel } = await openPanel();
	fireEvent.click(
		await within(panel).findByRole("button", { name: "New conversation" }),
	);
	const off = await within(panel).findByTestId("assistant-off");
	expect(off.textContent).toMatch(/switched off/);
});

function Diagnose() {
	const assistant = useAssistant();
	return (
		<button
			type="button"
			onClick={() => assistant.open({ context: { kind: "health" } })}
		>
			Diagnose
		</button>
	);
}

test("useAssistant().open with a context opens the panel and starts a conversation about it", async () => {
	const { AssistantProvider } = await import("./AssistantContext.js");
	const { AssistantPanel } = await import("./AssistantPanel.js");
	const { renderWithQuery } = await import("../test-utils.js");
	const state = server();
	stubServer(state);
	renderWithQuery(
		<AssistantProvider>
			<Diagnose />
			<AssistantPanel courseId="66666666-6666-4666-8666-666666666666" />
		</AssistantProvider>,
	);
	fireEvent.click(screen.getByRole("button", { name: "Diagnose" }));
	await waitFor(() =>
		expect(state.created).toEqual([
			{ context: { kind: "health" }, courseId: "66666666-6666-4666-8666-666666666666" },
		]),
	);
	await waitFor(() => expect(FakeWebSocket.last).not.toBeNull());
});

test("after a card is answered the keyboard stays in the panel, and Escape still closes it", async () => {
	stubServer(
		server({
			conversations: [summary(CONVERSATION_ID, "Restart", "2026-11-14T10:00:00.000Z")],
		}),
	);
	renderApp("/admin/users");
	const { button, panel } = await openPanel();
	fireEvent.click(await within(panel).findByRole("button", { name: /^Restart/ }));
	await waitFor(() => expect(FakeWebSocket.last).not.toBeNull());
	const socket = lastSocket();
	act(() => {
		socket.open();
		socket.push({
			type: "snapshot",
			seq: 0,
			cards: [
				{
					type: "permission",
					id: "c1",
					toolName: "workspaces.restart",
					title: "Restart a workspace",
					input: {},
					risk: "change",
					options: [
						{ id: "allow", label: "Allow", decision: "allowed" },
						{ id: "deny", label: "Deny", decision: "denied" },
					],
				},
			],
			turnRunning: true,
			truncated: false,
		});
	});
	const approve = await within(panel).findByRole("button", { name: "Approve" });
	expect(document.activeElement).toBe(approve);
	fireEvent.click(approve);
	act(() =>
		socket.push({ type: "card.resolved", seq: 1, id: "c1", decision: "allowed" }),
	);
	await within(panel).findByTestId("approval-outcome");
	expect(document.activeElement).toBe(
		within(panel).getByRole("textbox", { name: "Message the assistant" }),
	);

	// Focus lost to the page body after a click inside the panel still counts as the panel.
	fireEvent.pointerDown(within(panel).getByTestId("approval-outcome"));
	(document.activeElement as HTMLElement).blur();
	expect(document.activeElement).toBe(document.body);
	fireEvent.keyDown(document.body, { key: "Escape" });
	await waitFor(() => expect(screen.queryByTestId("assistant-panel")).toBeNull());
	await waitFor(() => expect(document.activeElement).toBe(button));
});

test("Escape on the page outside the panel leaves it open", async () => {
	stubServer(server());
	renderApp("/admin/users");
	const { panel } = await openPanel();
	await within(panel).findByTestId("assistant-empty");
	const main = screen.getByTestId("page-admin");
	fireEvent.pointerDown(main);
	(document.activeElement as HTMLElement).blur();
	fireEvent.keyDown(document.body, { key: "Escape" });
	expect(screen.getByTestId("assistant-panel")).toBeTruthy();
});
