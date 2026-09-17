import type { Terminal } from "@portikus/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { WorkArea } from "./WorkArea";

vi.mock("../TerminalPane", () => ({
	TerminalPane: ({ terminal }: { terminal: Terminal }) => (
		<div data-testid={`terminal-pane-${terminal.id}`} />
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
		throw new Error(`unexpected request: ${url}`);
	});
	vi.stubGlobal("fetch", fetchMock);
	return { fetchMock, created };
}

function renderArea() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<WorkArea
				workspaceId={WORKSPACE}
				projectId={PROJECT}
				projectPath="~/projects/todo-api"
				onSessionEnded={vi.fn()}
			/>
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
