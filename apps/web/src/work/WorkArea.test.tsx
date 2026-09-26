import type { Terminal } from "@portikus/contracts";
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
import { afterEach, expect, test, vi } from "vitest";
import { WorkArea } from "./WorkArea";

vi.mock("../TerminalPane", () => ({
	TerminalPane: ({
		terminal,
		focusOnMount,
	}: {
		terminal: Terminal;
		focusOnMount?: boolean;
	}) => (
		<div
			data-testid={`terminal-pane-${terminal.id}`}
			data-focus-on-mount={focusOnMount ? "true" : "false"}
		/>
	),
}));

const WORKSPACE = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const ONE = "44444444-4444-4444-8444-444444444444";
const TWO = "55555555-5555-4555-8555-555555555555";

function terminal(id: string, name: string, endedAt: string | null = null): Terminal {
	return {
		id,
		workspaceId: WORKSPACE,
		name,
		cwd: "/home/student/projects/todo-api",
		position: 0,
		projectId: PROJECT,
		createdAt: "2026-01-01T00:00:00.000Z",
		theme: "dark",
		endedAt,
	};
}

const savedLayout = {
	tabs: [
		{
			id: "tab1",
			root: {
				type: "split",
				direction: "row",
				sizes: [50, 50],
				children: [
					{ type: "leaf", terminalId: ONE },
					{ type: "leaf", terminalId: TWO },
				],
			},
		},
	],
};

/** Answers the layout GET and the terminal list; records every call. */
function stubFetch(options: { layout?: unknown; terminals: Terminal[] }) {
	const created = terminal("66666666-6666-4666-8666-666666666666", "zsh");
	// Like the API, a created terminal then appears in the list.
	const list = [...options.terminals];
	const fetchMock = vi.fn(async (input: string, init?: RequestInit) => {
		const url = String(input);
		if (url.endsWith("/layout")) {
			if (init?.method === "PUT") return { status: 204, ok: true } as Response;
			if (!options.layout) return { status: 204, ok: true } as Response;
			return { status: 200, ok: true, json: async () => options.layout } as Response;
		}
		if (url.includes("/terminals")) {
			if (init?.method === "POST") {
				list.push(created);
				return { status: 201, ok: true, json: async () => created } as Response;
			}
			if (init?.method === "DELETE") {
				const gone = String(input).split("/").pop();
				const at = list.findIndex((item) => item.id === gone);
				if (at >= 0) list.splice(at, 1);
				return { status: 204, ok: true } as Response;
			}
			return {
				status: 200,
				ok: true,
				json: async () => ({ terminals: list }),
			} as Response;
		}
		if (url.includes("/diff")) {
			return {
				status: 200,
				ok: true,
				json: async () => ({
					status: "M",
					before: "a\n",
					after: "b\n",
					binary: false,
					tooLarge: false,
				}),
			} as Response;
		}
		throw new Error(`unexpected request: ${url}`);
	});
	vi.stubGlobal("fetch", fetchMock);
	return { fetchMock, created };
}

function renderArea(props: { openPath?: string; openLine?: number } = {}) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<ToastProvider>
				<WorkArea
					workspaceId={WORKSPACE}
					projectId={PROJECT}
					projectPath="~/projects/todo-api"
					onSessionEnded={vi.fn()}
					{...props}
				/>
			</ToastProvider>
		</QueryClientProvider>,
	);
}

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

test("the saved layout is rendered as one tab with two panes", async () => {
	stubFetch({
		layout: savedLayout,
		terminals: [terminal(ONE, "zsh"), terminal(TWO, "npm")],
	});
	renderArea();

	await waitFor(() => expect(screen.getByTestId("terminal-group-tab1")).toBeTruthy());
	expect(screen.getByTestId(`terminal-leaf-${ONE}`)).toBeTruthy();
	expect(screen.getByTestId(`terminal-leaf-${TWO}`)).toBeTruthy();
	// The tab is named after the first pane's terminal.
	expect(screen.getByTestId("work-tabs").textContent).toContain("zsh");
	expect(screen.getByTestId("tab-tab1")).toBeTruthy();
});

test("a terminal the server knows about but the layout does not gets its own tab", async () => {
	stubFetch({
		layout: { tabs: [{ id: "tab1", root: { type: "leaf", terminalId: ONE } }] },
		terminals: [terminal(ONE, "zsh"), terminal(TWO, "npm")],
	});
	renderArea();

	await waitFor(() => expect(screen.getByTestId(`terminal-leaf-${TWO}`)).toBeTruthy());
	expect(screen.getAllByRole("tab")).toHaveLength(2);
});

test("a terminal that is gone loses its pane", async () => {
	stubFetch({ layout: savedLayout, terminals: [terminal(ONE, "zsh")] });
	renderArea();

	await waitFor(() => expect(screen.getByTestId(`terminal-leaf-${ONE}`)).toBeTruthy());
	expect(screen.queryByTestId(`terminal-leaf-${TWO}`)).toBeNull();
});

test("an ended terminal keeps its pane and marks the tab as ended", async () => {
	stubFetch({
		layout: { tabs: [{ id: "tab1", root: { type: "leaf", terminalId: ONE } }] },
		terminals: [terminal(ONE, "zsh", "2026-01-02T00:00:00.000Z")],
	});
	renderArea();

	await waitFor(() => expect(screen.getByTestId(`terminal-ended-${ONE}`)).toBeTruthy());
});

test("the launcher opens a terminal for this project and gives it a tab", async () => {
	const { fetchMock, created } = stubFetch({ terminals: [] });
	renderArea();

	await waitFor(() => expect(screen.getByTestId("launcher")).toBeTruthy());
	fireEvent.pointerDown(screen.getByTestId("launcher"), { button: 0, ctrlKey: false });
	fireEvent.click(screen.getByTestId("launcher-terminal"));

	await waitFor(() =>
		expect(screen.getByTestId(`terminal-leaf-${created.id}`)).toBeTruthy(),
	);
	const post = fetchMock.mock.calls.find((call) => call[1]?.method === "POST");
	expect(JSON.parse(String(post?.[1]?.body))).toEqual({ projectId: PROJECT });
});

/** Radix returns focus on a timeout, so wait that turn out before asserting. */
async function flushCloseFocus() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

test("a terminal, Claude Code, or Codex opened from New is the focused pane", async () => {
	for (const item of [
		"launcher-terminal",
		"launcher-claude",
		"launcher-codex",
	] as const) {
		cleanup();
		vi.unstubAllGlobals();
		const { created } = stubFetch({
			layout: { tabs: [{ id: "tab1", root: { type: "leaf", terminalId: ONE } }] },
			terminals: [terminal(ONE, "zsh")],
		});
		renderArea();
		await waitFor(() =>
			expect(screen.getByTestId(`terminal-leaf-${ONE}`)).toBeTruthy(),
		);

		fireEvent.pointerDown(screen.getByTestId("launcher"), {
			button: 0,
			ctrlKey: false,
		});
		fireEvent.click(screen.getByTestId(item));

		const pane = await screen.findByTestId(`terminal-pane-${created.id}`);
		expect(pane.getAttribute("data-focus-on-mount")).toBe("true");
		expect(screen.getByTestId(`terminal-leaf-${created.id}`).className).toContain(
			"is-focused",
		);
		expect(screen.getByTestId(`terminal-leaf-${ONE}`).className).not.toContain(
			"is-focused",
		);
		await flushCloseFocus();
		expect(document.activeElement).not.toBe(screen.getByTestId("launcher"));
	}
});

test("the New menu has no File placeholder", async () => {
	stubFetch({ terminals: [] });
	renderArea();
	await waitFor(() => expect(screen.getByTestId("launcher")).toBeTruthy());
	fireEvent.pointerDown(screen.getByTestId("launcher"), { button: 0, ctrlKey: false });

	const menu = screen.getByRole("menu");
	expect(menu.textContent).not.toContain("File — Epic 7");
	expect(menu.querySelector("[role=separator]")).toBeNull();
	expect(screen.getByTestId("launcher-terminal")).toBeTruthy();
	expect(screen.getByTestId("launcher-preview")).toBeTruthy();
});

test("dismissing the New menu with the pointer does not focus New", async () => {
	stubFetch({ terminals: [] });
	renderArea();
	const launcher = await screen.findByTestId("launcher");
	fireEvent.pointerDown(launcher, { button: 0, ctrlKey: false });
	await flushCloseFocus();
	expect(screen.getByRole("menu")).toBeTruthy();

	fireEvent.pointerDown(document.body, { button: 0, ctrlKey: false });
	await flushCloseFocus();

	expect(screen.queryByRole("menu")).toBeNull();
	expect(document.activeElement).not.toBe(launcher);
});

test("closing the New menu from the keyboard focuses New", async () => {
	stubFetch({ terminals: [] });
	renderArea();
	const launcher = await screen.findByTestId("launcher");
	launcher.focus();
	fireEvent.keyDown(launcher, { key: "Enter" });
	expect(screen.getByRole("menu")).toBeTruthy();

	fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
	await flushCloseFocus();

	expect(screen.queryByRole("menu")).toBeNull();
	expect(document.activeElement).toBe(launcher);
});

test("Claude Code and Codex post the agent enum and no command", async () => {
	const { fetchMock } = stubFetch({ terminals: [] });
	renderArea();

	await waitFor(() => expect(screen.getByTestId("launcher")).toBeTruthy());

	for (const agent of ["claude", "codex"] as const) {
		fireEvent.pointerDown(screen.getByTestId("launcher"), {
			button: 0,
			ctrlKey: false,
		});
		fireEvent.click(screen.getByTestId(`launcher-${agent}`));
		await waitFor(() =>
			expect(
				fetchMock.mock.calls.some((call) => {
					if (call[1]?.method !== "POST") return false;
					return JSON.parse(String(call[1]?.body)).agent === agent;
				}),
			).toBe(true),
		);
	}

	const bodies = fetchMock.mock.calls
		.filter((call) => call[1]?.method === "POST")
		.map((call) => JSON.parse(String(call[1]?.body)) as Record<string, unknown>);
	expect(bodies).toEqual([
		{ projectId: PROJECT, agent: "claude" },
		{ projectId: PROJECT, agent: "codex" },
	]);
	expect(bodies.every((body) => !("command" in body))).toBe(true);
});

test("Claude Code and Codex tabs share the agent icon and those labels", async () => {
	const shell = "66666666-6666-4666-8666-666666666666";
	stubFetch({
		layout: {
			tabs: [
				{ id: "tab1", root: { type: "leaf", terminalId: ONE } },
				{ id: "tab2", root: { type: "leaf", terminalId: TWO } },
				{ id: "tab3", root: { type: "leaf", terminalId: shell } },
			],
		},
		terminals: [
			{ ...terminal(ONE, "Terminal 1"), agent: "claude" },
			{ ...terminal(TWO, "Terminal 2"), agent: "codex" },
			terminal(shell, "zsh"),
		],
	});
	renderArea();

	await waitFor(() => expect(screen.getByTestId("tab-tab1")).toBeTruthy());
	const claude = screen.getByTestId("tab-tab1");
	const codex = screen.getByTestId("tab-tab2");
	const ordinary = screen.getByTestId("tab-tab3");
	expect(claude.textContent).toContain("Claude Code");
	expect(claude.querySelector("[data-icon]")?.getAttribute("data-icon")).toBe("agent");
	expect(codex.textContent).toContain("Codex");
	expect(codex.querySelector("[data-icon]")?.getAttribute("data-icon")).toBe("agent");
	expect(ordinary.textContent).toContain("zsh");
	expect(ordinary.querySelector("[data-icon]")?.getAttribute("data-icon")).toBe(
		"terminal",
	);
});

test("closing a tab with one terminal deletes it without asking", async () => {
	const { fetchMock } = stubFetch({
		layout: { tabs: [{ id: "tab1", root: { type: "leaf", terminalId: ONE } }] },
		terminals: [terminal(ONE, "zsh")],
	});
	renderArea();

	await waitFor(() => expect(screen.getByTestId("tab-tab1-close")).toBeTruthy());
	fireEvent.click(screen.getByTestId("tab-tab1-close"));

	await waitFor(() =>
		expect(
			fetchMock.mock.calls.some(
				(call) => call[1]?.method === "DELETE" && String(call[0]).endsWith(ONE),
			),
		).toBe(true),
	);
	// The pane goes when the refreshed list no longer has the terminal.
	await waitFor(() => expect(screen.queryByTestId("terminal-group-tab1")).toBeNull());
});

test("closing a tab with two live terminals asks first", async () => {
	stubFetch({
		layout: savedLayout,
		terminals: [terminal(ONE, "zsh"), terminal(TWO, "npm")],
	});
	renderArea();

	await waitFor(() => expect(screen.getByTestId("tab-tab1-close")).toBeTruthy());
	fireEvent.click(screen.getByTestId("tab-tab1-close"));

	expect(screen.getByRole("alertdialog").textContent).toContain("Close this tab?");
	expect(screen.getByTestId("terminal-group-tab1")).toBeTruthy();
});

test("a file the URL asks for opens on a full strip (issue #240)", async () => {
	// SPEC.md §14.9 with issue #240: there is no cap, so the link always opens.
	const tabs = Array.from({ length: 16 }, (_, index) => ({
		id: `file:src/file${index}.ts`,
		root: { type: "file", path: `src/file${index}.ts` },
	}));
	stubFetch({ layout: { tabs }, terminals: [] });
	renderArea({ openPath: "src/new.ts", openLine: 4 });

	expect(await screen.findByTestId("tab-file:src/new.ts")).toBeTruthy();
	expect(screen.queryByText(/Too many tabs are open/)).toBeNull();
});

test("a saved diff tab loads as the file's own tab (issue #160)", async () => {
	// SPEC.md §8.3: one path has one tab, and a diff is a view of that tab.
	const tabs = [
		{ id: "file:src/app.ts", root: { type: "file", path: "src/app.ts" } },
		{ id: "diff:src/app.ts", root: { type: "diff", path: "src/app.ts" } },
	];
	stubFetch({ layout: { tabs }, terminals: [] });
	renderArea();

	expect(await screen.findByTestId("tab-file:src/app.ts")).toBeTruthy();
	expect(screen.queryByTestId("tab-diff:src/app.ts")).toBeNull();
});

/** Issue #374: each tab body is the panel its tab's aria-controls names. */
test("each tab panel is named by its tab", async () => {
	stubFetch({
		layout: savedLayout,
		terminals: [terminal(ONE, "zsh"), terminal(TWO, "npm")],
	});
	renderArea();
	await waitFor(() => expect(screen.getByTestId("terminal-group-tab1")).toBeTruthy());
	const tab = screen.getByTestId("tab-tab1");
	const panel = screen.getByTestId("terminal-group-tab1");
	await waitFor(() => expect(panel.id).toBe(tab.getAttribute("aria-controls")));
	expect(panel.getAttribute("aria-labelledby")).toBe(tab.id);
	expect(screen.getByRole("tabpanel", { name: /zsh/ })).toBe(panel);
});

/** Issue #370: Move to new tab puts the pane in a tab after its own and focuses it. */
test("Move to new tab gives the pane a tab of its own", async () => {
	stubFetch({
		layout: savedLayout,
		terminals: [terminal(ONE, "zsh"), terminal(TWO, "npm")],
	});
	renderArea();
	await waitFor(() => expect(screen.getByTestId(`terminal-leaf-${TWO}`)).toBeTruthy());
	const trigger = screen.getByTestId(`terminal-actions-${TWO}`);
	trigger.focus();
	fireEvent.keyDown(trigger, { key: "Enter" });
	fireEvent.click(screen.getByTestId("terminal-move-to-new-tab"));
	await waitFor(() => expect(screen.getAllByRole("tab")).toHaveLength(2));
	const tabs = screen.getAllByRole("tab");
	expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
	expect(
		screen.getByTestId(`terminal-pane-${TWO}`).getAttribute("data-focus-on-mount"),
	).toBe("true");
	const first = screen.getByTestId("terminal-group-tab1");
	expect(first.contains(screen.getByTestId(`terminal-leaf-${ONE}`))).toBe(true);
});

/** Issue #359: Leave terminal in the menu does what Alt+Shift+Q does. */
test("Leave terminal moves the keyboard to the active tab", async () => {
	stubFetch({
		layout: savedLayout,
		terminals: [terminal(ONE, "zsh"), terminal(TWO, "npm")],
	});
	renderArea();
	await waitFor(() => expect(screen.getByTestId(`terminal-leaf-${ONE}`)).toBeTruthy());
	const trigger = screen.getByTestId(`terminal-actions-${ONE}`);
	trigger.focus();
	fireEvent.keyDown(trigger, { key: "Enter" });
	fireEvent.click(screen.getByTestId("terminal-leave"));
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
	expect(document.activeElement).toBe(screen.getByTestId("tab-tab1"));
});

/** Issue #608 item 1: the empty work area offers the two launcher actions. */
test("the empty work area opens a terminal or Claude Code from its buttons", async () => {
	const { fetchMock } = stubFetch({ terminals: [] });
	renderArea();

	await screen.findByText("No terminals open");
	expect(screen.getByTestId("launcher").getAttribute("aria-label")).toBe("New tab");
	// The main action is the primary button; Claude Code stays secondary.
	expect(screen.getByTestId("empty-open-terminal").className).toContain(
		"bg-surface-inverse",
	);
	expect(screen.getByTestId("empty-open-claude").className).not.toContain(
		"bg-surface-inverse",
	);
	expect(screen.getByText(/Or use New tab \(\+\) in the tab bar/)).toBeDefined();

	fireEvent.click(screen.getByRole("button", { name: "Start Claude Code" }));
	await waitFor(() =>
		expect(
			fetchMock.mock.calls.some(
				(call) =>
					call[1]?.method === "POST" &&
					JSON.parse(String(call[1]?.body)).agent === "claude",
			),
		).toBe(true),
	);

	cleanup();
	const second = stubFetch({ terminals: [] });
	renderArea();
	fireEvent.click(await screen.findByRole("button", { name: "Open a terminal" }));
	await waitFor(() => {
		const post = second.fetchMock.mock.calls.find((call) => call[1]?.method === "POST");
		expect(JSON.parse(String(post?.[1]?.body))).toEqual({ projectId: PROJECT });
	});
});
