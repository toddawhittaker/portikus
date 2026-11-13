import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { ChatToolItem } from "./chatStore";
import { ImageViewerProvider } from "./ImageViewer";
import { SubagentOpenerContext } from "./subagentView";
import { ToolBlock } from "./ToolBlock";

afterEach(cleanup);

function tool(overrides: Partial<ChatToolItem> = {}): ChatToolItem {
	return {
		kind: "tool",
		key: "tool:t1",
		id: "t1",
		name: "Bash",
		title: "Run the tests",
		input: { command: "pnpm vitest run" },
		output: [],
		status: "done",
		turnId: null,
		...overrides,
	};
}

function row(item: ChatToolItem) {
	render(<ToolBlock tool={item} />);
	const block = screen.getByTestId(`chat-tool-${item.id}`);
	const summary = block.querySelector("summary");
	if (!summary) throw new Error("no summary");
	return { block, summary, body: block.querySelector(".pk-chat-tool-body") };
}

test("a finished call says what happened in plain words, with no state word", () => {
	const cases: [Partial<ChatToolItem>, string][] = [
		[
			{ name: "Read", input: { file_path: "src/useDashboardQuery.ts" } },
			"Read useDashboardQuery.ts",
		],
		[
			{ name: "Grep", input: { pattern: "useDashboardQuery" } },
			"Searched for useDashboardQuery",
		],
		[{ name: "Glob", input: { pattern: "**/*.css" } }, "Listed **/*.css"],
		[
			{ name: "WebFetch", input: { url: "https://example.com" } },
			"Fetched https://example.com",
		],
		[
			{ name: "Write", input: { file_path: "notes.md", content: "# Hi" } },
			"Wrote notes.md",
		],
	];
	for (const [overrides, text] of cases) {
		const { summary } = row(tool(overrides));
		expect(summary.textContent).toBe(text);
		expect(screen.queryByTestId("chat-tool-state")).toBeNull();
		cleanup();
	}
});

test("an edit counts its lines added and removed, spelled out for a screen reader", () => {
	const { summary, body } = row(
		tool({
			name: "Edit",
			input: {
				file_path: "src/dashboard/useDashboardQuery.ts",
				old_string: "const a = 1;\nconst b = 2;\nreturn a ?? b;",
				new_string: "return 1;",
			},
		}),
	);
	expect(
		summary.querySelector('.pk-chat-tool-stat > [aria-hidden="true"]')?.textContent,
	).toBe("+1 −3");
	expect(summary.textContent).toBe(
		"Edited useDashboardQuery.ts+1 −3, 1 line added, 3 lines removed",
	);
	// The full path is in the opened row and the name's tooltip.
	expect(body?.querySelector(".pk-chat-tool-path")?.textContent).toBe(
		"src/dashboard/useDashboardQuery.ts",
	);
	expect(summary.querySelector(".pk-chat-tool-title")?.getAttribute("title")).toBe(
		"src/dashboard/useDashboardQuery.ts",
	);
	// The diff is the result: no "No output" under it.
	expect(screen.getByTestId("chat-diff")).toBeTruthy();
	expect(body?.textContent).not.toContain("No output");
});

test("a write says nothing about output under its content", () => {
	const { body } = row(
		tool({ name: "Write", input: { file_path: "a.md", content: "# Hi" } }),
	);
	expect(body?.textContent).toContain("# Hi");
	expect(body?.textContent).not.toContain("No output");
	// A file at the top level has no longer path to repeat.
	expect(body?.querySelector(".pk-chat-tool-path")).toBeNull();
});

test("an opened command leaves out what the row already shows", () => {
	const { body } = row(tool());
	expect(body?.querySelector(".pk-chat-command")).toBeNull();
	expect(body?.textContent).toContain("No output");
	cleanup();
	const long = row(tool({ input: { command: "pnpm lint\npnpm test" } }));
	expect(long.summary.textContent).toBe("Ran pnpm lint …");
	expect(long.body?.querySelector(".pk-chat-command")?.textContent).toContain(
		"pnpm lint\npnpm test",
	);
});

test("running reads as it happens; failed and stopped show a glyph and a word and name the action", () => {
	const running = row(tool({ status: "running" }));
	expect(running.summary.textContent).toBe("Running pnpm vitest run");
	expect(running.summary.querySelector(".pk-spin")).toBeTruthy();
	expect(running.body?.textContent).toContain("No output yet");
	cleanup();
	const failed = row(tool({ status: "error" }));
	expect(failed.summary.textContent).toBe("Run pnpm vitest runFailed");
	expect(screen.getByTestId("chat-tool-state").querySelector("svg")).toBeTruthy();
	cleanup();
	const stopped = row(
		tool({ status: "stopped", name: "Read", input: { file_path: "a.ts" } }),
	);
	expect(stopped.summary.textContent).toBe("Read a.tsStopped");
	expect(screen.getByTestId("chat-tool-state").querySelector("svg")).toBeTruthy();
});

test("an unknown tool, or one missing its input, keeps its name and the host's title", () => {
	expect(
		row(tool({ name: "Screenshot", title: "the home page", input: {} })).summary
			.textContent,
	).toBe("Screenshot the home page");
	cleanup();
	expect(
		row(tool({ name: "Bash", title: "Run it", input: {} })).summary.textContent,
	).toBe("Bash Run it");
	cleanup();
	expect(row(tool({ name: "Task", title: "", input: {} })).summary.textContent).toBe(
		"Task",
	);
	cleanup();
	// With no verb to say it, a running one keeps the word.
	expect(
		row(tool({ name: "Task", title: "look", input: {}, status: "running" })).summary
			.textContent,
	).toBe("Task lookRunning");
});

test("a tool's image is a button that says it opens the viewer", () => {
	render(
		<ImageViewerProvider workspaceId="w1" projectId="p1">
			<ToolBlock
				tool={tool({
					name: "Screenshot",
					input: {},
					output: [{ type: "image", mediaType: "image/png", data: "iVBORw0KGgo=" }],
				})}
			/>
		</ImageViewerProvider>,
	);
	const button = screen.getByRole("button", {
		name: "View image Output of Screenshot",
		hidden: true,
	});
	expect(button.querySelector("img")?.getAttribute("alt")).toBe("Output of Screenshot");
});

test("output keeps its Copy button", () => {
	row(tool({ output: [{ type: "text", text: "3 passed" }] }));
	expect(
		screen.getByRole("button", { name: "Copy output", hidden: true }),
	).toBeTruthy();
});

test("an edit's diff names the file's language, so its lines are coloured", () => {
	const { body } = row(
		tool({
			name: "Edit",
			input: { file_path: "src/app.ts", old_string: "a", new_string: "b" },
		}),
	);
	expect(body?.querySelector(".pk-chat-lang")?.textContent).toBe("TypeScript");
});

test("each Agent card's Show its conversation button is described by that card's title", () => {
	const agent = (id: string, description: string) =>
		tool({
			id,
			key: `tool:${id}`,
			name: "Agent",
			title: description,
			input: { description, prompt: "Go." },
		});
	render(
		<SubagentOpenerContext.Provider value={() => undefined}>
			<ToolBlock tool={agent("a1", "Count the routes")} />
			<ToolBlock tool={agent("a2", "Find the tests")} />
		</SubagentOpenerContext.Provider>,
	);
	const buttons = screen.getAllByRole("button", { name: "Show its conversation" });
	expect(buttons).toHaveLength(2);
	const described = buttons.map((button) =>
		(button.getAttribute("aria-describedby") ?? "")
			.split(" ")
			.map((id) => document.getElementById(id)?.textContent ?? "")
			.join(" "),
	);
	expect(described[0]).toContain("Count the routes");
	expect(described[1]).toContain("Find the tests");
});

const UPDATE = "@@ -1,3 +1,3 @@\n keep\n-old\n+new\n tail\n";

test("a Codex command reads as its action, and its opened row holds the command", () => {
	const { summary, body } = row(
		tool({
			name: "commandExecution",
			input: {
				command: "cat src/a.ts",
				actions: [{ type: "read", path: "src/a.ts" }],
			},
			output: [{ type: "text", text: "export {}" }],
		}),
	);
	expect(summary.textContent).toBe("Read a.ts");
	expect(body?.querySelector(".pk-chat-command")?.textContent).toBe("cat src/a.ts");
	expect(body?.querySelector(".pk-chat-tool-output")?.textContent).toContain(
		"export {}",
	);
	cleanup();
	const ran = row(
		tool({ name: "commandExecution", input: { command: "make", actions: [] } }),
	);
	expect(ran.summary.textContent).toBe("Ran make");
});

test("a Codex file change draws a unified diff for each file, headed by its path", () => {
	const { summary, body } = row(
		tool({
			name: "fileChange",
			input: {
				changes: [
					{ path: "/w/src/a.ts", kind: "update", diff: UPDATE },
					{ path: "/w/new.md", kind: "add", diff: "# Hi\n" },
					{ path: "/w/old.md", kind: "delete", diff: "gone\n" },
					{
						path: "/w/b.ts",
						kind: "update",
						movePath: "/w/c.ts",
						diff: "@@ -1 +1 @@\n-x\n+y\n",
					},
				],
			},
		}),
	);
	expect(summary.textContent).toBe(
		"Changed 4 files+3 −3, 3 lines added, 3 lines removed",
	);
	const sections = [...(body?.querySelectorAll("section[aria-label]") ?? [])];
	expect(sections.map((one) => one.getAttribute("aria-label"))).toEqual([
		"Edited /w/src/a.ts",
		"Created /w/new.md",
		"Deleted /w/old.md",
		"Moved /w/b.ts",
	]);
	expect(sections[3]?.querySelector(".pk-chat-tool-path")?.textContent).toBe(
		"/w/b.ts → /w/c.ts",
	);
	const first = sections[0]?.querySelector('[data-testid="chat-diff"]');
	expect(first?.textContent).toBe("  @@ -1,3 +1,3 @@\n  keep\n- old\n+ new\n  tail\n");
	expect(sections[1]?.querySelector(".is-added")?.textContent).toBe("+ # Hi\n");
	expect(sections[2]?.querySelector(".is-removed")?.textContent).toBe("- gone\n");
	// The diff is the result, so no "No output".
	expect(body?.textContent).not.toContain("No output");
});

test("one changed file is told by its own name", () => {
	const { summary } = row(
		tool({
			name: "fileChange",
			input: { changes: [{ path: "/w/src/a.ts", kind: "update", diff: UPDATE }] },
		}),
	);
	expect(summary.textContent).toBe(
		"Edited /w/src/a.ts+1 −1, 1 line added, 1 line removed",
	);
});

test("Codex's other tools read in their own words", () => {
	const cases: [Partial<ChatToolItem>, string][] = [
		[{ name: "webSearch", input: { query: "zod v4" } }, "Searched the web for zod v4"],
		[{ name: "imageView", input: { path: "/w/img/logo.png" } }, "Viewed logo.png"],
		[
			{ name: "dynamicToolCall", input: { tool: "lookup", arguments: {} } },
			"Used lookup",
		],
		[
			{
				name: "plan",
				input: {
					steps: [
						{ step: "a", status: "completed" },
						{ step: "b", status: "pending" },
					],
				},
			},
			"Updated the plan 1 of 2 steps done",
		],
		[{ name: "Skill", input: { skill: "pdf" } }, "Used skill pdf"],
	];
	for (const [overrides, text] of cases) {
		expect(row(tool({ ...overrides, title: "" })).summary.textContent).toBe(text);
		cleanup();
	}
});

test("a plan row lists its steps, and says nothing about output", () => {
	const { body } = row(
		tool({
			name: "plan",
			input: {
				steps: [
					{ step: "Write a test", status: "completed" },
					{ step: "Fix it", status: "inProgress" },
				],
			},
		}),
	);
	expect(body?.querySelector("pre")?.textContent).toBe("[x] Write a test\n[ ] Fix it");
	expect(body?.textContent).not.toContain("No output");
});

test("both agents' MCP calls are one row with their arguments and output", () => {
	const claude = row(
		tool({
			name: "mcp__github__create_issue",
			input: { title: "Bug" },
			output: [{ type: "text", text: "#12 created" }],
		}),
	);
	expect(claude.summary.textContent).toBe("Used create_issue · github");
	expect(claude.body?.querySelector("pre")?.textContent).toBe('{\n  "title": "Bug"\n}');
	expect(claude.body?.querySelector(".pk-chat-tool-output")?.textContent).toContain(
		"#12 created",
	);
	// The arguments are shown once: no second, raw copy.
	expect(claude.body?.querySelector(".pk-chat-raw")).toBeNull();
	cleanup();
	const codex = row(
		tool({
			name: "mcpToolCall",
			input: { server: "github", tool: "create_issue", arguments: { title: "Bug" } },
			output: [{ type: "text", text: "#12 created" }],
		}),
	);
	expect(codex.summary.textContent).toBe(claude.summary.textContent);
	expect(codex.body?.querySelector("pre")?.textContent).toBe('{\n  "title": "Bug"\n}');
	cleanup();
	// With no arguments there is nothing to show twice, so the raw input stays.
	const bare = row(tool({ name: "mcp__s__t", input: {} }));
	expect(bare.body?.querySelector(".pk-chat-raw")).not.toBeNull();
});

test("an unknown Codex item is a plain row with its name, said once", () => {
	const { summary } = row(
		tool({ name: "contextCompaction", title: "contextCompaction", input: {} }),
	);
	expect(summary.textContent).toBe("contextCompaction");
	cleanup();
	expect(
		row(tool({ name: "reasoning", title: "Thinking", input: {} })).summary.textContent,
	).toBe("reasoning Thinking");
});

test("a Codex subagent call opens each child by its thread id", () => {
	const open = vi.fn();
	const call = (receivers: string[], tool_ = "spawnAgent") =>
		tool({
			id: "c1",
			name: "collabAgentToolCall",
			title: "",
			input: { tool: tool_, receivers, prompt: "Count the routes" },
		});
	const { rerender } = render(
		<SubagentOpenerContext.Provider value={open}>
			<ToolBlock tool={call(["thread-1"])} />
		</SubagentOpenerContext.Provider>,
	);
	expect(screen.getByTestId("chat-tool-c1").querySelector("summary")?.textContent).toBe(
		"Started a subagent",
	);
	fireEvent.click(screen.getByRole("button", { name: "Show its conversation" }));
	expect(open).toHaveBeenCalledWith({ toolUseId: "thread-1", title: "Subagent" });
	rerender(
		<SubagentOpenerContext.Provider value={open}>
			<ToolBlock tool={call(["thread-1", "thread-2"], "wait")} />
		</SubagentOpenerContext.Provider>,
	);
	fireEvent.click(
		screen.getByRole("button", { name: "Show subagent 2's conversation" }),
	);
	expect(open).toHaveBeenLastCalledWith({ toolUseId: "thread-2", title: "Subagent" });
	// A call that failed, or names no child, offers no way in.
	rerender(
		<SubagentOpenerContext.Provider value={open}>
			<ToolBlock tool={{ ...call(["thread-1"]), status: "error" }} />
		</SubagentOpenerContext.Provider>,
	);
	expect(screen.queryByRole("button", { name: /conversation/ })).toBeNull();
	rerender(
		<SubagentOpenerContext.Provider value={open}>
			<ToolBlock tool={call([], "listAgents")} />
		</SubagentOpenerContext.Provider>,
	);
	expect(screen.queryByRole("button", { name: /conversation/ })).toBeNull();
	// Without an opener there is no button at all.
	rerender(<ToolBlock tool={call(["thread-1"])} />);
	expect(screen.queryByRole("button", { name: /conversation/ })).toBeNull();
});
