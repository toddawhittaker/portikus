import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ChatMarkdown } from "./ChatMarkdown.js";
import { CodeBlock } from "./CodeBlocks.js";
import { COPIED, COPIED_FOR_MS, NOT_COPIED } from "./CopyButton.js";
import type { ChatItem, ChatMessageItem, ChatToolItem } from "./chatStore.js";
import { ImageViewerProvider } from "./ImageViewer.js";
import { MessageList } from "./MessageList.js";

let writeText: ReturnType<typeof vi.fn>;

beforeEach(() => {
	writeText = vi.fn(async () => {});
	Object.defineProperty(navigator, "clipboard", {
		configurable: true,
		value: { writeText },
	});
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

function message(
	role: "user" | "assistant",
	markdown: string,
	extra: Partial<ChatMessageItem> = {},
): ChatMessageItem {
	return {
		kind: "message",
		key: `${role}-${markdown}`,
		id: markdown,
		role,
		markdown,
		attachments: [],
		streaming: false,
		turnId: null,
		...extra,
	};
}

function list(items: ChatItem[], withImages = false) {
	const log = (
		<MessageList items={items} turns={{}} currentTurnId={null} truncated={false} />
	);
	return render(
		withImages ? (
			<ImageViewerProvider workspaceId="w1" projectId="p1">
				{log}
			</ImageViewerProvider>
		) : (
			log
		),
	);
}

test("a reply's copy button copies its Markdown and says so politely", async () => {
	list([message("assistant", "Use **bold** and `code`.")]);
	fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
	await waitFor(() => expect(screen.getByRole("status").textContent).toBe(COPIED));
	expect(writeText).toHaveBeenCalledWith("Use **bold** and `code`.");
});

test("the confirmation clears after a moment", async () => {
	vi.useFakeTimers();
	list([message("assistant", "Hello")]);
	await act(async () => {
		fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
	});
	expect(screen.getByRole("status").textContent).toBe(COPIED);
	act(() => vi.advanceTimersByTime(COPIED_FOR_MS));
	expect(screen.getByRole("status").textContent).toBe("");
});

test("a refused clipboard says what to do instead", async () => {
	writeText.mockRejectedValue(new Error("denied"));
	list([message("assistant", "Hello")]);
	fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
	await waitFor(() => expect(screen.getByRole("status").textContent).toBe(NOT_COPIED));
});

test("a code block in a reply copies its code without the closing newline", async () => {
	render(<ChatMarkdown text={"Run:\n\n```sh\nnpm test\nnpm run build\n```"} />);
	fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
	await waitFor(() =>
		expect(writeText).toHaveBeenCalledWith("npm test\nnpm run build"),
	);
});

test("cut-short output copies all of it", async () => {
	const text = Array.from({ length: 50 }, (_, at) => `line ${at}`).join("\n");
	render(<CodeBlock text={text} limit={5} copyLabel="Copy output" />);
	fireEvent.click(screen.getByRole("button", { name: "Copy output" }));
	await waitFor(() => expect(writeText).toHaveBeenCalledWith(text));
});

test("a code block has no copy button unless it is named", () => {
	render(<CodeBlock text="ls" />);
	expect(screen.queryByRole("button")).toBeNull();
});

test("a tool's text output has a copy button", async () => {
	const tool: ChatToolItem = {
		kind: "tool",
		key: "t1",
		id: "t1",
		name: "Bash",
		title: "ls",
		input: { command: "ls" },
		output: [{ type: "text", text: "a.txt\nb.txt" }],
		status: "done",
		turnId: null,
	};
	list([tool]);
	fireEvent.click(screen.getByRole("button", { name: "Copy output" }));
	await waitFor(() => expect(writeText).toHaveBeenCalledWith("a.txt\nb.txt"));
});

test("the student's message is drawn as Markdown, keeping each line", () => {
	const markdown = "Make it **bold** and use `npm test`\nthen:\n\n- one\n- two";
	const { container } = list([message("user", markdown)]);
	const sent = screen.getByTestId("chat-user-message");
	expect(sent.querySelector("strong")?.textContent).toBe("bold");
	expect(sent.querySelector("code")?.textContent).toBe("npm test");
	const items = [...sent.querySelectorAll(".pk-chat-md li")];
	expect(items.map((li) => li.textContent)).toEqual(["one", "two"]);
	expect(container.querySelector(".pk-chat-bubble .pk-chat-md p")?.textContent).toBe(
		"Make it bold and use npm test\nthen:",
	);
});

test("the student's message copies as the Markdown they sent", async () => {
	list([message("user", "Fix **this**")]);
	fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
	await waitFor(() => expect(writeText).toHaveBeenCalledWith("Fix **this**"));
});

test("a sent picture is a thumbnail that opens the viewer; other files stay paths", async () => {
	list(
		[
			message("user", "Look", {
				attachments: [
					{ path: ".portikus/pastes/s/screen shot.png" },
					{ path: "notes/todo.txt" },
				],
			}),
		],
		true,
	);
	const thumb = screen.getByRole("button", { name: "View image screen shot.png" });
	const img = thumb.querySelector("img");
	expect(img?.getAttribute("alt")).toBe("screen shot.png");
	expect(img?.getAttribute("src")).toBe(
		`/workspaces/w1/projects/p1/image?path=${encodeURIComponent(".portikus/pastes/s/screen shot.png")}`,
	);
	expect(screen.getByText("notes/todo.txt")).toBeTruthy();
	fireEvent.click(thumb);
	const dialog = await screen.findByRole("dialog", { name: "screen shot.png" });
	expect(dialog.querySelector("img")?.getAttribute("alt")).toBe("screen shot.png");
});

test("a sent picture that will not load falls back to its path", () => {
	list([message("user", "", { attachments: [{ path: "gone.png" }] })], true);
	const img = screen.getByRole("img", { name: "gone.png" });
	fireEvent.error(img);
	expect(screen.queryByRole("button", { name: /View image/ })).toBeNull();
	expect(screen.getByText("gone.png")).toBeTruthy();
});

test("a message with only a picture has nothing to copy", () => {
	list([message("user", "", { attachments: [{ path: "a.png" }] })], true);
	expect(screen.queryByRole("button", { name: "Copy message" })).toBeNull();
});
