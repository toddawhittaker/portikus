import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import type { ChatToolItem } from "./chatStore";
import { ImageViewerProvider } from "./ImageViewer";
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

test("running, failed and stopped each show a glyph and a word, and name the action", () => {
	const running = row(tool({ status: "running" }));
	expect(running.summary.textContent).toBe("Run pnpm vitest runRunning");
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
