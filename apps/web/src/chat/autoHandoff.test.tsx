import {
	EDITOR_SETTINGS_DEFAULTS,
	HANDOFF_PROMPT,
	handoffFirstMessage,
} from "@portikus/contracts";
import { ToastProvider } from "@portikus/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
	AUTO_HANDOFF_TEXT,
	AutoHandoffNotice,
	COPY_PROMPT,
	START_FRESH_WITH_IT,
} from "./AutoHandoffNotice.js";
import { SEND_FRESH, SEND_HERE } from "./ColdSendChoice.js";
import { Composer, HELD_BACK } from "./Composer.js";
import { type ChatStore, createChatStore } from "./chatStore.js";
import { setText } from "./composerTesting.js";
import {
	askNotePrompt,
	type ChatAutoHandoffItem,
	selectSendableNote,
} from "./freshStart.js";
import { FreshStartContext } from "./HandoffDivider.js";
import { UserMessage } from "./UserMessage.js";

/** The automatic handoff in the browser (SPEC.md §10.8, §25.8). */

vi.mock("../files/queries.js", () => ({
	saveDroppedFile: vi.fn(),
	useFileMutations: () => ({ remove: { mutate: vi.fn() } }),
}));

const SESSION = "11111111-1111-4111-8111-111111111111";
const NOTICE_ID = "22222222-2222-4222-8222-222222222222";
const OLDER_ID = "33333333-3333-4333-8333-333333333333";
const PATH = ".portikus/handoffs/2026-11-14T10-20-30Z.md";
const NOTE = "## Goal\n\nShip it.";
const NOW = Date.parse("2026-11-14T12:00:00Z");

let sent: unknown[];
let store: ChatStore;
let seq: number;

function emit(type: string, body: Record<string, unknown> = {}) {
	act(() => {
		store
			.getState()
			.receive(JSON.stringify({ type, sessionId: SESSION, seq: seq++, ...body }));
	});
}

function notice(id = NOTICE_ID) {
	emit("handoff.auto", { id, path: PATH });
}

/** A Claude chat whose one-hour cache was written `agoMinutes` ago. */
function context(agoMinutes: number, agent: "claude" | "codex" = "claude") {
	emit("settings", {
		agent,
		model: agent === "claude" ? "claude-opus-5-5" : "gpt-6.1-sol",
		effort: "medium",
		mode: "default",
	});
	emit("context", {
		usedTokens: 200_000,
		windowTokens: 1_000_000,
		cache: {
			at: NOW - agoMinutes * 60_000,
			ttlSeconds: agent === "claude" ? 3600 : 1800,
		},
		now: NOW,
	});
}

beforeEach(() => {
	sent = [];
	seq = 0;
	store = createChatStore(
		(message) => {
			sent.push(message);
			return true;
		},
		() => Date.now(),
	);
	emit("snapshot", { cards: [], turnRunning: false, truncated: false });
});

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("the store", () => {
	test("a newer notice supersedes an older one, which keeps its place", () => {
		notice(OLDER_ID);
		emit("message", { id: "u1", role: "user", markdown: "more" });
		notice();
		const notices = store
			.getState()
			.items.filter((item): item is ChatAutoHandoffItem => item.kind === "autoHandoff");
		expect(notices.map((item) => [item.id, item.superseded])).toEqual([
			[OLDER_ID, true],
			[NOTICE_ID, false],
		]);
	});

	test("the note a send can start from is the newest notice with nothing sent after it", () => {
		expect(selectSendableNote(store.getState())).toBeNull();
		notice();
		expect(selectSendableNote(store.getState())?.id).toBe(NOTICE_ID);
		emit("message", { id: "u1", role: "user", markdown: "after" });
		expect(selectSendableNote(store.getState())).toBeNull();
	});
});

describe("the notice", () => {
	const PROMPT = handoffFirstMessage(PATH, NOTE);

	function draw(
		item: Partial<ChatAutoHandoffItem> = {},
		prompt: string | null = PROMPT,
	) {
		const actions = {
			openNote: vi.fn(),
			resend: vi.fn(() => true),
			startFresh: vi.fn(() => true),
			copyPrompt: vi.fn(async () => prompt),
		};
		render(
			<FreshStartContext.Provider value={actions}>
				<ol>
					<AutoHandoffNotice
						notice={{
							kind: "autoHandoff",
							key: "k",
							id: NOTICE_ID,
							path: PATH,
							superseded: false,
							turnId: null,
							...item,
						}}
					/>
				</ol>
			</FreshStartContext.Provider>,
		);
		return actions;
	}

	test("says what happened, links the note, and offers both buttons as real buttons", () => {
		const actions = draw();
		expect(screen.getByTestId("chat-auto-handoff").textContent).toContain(
			AUTO_HANDOFF_TEXT,
		);
		fireEvent.click(screen.getByRole("button", { name: PATH }));
		expect(actions.openNote).toHaveBeenCalledWith(PATH);
		const start = screen.getByRole("button", { name: START_FRESH_WITH_IT });
		// A native button: focusable and pressed with Enter or Space.
		expect(start.tagName).toBe("BUTTON");
		start.focus();
		expect(document.activeElement).toBe(start);
		fireEvent.click(start);
		expect(actions.startFresh).toHaveBeenCalledWith(NOTICE_ID);
		expect(screen.getByRole("button", { name: COPY_PROMPT }).tagName).toBe("BUTTON");
	});

	test("a superseded notice keeps its words but loses its buttons", () => {
		draw({ superseded: true });
		expect(screen.getByTestId("chat-auto-handoff").textContent).toContain(
			AUTO_HANDOFF_TEXT,
		);
		expect(screen.queryByRole("button", { name: START_FRESH_WITH_IT })).toBeNull();
		expect(screen.queryByRole("button", { name: COPY_PROMPT })).toBeNull();
	});

	test("Copy prompt copies the first message the host read from the note", async () => {
		const writeText = vi.fn(async () => undefined);
		vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
		const actions = draw();
		fireEvent.click(screen.getByRole("button", { name: COPY_PROMPT }));
		expect(actions.copyPrompt).toHaveBeenCalledWith(NOTICE_ID);
		await waitFor(() => expect(writeText).toHaveBeenCalledWith(PROMPT));
		await waitFor(() =>
			expect(screen.getByTestId("chat-auto-handoff-status").textContent).toBe(
				"Prompt copied.",
			),
		);
		expect(screen.queryByTestId("chat-auto-handoff-prompt")).toBeNull();
	});

	test("when the clipboard refuses, the prompt is shown selected to copy by hand", async () => {
		vi.stubGlobal("navigator", {
			...navigator,
			clipboard: { writeText: vi.fn(async () => Promise.reject(new Error("no"))) },
		});
		draw();
		fireEvent.click(screen.getByRole("button", { name: COPY_PROMPT }));
		const field = (await screen.findByTestId(
			"chat-auto-handoff-prompt",
		)) as HTMLTextAreaElement;
		expect(field.value).toBe(PROMPT);
		expect(document.activeElement).toBe(field);
		expect(field.selectionEnd - field.selectionStart).toBe(field.value.length);
		expect(screen.getByTestId("chat-auto-handoff-status").textContent).toMatch(
			/Could not copy/,
		);
	});

	test("when the note changed, nothing is copied: the host shows the review card instead", async () => {
		const writeText = vi.fn(async () => undefined);
		vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
		const actions = draw({}, null);
		fireEvent.click(screen.getByRole("button", { name: COPY_PROMPT }));
		await waitFor(() => expect(actions.copyPrompt).toHaveBeenCalled());
		await act(async () => undefined);
		expect(writeText).not.toHaveBeenCalled();
		expect(screen.queryByTestId("chat-auto-handoff-prompt")).toBeNull();
		expect(screen.getByTestId("chat-auto-handoff-status").textContent).toBe("");
	});
});

describe("asking the host for the prompt to copy", () => {
	test("resolves with the prompt the host sends back for this notice", async () => {
		notice();
		const asked = askNotePrompt(store, NOTICE_ID);
		expect(sent).toEqual([{ type: "handoff.auto.copy", id: NOTICE_ID }]);
		// The answer carries no seq: it never enters the chat's sequence.
		act(() => {
			store
				.getState()
				.receive(JSON.stringify({ type: "handoff.prompt", id: NOTICE_ID, text: "P" }));
		});
		await expect(asked).resolves.toBe("P");
	});

	test("resolves with nothing when the review card shows instead", async () => {
		notice();
		const asked = askNotePrompt(store, NOTICE_ID);
		emit("handoff.review", {
			review: { id: OLDER_ID, path: PATH, markdown: "changed" },
		});
		await expect(asked).resolves.toBeNull();
	});

	test("resolves with nothing when the host says why it could not", async () => {
		notice();
		const asked = askNotePrompt(store, NOTICE_ID);
		emit("error", { message: "The note could not be read." });
		await expect(asked).resolves.toBeNull();
	});
});

test("the request for a note is marked as sent by Portikus", () => {
	render(
		<ol>
			<UserMessage
				message={{
					kind: "message",
					key: "m",
					id: "u",
					role: "user",
					markdown: HANDOFF_PROMPT,
					attachments: [],
					streaming: false,
					turnId: null,
				}}
			/>
		</ol>,
	);
	expect(screen.getByTestId("chat-sent-by-portikus").textContent).toBe(
		"Sent by Portikus to write a handoff note",
	);
});

describe("sending into a cold chat with a saved note", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(NOW);
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ ...EDITOR_SETTINGS_DEFAULTS, timezones: [] })),
		);
	});

	function draw() {
		render(
			<QueryClientProvider client={new QueryClient()}>
				<ToastProvider>
					<Composer
						store={store}
						readAloud={{ on: false, set: () => {} }}
						workspaceId="w"
						projectId="p"
						terminalId={SESSION}
					/>
				</ToastProvider>
			</QueryClientProvider>,
		);
	}

	function sendDraft(text: string) {
		setText(screen.getByTestId("chat-composer-input"), text);
		fireEvent.keyDown(screen.getByTestId("chat-composer-input"), { key: "Enter" });
	}

	test("asks first, with the fresh chat focused, and sends the message after the note", () => {
		context(70);
		notice();
		draw();
		sendDraft("Now add tests");
		expect(sent).toEqual([]);
		const fresh = screen.getByRole("button", { name: SEND_FRESH });
		expect(document.activeElement).toBe(fresh);
		fireEvent.click(fresh);
		expect(sent).toEqual([
			{
				type: "handoff.auto.continue",
				id: NOTICE_ID,
				text: "Now add tests",
				attachments: [],
			},
		]);
		expect(screen.queryByTestId("chat-cold-send")).toBeNull();
	});

	test("a fresh start that fails leaves the message in the box and says why", () => {
		context(70);
		notice();
		draw();
		sendDraft("Hold me");
		fireEvent.click(screen.getByRole("button", { name: SEND_FRESH }));
		// The note's own first message is not the student's, so the draft stays.
		emit("handoff.fresh", { id: OLDER_ID, path: PATH });
		emit("message", {
			id: "u-note",
			role: "user",
			markdown: handoffFirstMessage(PATH, NOTE),
		});
		expect(screen.getByTestId("chat-composer-input").textContent).toBe("Hold me");
		emit("error", { message: "The handoff could not be sent." });
		expect(screen.getByTestId("chat-composer-input").textContent).toBe("Hold me");
		expect(screen.getByText(HELD_BACK)).toBeTruthy();
	});

	test("the message leaves the box once it is sent after the note", () => {
		context(70);
		notice();
		draw();
		sendDraft("Then me");
		fireEvent.click(screen.getByRole("button", { name: SEND_FRESH }));
		emit("message", {
			id: "u-note",
			role: "user",
			markdown: handoffFirstMessage(PATH, NOTE),
		});
		emit("message", { id: "u-then", role: "user", markdown: "Then me" });
		expect(screen.getByTestId("chat-composer-input").textContent).toBe("");
	});

	test("Send here anyway sends to this chat", () => {
		context(70);
		notice();
		draw();
		sendDraft("Here please");
		fireEvent.click(screen.getByRole("button", { name: SEND_HERE }));
		expect(sent).toEqual([{ type: "send", text: "Here please", attachments: [] }]);
	});

	test("Escape closes the choice and keeps the draft", () => {
		context(70);
		notice();
		draw();
		sendDraft("Keep me");
		fireEvent.keyDown(screen.getByRole("button", { name: SEND_FRESH }), {
			key: "Escape",
		});
		expect(screen.queryByTestId("chat-cold-send")).toBeNull();
		expect(sent).toEqual([]);
		expect(screen.getByTestId("chat-composer-input").textContent).toBe("Keep me");
	});

	test("a Codex chat past its 30-minute cache asks too", () => {
		context(31, "codex");
		notice();
		draw();
		sendDraft("Go on");
		expect(screen.getByTestId("chat-cold-send")).toBeTruthy();
	});

	test.each([
		[
			"the cache is warm",
			() => {
				context(30);
				notice();
			},
		],
		["no note was saved", () => context(70)],
		[
			"the student sent something after the note",
			() => {
				context(70);
				notice();
				emit("message", { id: "u1", role: "user", markdown: "after" });
			},
		],
	])("sends at once when %s", (_label, setUp) => {
		setUp();
		draw();
		sendDraft("Straight on");
		expect(screen.queryByTestId("chat-cold-send")).toBeNull();
		expect(sent).toEqual([{ type: "send", text: "Straight on", attachments: [] }]);
	});
});
