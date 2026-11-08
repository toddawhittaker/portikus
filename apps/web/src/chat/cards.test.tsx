import type { ChatOpenCard } from "@portikus/contracts";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { PermissionCard } from "./PermissionCard";
import { ToolBlock } from "./ToolBlock";

afterEach(cleanup);

const PERMISSION: Extract<ChatOpenCard, { type: "permission" }> = {
	type: "permission",
	id: "p1",
	toolName: "Bash",
	title: "Run the test suite",
	input: { command: "pnpm test", timeout: 60 },
	options: [
		{ id: "allow", label: "Allow" },
		{ id: "deny", label: "Deny" },
	],
};

test("a permission card shows the tool, its input and the options, and focuses the first", () => {
	const onAnswer = vi.fn(() => true);
	render(
		<PermissionCard
			card={PERMISSION}
			onAnswer={onAnswer}
			takeFocus={() => true}
			waiting={1}
		/>,
	);
	expect(
		screen.getByRole("heading", { name: "Claude wants to run a command" }),
	).toBeTruthy();
	expect(screen.getByText("Run the test suite")).toBeTruthy();
	// The bare command, not a JSON object.
	expect(screen.getByTestId("chat-permission-command").textContent).toBe("pnpm test");
	expect(screen.getByTestId("chat-cards-waiting").textContent).toBe(
		"1 more request is waiting.",
	);
	expect(document.activeElement).toBe(screen.getByRole("button", { name: "Allow" }));
	fireEvent.click(screen.getByRole("button", { name: "Deny" }));
	expect(onAnswer).toHaveBeenCalledWith("deny");
	fireEvent.click(screen.getByRole("button", { name: "Allow" }));
	expect(onAnswer).toHaveBeenCalledTimes(1);
});

test("ExitPlanMode shows its plan as Markdown", () => {
	render(
		<PermissionCard
			card={{
				...PERMISSION,
				toolName: "ExitPlanMode",
				title: "",
				input: {
					plan: "## Plan\n\n1. Add a test\n2. Fix it\n\n![x](https://evil.example/p.png)",
				},
				options: [{ id: "approve", label: "Approve plan" }],
			}}
			onAnswer={() => true}
			takeFocus={() => false}
			waiting={0}
		/>,
	);
	expect(
		screen.getByRole("heading", { name: "Claude has a plan for you to review" }),
	).toBeTruthy();
	// The plan scrolls on its own, so the keyboard can reach it.
	expect(screen.getByTestId("chat-plan").tabIndex).toBe(0);
	expect(screen.getByRole("heading", { name: "Plan" })).toBeTruthy();
	expect(screen.getAllByRole("listitem")).toHaveLength(2);
	expect(document.querySelector("img")).toBeNull();
});

test("a tool block opens to its input and output, images included", () => {
	render(
		<ToolBlock
			tool={{
				kind: "tool",
				key: "tool:t1",
				id: "t1",
				name: "Screenshot",
				title: "the home page",
				input: { url: "http://localhost:3000" },
				output: [
					{ type: "text", text: "saved" },
					{ type: "image", mediaType: "image/png", data: "iVBORw0KGgo=" },
					{ type: "imageOmitted", mediaType: "image/png" },
				],
				status: "error",
				turnId: null,
			}}
		/>,
	);
	const block = screen.getByTestId("chat-tool-t1");
	expect(block.querySelector("summary")?.textContent).toBe(
		"Screenshotthe home pageFailed",
	);
	expect(screen.getByRole("region", { name: "Error" })).toBeTruthy();
	expect(
		screen
			.getByRole("img", { name: "Output of Screenshot", hidden: true })
			.getAttribute("src"),
	).toBe("data:image/png;base64,iVBORw0KGgo=");
	expect(screen.getByText("Image not kept", { exact: true })).toBeTruthy();
	expect(block.textContent).toContain('"url": "http://localhost:3000"');
});

test("an Edit permission shows its change as a diff, with the file named", () => {
	render(
		<PermissionCard
			card={{
				...PERMISSION,
				toolName: "Edit",
				title: "Edit src/Sidebar.tsx",
				input: {
					file_path: "src/Sidebar.tsx",
					old_string: "a {\n  width: 320px;\n}",
					new_string: "a {\n  inline-size: 20rem;\n}",
				},
			}}
			onAnswer={() => true}
			takeFocus={() => false}
			waiting={0}
		/>,
	);
	expect(
		screen.getByRole("heading", { name: "Claude wants to edit a file" }),
	).toBeTruthy();
	expect(screen.getByText("src/Sidebar.tsx")).toBeTruthy();
	// The host's "Edit …" title would only repeat the heading.
	expect(screen.queryByText("Edit src/Sidebar.tsx")).toBeNull();
	expect(screen.getByTestId("chat-diff").textContent).toBe(
		"  a {\n-   width: 320px;\n+   inline-size: 20rem;\n  }\n",
	);
});

function tool(overrides: Partial<Parameters<typeof ToolBlock>[0]["tool"]> = {}) {
	return {
		kind: "tool" as const,
		key: "tool:t2",
		id: "t2",
		name: "Bash",
		title: "Run the tests",
		input: { command: "pnpm vitest run" },
		output: [],
		status: "done" as const,
		turnId: null,
		...overrides,
	};
}

test("a Bash block shows the bare command and Done, with the raw input one click in", () => {
	render(<ToolBlock tool={tool()} />);
	const block = screen.getByTestId("chat-tool-t2");
	expect(block.querySelector("summary")?.textContent).toBe("Bashpnpm vitest runDone");
	expect(screen.getByText("Raw input")).toBeTruthy();
	expect(block.textContent).toContain('"command": "pnpm vitest run"');
});

test("a stopped tool says so", () => {
	render(<ToolBlock tool={tool({ status: "stopped" })} />);
	expect(screen.getByTestId("chat-tool-state").textContent).toBe("Stopped");
});

test("long output is cut short until Show more", () => {
	const text = Array.from({ length: 30 }, (_, at) => `line ${at + 1}`).join("\n");
	render(<ToolBlock tool={tool({ output: [{ type: "text", text }] })} />);
	const output = screen.getByRole("region", { name: "Output" });
	expect(output.querySelector("pre")?.textContent?.split("\n")).toHaveLength(12);
	const more = within(output).getByRole("button", { name: "Show 18 more lines" });
	expect(more.getAttribute("aria-expanded")).toBe("false");
	fireEvent.click(more);
	expect(output.querySelector("pre")?.textContent).toBe(text);
	expect(within(output).getByRole("button", { name: "Show less" })).toBeTruthy();
});
