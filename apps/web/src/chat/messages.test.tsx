import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ChatMarkdown } from "./ChatMarkdown.js";
import { CodeBlock } from "./CodeBlocks.js";
import { COPIED, COPIED_FOR_MS, NOT_COPIED } from "./CopyButton.js";
import type {
	ChatItem,
	ChatMessageItem,
	ChatShellItem,
	ChatToolItem,
} from "./chatStore.js";
import { ImageViewerProvider } from "./ImageViewer.js";
import { type FileOpener, MessageList } from "./MessageList.js";
import { installFakeSpeech, removeFakeSpeech } from "./speechTesting.js";

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
		<MessageList
			items={items}
			turns={{}}
			currentTurnId={null}
			truncated={false}
			asking={new Set()}
		/>
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

test("a message sent while Claude worked says so beneath it; others do not", () => {
	list([
		message("user", "Build it"),
		message("user", "Skip the docs", { key: "u2", whileWorking: true }),
	]);
	const notes = screen.getAllByTestId("chat-sent-while-working");
	expect(notes.map((note) => note.textContent)).toEqual([
		"Sent while Claude was working",
	]);
	const [, second] = screen.getAllByTestId("chat-user-message");
	expect(second?.contains(notes[0] as Node)).toBe(true);
});

function tool(
	name: string,
	input: unknown,
	extra: Partial<ChatToolItem> = {},
): ChatToolItem {
	return {
		kind: "tool",
		key: `tool-${name}`,
		id: name,
		name,
		title: name,
		input,
		output: [],
		status: "running",
		turnId: "t1",
		...extra,
	};
}

function running(items: ChatItem[], startedAt: number) {
	return render(
		<MessageList
			items={items}
			turns={{
				t1: {
					id: "t1",
					startedAt,
					finishedAt: null,
					status: "running",
					estimated: false,
				},
			}}
			currentTurnId="t1"
			asking={new Set()}
			truncated={false}
		/>,
	);
}

function working(items: ChatItem[]): string {
	running(items, Date.now() - 223_000);
	const text = screen.getByTestId("chat-working").textContent ?? "";
	cleanup();
	return text;
}

test("the Working line names the newest running step, and the time stays", () => {
	expect(working([])).toBe("Working 3m 43s");
	expect(working([tool("Bash", { command: "pnpm build\n--filter web" })])).toBe(
		"Running pnpm build … · 3m 43s",
	);
	// The same words as the tool's row: the file's name, not its whole path.
	expect(working([tool("Read", { file_path: "src/a.ts" })])).toBe(
		"Reading a.ts · 3m 43s",
	);
	expect(working([tool("NotebookEdit", { notebook_path: "nb/plot.ipynb" })])).toBe(
		"Editing plot.ipynb · 3m 43s",
	);
	expect(working([tool("Glob", { pattern: "**/*.ts" })])).toBe(
		"Listing **/*.ts · 3m 43s",
	);
	expect(working([tool("Grep", { pattern: "TODO", path: "src" })])).toBe(
		"Searching for TODO in src · 3m 43s",
	);
	expect(working([tool("AskUserQuestion", { questions: [] })])).toBe(
		"Waiting for your answer · 3m 43s",
	);
	expect(working([tool("Task", { prompt: "look" })])).toBe("Using Task · 3m 43s");
	// Without the input its verb needs, a tool is named, as its row names it.
	expect(working([tool("Bash", {})])).toBe("Using Bash · 3m 43s");
	// A finished tool is no longer the step in hand.
	expect(working([tool("Bash", { command: "ls" }, { status: "done" })])).toBe(
		"Working 3m 43s",
	);
	expect(
		working([
			tool("Bash", { command: "pnpm build" }),
			message("assistant", "Now", { streaming: true, turnId: "t1" }),
		]),
	).toBe("Writing a reply · 3m 43s");
});

test("a run of calls is one group naming the newest step and any failures", () => {
	running(
		[
			tool("Read", { file_path: "src/a.ts" }, { key: "r", status: "done" }),
			tool("Bash", { command: "pnpm lint" }, { key: "l", status: "error" }),
			tool("Bash", { command: "pnpm test" }, { key: "t" }),
		],
		0,
	);
	const group = screen.getByTestId("chat-tool-group");
	expect(group.tagName).toBe("DETAILS");
	expect(group.dataset.status).toBe("running");
	expect(group.querySelector("summary")?.textContent).toBe(
		"3 tool callsRunning pnpm test1 failed",
	);
	expect(group.querySelectorAll("details.pk-chat-tool")).toHaveLength(3);
});

test("a finished run names its tools once each", () => {
	running(
		[
			tool("Read", { file_path: "a" }, { key: "1", status: "done" }),
			tool("Bash", { command: "ls" }, { key: "2", status: "done" }),
			tool("Read", { file_path: "b" }, { key: "3", status: "stopped" }),
		],
		0,
	);
	const group = screen.getByTestId("chat-tool-group");
	expect(group.dataset.status).toBe("stopped");
	expect(screen.getByTestId("chat-tool-group-what").textContent).toBe("Read, Bash");
	expect(group.querySelector("summary")?.textContent).toContain("1 stopped");
});

test("Claude's history outside a turn has one byline per run between the student's messages", () => {
	const loose = (name: string) =>
		tool(name, {}, { key: name, turnId: null, status: "done" });
	list([
		message("user", "Hi"),
		message("assistant", "Looking"),
		loose("Read"),
		loose("Bash"),
		message("assistant", "Done"),
		message("user", "Thanks"),
		message("assistant", "Welcome"),
	]);
	expect(screen.getAllByTestId("chat-turn")).toHaveLength(2);
	expect(screen.getAllByText("Claude")).toHaveLength(2);
	expect(screen.getAllByTestId("chat-tool-group")).toHaveLength(1);
});

test("a long step is cut on screen and kept whole in its title", () => {
	const command = `echo ${"x".repeat(300)}`;
	running([tool("Bash", { command })], 0);
	expect(screen.getByTitle(`Running ${command}`).className).toBe("pk-turn-doing");
});

function shell(extra: Partial<ChatShellItem> = {}): ChatShellItem {
	return {
		kind: "shell",
		key: "shell:s1",
		id: "s1",
		command: "ls -la",
		output: "total 0\nfile.txt\n",
		exitCode: 0,
		truncated: false,
		state: "done",
		turnId: null,
		...extra,
	};
}

test("a shell command is a labelled group: the command, then its output, not a reply from Claude", () => {
	list([message("user", "Hi"), shell(), message("assistant", "Welcome")]);
	const group = screen.getByRole("group", { name: "Shell command" });
	expect(screen.getByTestId("chat-shell-command").textContent).toBe("$ls -la");
	expect(
		screen.getByTestId("chat-shell-command").querySelector("[aria-hidden]"),
	).not.toBeNull();
	const output = within(group).getByRole("region", { name: "Command output" });
	const text = within(group).getByTestId("chat-shell-output");
	expect(text).toBe(output);
	expect(text.textContent).toBe("total 0\nfile.txt\n");
	expect(text.tabIndex).toBe(0);
	// It is not inside a Claude turn, and Claude's reply after it has its own byline.
	expect(group.closest('[data-testid="chat-turn"]')).toBeNull();
	expect(screen.getAllByText("Claude")).toHaveLength(1);
});

test("a command that succeeded says so only to a screen reader", () => {
	list([shell()]);
	const status = screen.getByTestId("chat-shell-status");
	expect(status.className).toBe("sr-only");
	expect(status.textContent).toBe("Finished with exit code 0");
	expect(screen.queryByTestId("chat-shell-truncated")).toBeNull();
});

test("a failed command shows its exit code in words", () => {
	list([shell({ exitCode: 127, output: "sh: nope: not found\n" })]);
	const status = screen.getByTestId("chat-shell-status");
	expect(status.textContent).toBe("Failed with exit code 127");
	expect(status.className).toContain("is-error");
});

test("a running command shows Running, and no output box before it prints", () => {
	list([shell({ state: "running", exitCode: null, output: "" })]);
	expect(screen.getByTestId("chat-shell-status").textContent).toBe("Running");
	expect(screen.queryByRole("region", { name: "Command output" })).toBeNull();
});

test("a command stopped without an exit code says Stopped", () => {
	list([shell({ exitCode: null })]);
	expect(screen.getByTestId("chat-shell-status").textContent).toBe("Stopped");
});

test("cut-short output says it was truncated", () => {
	list([shell({ truncated: true })]);
	expect(screen.getByTestId("chat-shell-truncated").textContent).toBe(
		"Output truncated",
	);
});

test("a command with no output has no empty output box", () => {
	list([shell({ output: "" })]);
	expect(screen.queryByRole("region", { name: "Command output" })).toBeNull();
});

test("a shell command in the middle of Claude's run splits its byline and keeps the order", () => {
	const loose = (key: string) => message("assistant", key, { key, turnId: null });
	list([loose("before"), shell(), loose("after")]);
	expect(screen.getAllByTestId("chat-turn")).toHaveLength(2);
	const order = Array.from(
		document.querySelectorAll('[data-testid="chat-turn"], [data-testid="chat-shell"]'),
	).map((node) => node.getAttribute("data-testid"));
	expect(order).toEqual(["chat-turn", "chat-shell", "chat-turn"]);
});

test("only Claude's finished written replies carry a read-aloud button", () => {
	installFakeSpeech();
	try {
		const tool: ChatToolItem = {
			kind: "tool",
			key: "tool:1",
			id: "1",
			name: "Bash",
			title: "ls",
			input: { command: "ls" },
			output: [{ type: "text", text: "file.txt" }],
			status: "done",
			turnId: null,
		};
		list([
			message("user", "What is here?"),
			message("assistant", "Here is the answer."),
			message("assistant", "Still being written", { streaming: true }),
			tool,
		]);
		const buttons = screen.getAllByRole("button", { name: "Read aloud" });
		expect(buttons).toHaveLength(1);
		expect(buttons[0]?.closest("li")?.textContent).toContain("Here is the answer.");
		// The student's message keeps its Copy button alone.
		expect(screen.getAllByRole("button", { name: "Copy message" })).toHaveLength(3);
	} finally {
		removeFakeSpeech();
	}
});

function finished(items: ChatItem[], opener: FileOpener | null) {
	return render(
		<MessageList
			items={items}
			turns={{
				t1: {
					id: "t1",
					startedAt: 0,
					finishedAt: 5_000,
					status: "done",
					estimated: false,
				},
			}}
			currentTurnId={null}
			asking={new Set()}
			truncated={false}
			opener={opener}
		/>,
	);
}

const ROOT = "/home/student/projects/demo";

test("a finished turn that edited files says how many and their counts, in signs and words", () => {
	const open = vi.fn();
	finished(
		[
			tool(
				"Edit",
				{ file_path: `${ROOT}/src/a.ts`, old_string: "x", new_string: "y\nz" },
				{ key: "e1", id: "e1", status: "done" },
			),
			tool(
				"Write",
				{ file_path: `${ROOT}/b.ts`, content: "1\n2\n" },
				{ key: "w1", id: "w1", status: "done" },
			),
			tool(
				"Write",
				{ file_path: "/home/student/.notes", content: "n" },
				{ key: "w2", id: "w2", status: "done" },
			),
			message("assistant", "Done", { turnId: "t1" }),
		],
		{ slug: "demo", open },
	);
	const changed = screen.getByTestId("chat-files-changed");
	const summary = changed.querySelector("summary");
	expect(summary?.textContent).toBe(
		"3 files changed+5 −1, 5 lines added, 1 line removed",
	);
	// Closed until the student opens it, as a native disclosure.
	expect((changed as HTMLDetailsElement).open).toBe(false);
	const rows = within(changed).getAllByTestId("chat-changed-file");
	expect(rows.map((row) => row.textContent)).toEqual([
		"src/a.ts+2 −1, 2 lines added, 1 line removed",
		"b.ts+2 −0, 2 lines added, 0 lines removed",
		"/home/student/.notes+1 −0, 1 line added, 0 lines removed",
	]);
	fireEvent.click(within(changed).getByRole("button", { name: "src/a.ts" }));
	expect(open).toHaveBeenCalledWith("src/a.ts");
	// A file outside the project cannot be opened in its editor.
	expect(
		within(changed).queryByRole("button", { name: "/home/student/.notes" }),
	).toBeNull();
});

test("one file named by a relative and an absolute path is one row, and a path that climbs out is no button", () => {
	finished(
		[
			tool(
				"Edit",
				{ file_path: "src/a.ts", old_string: "x", new_string: "y" },
				{ key: "e1", id: "e1", status: "done" },
			),
			tool(
				"Edit",
				{ file_path: `${ROOT}/src/a.ts`, old_string: "x", new_string: "y" },
				{ key: "e2", id: "e2", status: "done" },
			),
			tool(
				"Write",
				{ file_path: `${ROOT}/../x.ts`, content: "n" },
				{ key: "w1", id: "w1", status: "done" },
			),
			tool(
				"Write",
				{ file_path: "../y.ts", content: "n" },
				{ key: "w2", id: "w2", status: "done" },
			),
		],
		{ slug: "demo", open: vi.fn() },
	);
	const changed = screen.getByTestId("chat-files-changed");
	expect(
		within(changed)
			.getAllByTestId("chat-changed-file")
			.map((row) => row.textContent?.split("+")[0]),
	).toEqual(["src/a.ts", `${ROOT}/../x.ts`, "../y.ts"]);
	expect(
		within(changed)
			.getAllByRole("button")
			.map((b) => b.textContent),
	).toEqual(["src/a.ts"]);
});

test("a turn that changed no file, or is still running, has no files line", () => {
	finished(
		[
			tool("Read", { file_path: "a.ts" }, { key: "r", id: "r", status: "done" }),
			message("assistant", "Read it", { turnId: "t1" }),
		],
		{ slug: "demo", open: vi.fn() },
	);
	expect(screen.queryByTestId("chat-files-changed")).toBeNull();
	cleanup();
	running(
		[
			tool(
				"Edit",
				{ file_path: "a.ts", old_string: "x", new_string: "y" },
				{ status: "done" },
			),
		],
		Date.now(),
	);
	expect(screen.queryByTestId("chat-files-changed")).toBeNull();
});

test("without a work area the paths are listed but not buttons", () => {
	finished(
		[
			tool(
				"Edit",
				{ file_path: "a.ts", old_string: "x", new_string: "y" },
				{ status: "done" },
			),
		],
		null,
	);
	const changed = screen.getByTestId("chat-files-changed");
	expect(within(changed).getByTestId("chat-changed-file").textContent).toContain(
		"a.ts",
	);
	expect(within(changed).queryByRole("button")).toBeNull();
});

function decisionLines(): string[] {
	return screen.getAllByTestId("chat-decision").map((line) => line.textContent ?? "");
}

test("an answered permission card leaves a line in words at its tool call", () => {
	running(
		[
			tool(
				"Bash",
				{ command: "rm -rf build" },
				{ key: "b", id: "b", decision: "denied" },
			),
			tool(
				"Edit",
				{ file_path: "src/a.ts", old_string: "x", new_string: "y" },
				{ key: "e", id: "e", status: "done", decision: "allowed" },
			),
			tool(
				"Write",
				{ file_path: "notes.md", content: "n" },
				{ key: "w", id: "w", status: "done", decision: "allowedAlways" },
			),
			tool(
				"ExitPlanMode",
				{ plan: "1. Do" },
				{ key: "p", id: "p", decision: "allowed" },
			),
			tool(
				"ExitPlanMode",
				{ plan: "2. Do" },
				{ key: "k", id: "k", decision: "denied" },
			),
			// A call with no card answered leaves none.
			tool("Read", { file_path: "c.ts" }, { key: "r", id: "r", status: "done" }),
		],
		0,
	);
	expect(decisionLines()).toEqual([
		"Denied: rm -rf build",
		"Allowed: a.ts",
		"Allowed for this chat: notes.md",
		"Plan approved",
		"Kept planning",
	]);
	// Each line sits straight after its own tool row, read in order, not under a group.
	const denied = screen.getByTestId("chat-tool-b").closest("li");
	expect(denied?.nextElementSibling?.textContent).toBe("Denied: rm -rf build");
	expect(screen.queryByTestId("chat-tool-group")).toBeNull();
	// Not a live region: the card's resolution is what is announced.
	for (const line of screen.getAllByTestId("chat-decision")) {
		expect(line.closest("[aria-live]")).toBeNull();
	}
});

test("a finished turn folds the decision line into Worked for with its tool call", () => {
	finished(
		[
			message("assistant", "Running the tests", { turnId: "t1" }),
			tool(
				"Bash",
				{ command: "npm test" },
				{ key: "b", id: "b", status: "done", decision: "allowed" },
			),
			message("assistant", "All green", { turnId: "t1" }),
		],
		null,
	);
	const worked = screen.getByTestId("chat-worked");
	expect(within(worked).getByTestId("chat-decision").textContent).toBe(
		"Allowed: npm test",
	);
});
