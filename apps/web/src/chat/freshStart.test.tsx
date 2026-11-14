import {
	type ChatClientMessage,
	type ChatServerEvent,
	type HandoffReview,
	handoffFirstMessage,
} from "@portikus/contracts";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createChatStore, initialChatState, receiveChatFrame } from "./chatStore.js";
import { FreshStartContext, HandoffDivider } from "./HandoffDivider.js";
import { HandoffReviewCard } from "./HandoffReviewCard.js";
import { UserMessage } from "./UserMessage.js";

/** Starting fresh with a handoff note, in the browser (SPEC.md §10.8, §25.8). */

const SESSION = "11111111-1111-4111-8111-111111111111";
const ID = "22222222-2222-4222-8222-222222222222";
const PATH = ".portikus/handoffs/2026-11-14T10-20-30Z.md";
const REVIEW: HandoffReview = { id: ID, path: PATH, markdown: "## Goal\n\nShip it." };

type Body<T extends ChatServerEvent["type"]> = Omit<
	Extract<ChatServerEvent, { type: T }>,
	"sessionId" | "seq" | "type"
>;

function frame<T extends ChatServerEvent["type"]>(type: T, seq: number, body: Body<T>) {
	return JSON.stringify({ type, sessionId: SESSION, seq, ...body });
}

function feed(frames: string[]) {
	return frames.reduce(
		(state, data) => receiveChatFrame(state, data, 0),
		initialChatState,
	);
}

const SNAPSHOT = (seq: number) =>
	frame("snapshot", seq, { cards: [], turnRunning: false, truncated: false });

afterEach(cleanup);

describe("the store", () => {
	test("a review shows the note, null closes it, and a snapshot clears it until the host sends it again", () => {
		const open = feed([SNAPSHOT(0), frame("handoff.review", 1, { review: REVIEW })]);
		expect(open.handoffReview).toEqual(REVIEW);
		expect(
			receiveChatFrame(open, frame("handoff.review", 2, { review: null }), 0)
				.handoffReview,
		).toBeNull();
		expect(receiveChatFrame(open, SNAPSHOT(5), 0).handoffReview).toBeNull();
	});

	test("a fresh start's divider joins the conversation, and its resend updates it in place", () => {
		const failed = feed([
			SNAPSHOT(0),
			frame("handoff.fresh", 1, { id: ID, path: PATH, failed: true }),
			frame("message", 2, { id: "u1", role: "user", markdown: "hi" }),
		]);
		expect(failed.items.map((item) => item.kind)).toEqual(["freshStart", "message"]);
		expect(failed.items[0]).toMatchObject({ id: ID, path: PATH, failed: true });
		const sent = receiveChatFrame(
			failed,
			frame("handoff.fresh", 3, { id: ID, path: PATH }),
			0,
		);
		expect(sent.items.map((item) => item.kind)).toEqual(["freshStart", "message"]);
		expect(sent.items[0]).toMatchObject({ failed: false });
	});

	test("each action sends its message", () => {
		const sent: ChatClientMessage[] = [];
		const store = createChatStore((message) => {
			sent.push(message);
			return true;
		});
		const actions = store.getState();
		actions.startHandoff();
		actions.editHandoff(ID, "edited");
		actions.continueHandoff(ID);
		actions.cancelHandoff(ID);
		actions.resendHandoff(ID);
		expect(sent).toEqual([
			{ type: "handoff.start" },
			{ type: "handoff.edit", id: ID, markdown: "edited" },
			{ type: "handoff.continue", id: ID },
			{ type: "handoff.cancel", id: ID },
			{ type: "handoff.resend", id: ID },
		]);
	});
});

describe("the review card", () => {
	function card(review = REVIEW) {
		const calls = {
			onContinue: vi.fn(() => true),
			onEdit: vi.fn((_markdown: string) => true),
			onCancel: vi.fn(() => true),
		};
		const view = render(
			<HandoffReviewCard review={review} takeFocus={() => true} {...calls} />,
		);
		return { ...calls, view };
	}

	test("it names itself, shows the note and its path, and takes the keyboard on Continue", () => {
		card();
		const region = screen.getByRole("region", { name: "Review the handoff note" });
		expect(screen.getByTestId("chat-handoff-path").textContent).toBe(PATH);
		expect(screen.getByTestId("chat-handoff-note").textContent).toContain("Ship it.");
		expect(region.contains(document.activeElement)).toBe(true);
		expect(document.activeElement?.textContent).toBe("Continue");
	});

	test("Continue sends once and waits", () => {
		const { onContinue } = card();
		fireEvent.click(screen.getByRole("button", { name: "Continue" }));
		fireEvent.click(screen.getByRole("button", { name: "Continue" }));
		expect(onContinue).toHaveBeenCalledTimes(1);
	});

	test("Escape is Cancel, and so is the button", () => {
		const { onCancel } = card();
		fireEvent.keyDown(screen.getByRole("button", { name: "Continue" }), {
			key: "Escape",
		});
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		expect(onCancel).toHaveBeenCalledTimes(2);
	});

	test("Edit opens the note's text; saving sends it, and Escape leaves the edit without cancelling", () => {
		const { onEdit, onCancel } = card();
		fireEvent.click(screen.getByRole("button", { name: "Edit" }));
		const field = screen.getByRole("textbox", { name: "Handoff note" });
		expect(document.activeElement).toBe(field);
		expect((field as HTMLTextAreaElement).value).toBe(REVIEW.markdown);
		fireEvent.keyDown(field, { key: "Escape" });
		expect(screen.queryByRole("textbox")).toBeNull();
		expect(onCancel).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole("button", { name: "Edit" }));
		fireEvent.change(screen.getByRole("textbox", { name: "Handoff note" }), {
			target: { value: "## Goal\n\nShorter." },
		});
		fireEvent.click(screen.getByRole("button", { name: "Save the note" }));
		expect(onEdit).toHaveBeenCalledWith("## Goal\n\nShorter.");
		expect(screen.queryByRole("textbox")).toBeNull();
	});

	test("an answer that could not be sent says so", () => {
		const calls = {
			onContinue: () => false,
			onEdit: () => false,
			onCancel: () => false,
		};
		render(<HandoffReviewCard review={REVIEW} takeFocus={() => false} {...calls} />);
		fireEvent.click(screen.getByRole("button", { name: "Continue" }));
		expect(screen.getByRole("alert").textContent).toMatch(/not connected/);
	});
});

describe("the divider and the first message", () => {
	function divider(failed: boolean) {
		const openNote = vi.fn();
		const resend = vi.fn(() => true);
		render(
			<FreshStartContext.Provider
				value={{ openNote, resend, startFresh: vi.fn(() => true) }}
			>
				<ol>
					<HandoffDivider
						handoff={{
							kind: "freshStart",
							key: "k",
							id: ID,
							path: PATH,
							failed,
							turnId: null,
						}}
					/>
				</ol>
			</FreshStartContext.Provider>,
		);
		return { openNote, resend };
	}

	test("it says the chat started fresh, and its link opens the note", () => {
		const { openNote } = divider(false);
		expect(screen.getByTestId("chat-fresh-start").textContent).toContain(
			"Fresh start from handoff.",
		);
		expect(screen.queryByRole("button", { name: "Send the handoff again" })).toBeNull();
		fireEvent.click(screen.getByRole("button", { name: "Open the note" }));
		expect(openNote).toHaveBeenCalledWith(PATH);
	});

	test("a failed first message offers to send the handoff again", () => {
		const { resend } = divider(true);
		expect(screen.getByTestId("chat-fresh-start").textContent).toContain(
			"did not reach the new conversation",
		);
		fireEvent.click(screen.getByRole("button", { name: "Send the handoff again" }));
		expect(resend).toHaveBeenCalledWith(ID);
	});

	test("the first message is marked as sent by Portikus; a student's own is not", () => {
		const message = (markdown: string) => ({
			kind: "message" as const,
			key: markdown,
			id: markdown,
			role: "user" as const,
			markdown,
			attachments: [],
			streaming: false,
			turnId: null,
		});
		render(
			<ol>
				<UserMessage message={message(handoffFirstMessage(PATH, REVIEW.markdown))} />
				<UserMessage message={message("Continue from Next steps.")} />
			</ol>,
		);
		expect(screen.getAllByTestId("chat-sent-by-portikus")).toHaveLength(1);
		expect(screen.getByText("Sent by Portikus from the handoff")).toBeTruthy();
		expect(screen.getByText("Portikus sent for you:")).toBeTruthy();
	});
});
