import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, onTestFinished, test, vi } from "vitest";
import {
	FakeWebSocket,
	json,
	project,
	renderApp,
	stubFetch,
	USER,
	WORKSPACE,
} from "../test-utils.js";

const TODO = project();
// Only NOTES is shared; the list itself says so.
const NOTES = project({
	id: "55555555-5555-4555-8555-555555555555",
	slug: "notes",
	name: "notes",
	path: "/home/student/projects/notes",
	isGitRepo: false,
	sharedUntil: new Date(Date.now() + 3_600_000).toISOString(),
});
const GONE = project({
	id: "66666666-6666-4666-8666-666666666666",
	slug: "gone",
	name: "gone",
	missing: true,
});
const OLD = project({
	id: "77777777-7777-4777-8777-777777777777",
	slug: "old-labs",
	name: "old labs",
	state: "archived",
	archivedAt: "2026-02-01T00:00:00.000Z",
});

const COPY = project({
	id: "88888888-8888-4888-8888-888888888888",
	slug: "todo-api-copy",
	name: "todo-api copy",
});

afterEach(() => vi.unstubAllGlobals());

/** The workspace socket; the files pane opens more sockets after it. */
let workspaceSocket: FakeWebSocket | null = null;

/** Share status reads made while the pane was mounted. */
let shareReads: string[] = [];

/** Mounts the shell on the todo-api project with the given project lists. */
async function mount(
	active = [TODO, NOTES, GONE],
	archived = [OLD],
	path = `/workspaces/${WORKSPACE.id}/projects/${TODO.id}`,
) {
	shareReads = [];
	stubFetch((url, init) => {
		if (url === "/auth/me") return json(200, USER);
		if (url.endsWith("/share")) {
			shareReads.push(url);
			return json(200, { share: null, viewers: [], audience: [] });
		}
		if (url.endsWith("/live-help"))
			return json(200, { session: null, lastEnded: null, audience: [] });
		if (init?.method === "PATCH") return json(200, { ...TODO, state: "archived" });
		if (url.endsWith("/duplicate")) return json(200, COPY);
		if (url.endsWith("/templates")) return json(200, { templates: [] });
		if (url.includes("state=archived")) return json(200, { projects: archived });
		if (url.includes("/projects")) return json(200, { projects: active });
		throw new Error(`unexpected request: ${url}`);
	});
	vi.stubGlobal("WebSocket", FakeWebSocket);
	FakeWebSocket.last = null;
	const app = renderApp(path);
	// The shell only draws the panes once the socket says the workspace runs.
	await waitFor(() => expect(FakeWebSocket.last).not.toBeNull());
	workspaceSocket = FakeWebSocket.last;
	await act(async () => {
		FakeWebSocket.last?.onmessage?.({
			data: JSON.stringify({ type: "workspace", workspace: WORKSPACE }),
		});
	});
	await screen.findByTestId("project-list");
	return app;
}

function openMenu(id: string) {
	fireEvent.keyDown(screen.getByTestId(`project-menu-${id}`), { key: "Enter" });
}

test("lists the active projects and marks the one in view", async () => {
	await mount();

	expect(await screen.findByTestId(`project-item-${TODO.id}`)).toBeDefined();
	expect(screen.getByTestId(`project-item-${NOTES.id}`)).toBeDefined();
	const current = screen
		.getByTestId(`project-item-${TODO.id}`)
		.querySelector("[aria-current='page']");
	expect(current).not.toBeNull();
	expect(screen.getByTestId(`project-item-${NOTES.id}`).textContent).toContain(
		"not a repo",
	);
	expect(screen.getByTestId(`project-item-${GONE.id}`).textContent).toContain(
		"missing",
	);
});

test("a row shows the project name and not the directory slug beside it", async () => {
	// The name and the folder stay in sync, so the slug is not a second label.
	const named = project({ name: "Todo API" });
	await mount([named, NOTES, GONE]);

	const row = screen.getByTestId(`project-item-${named.id}`);
	expect(row.textContent).toContain("Todo API");
	expect(row.textContent).not.toContain(named.slug);
	expect(screen.queryByTestId(`project-slug-${named.id}`)).toBeNull();
	expect(screen.queryByTestId(`project-slug-${NOTES.id}`)).toBeNull();
	expect(screen.queryByTestId(`project-slug-${GONE.id}`)).toBeNull();
});

test("a repository offers rename, duplicate, download and archive", async () => {
	await mount();
	openMenu(TODO.id);

	expect(screen.getByTestId("project-rename")).toBeDefined();
	expect(screen.getByTestId("project-duplicate")).toBeDefined();
	expect(screen.getByTestId("project-download")).toBeDefined();
	expect(screen.getByTestId("project-archive")).toBeDefined();
	expect(screen.getByTestId("project-recovery").textContent).toBe("Recovery points…");
	expect(screen.queryByTestId("project-git-init")).toBeNull();
});

test("only a shared project has the Shared tag", async () => {
	await mount();

	expect(await screen.findByTestId(`project-shared-${NOTES.id}`)).toBeDefined();
	expect(screen.queryByTestId(`project-shared-${TODO.id}`)).toBeNull();
	expect(screen.queryByTestId(`project-shared-${GONE.id}`)).toBeNull();
	// The tag comes from the list, never from one share request per row.
	expect(shareReads).toEqual([]);
});

test("Share with my instructors opens the share dialog for that project", async () => {
	await mount();
	openMenu(TODO.id);

	fireEvent.keyDown(
		screen.getByRole("menuitem", { name: "Share with my instructors…" }),
		{
			key: "Enter",
		},
	);

	const dialog = await screen.findByTestId("dialog-share-project");
	expect(dialog.textContent).toContain("Share todo-api with my instructors");
});

test("Get live help opens the live help dialog for that project", async () => {
	await mount();
	openMenu(TODO.id);

	fireEvent.keyDown(screen.getByRole("menuitem", { name: "Get live help…" }), {
		key: "Enter",
	});

	const dialog = await screen.findByTestId("dialog-live-help");
	expect(dialog.textContent).toContain("Get live help on todo-api");
});

test("a missing project offers no live help", async () => {
	await mount();
	openMenu(GONE.id);
	await screen.findByRole("menuitem", { name: "Archive…" });
	expect(screen.queryByRole("menuitem", { name: "Get live help…" })).toBeNull();
});

/** Enter on the download item must start the download itself. */
test("Enter on Download as zip checks the size and then starts the download", async () => {
	await mount();
	const click = vi
		.spyOn(HTMLAnchorElement.prototype, "click")
		.mockImplementation(() => {});
	onTestFinished(() => click.mockRestore());
	openMenu(TODO.id);

	const item = screen.getByRole("menuitem", { name: "Download as zip" });
	expect(item.getAttribute("data-testid")).toBe("project-download");
	fireEvent.keyDown(item, { key: "Enter" });

	await waitFor(() => expect(click).toHaveBeenCalledTimes(1));
	const link = click.mock.contexts[0] as HTMLAnchorElement;
	expect(link.getAttribute("href")).toBe(
		`/workspaces/${WORKSPACE.id}/projects/${TODO.id}/download`,
	);
	expect(link.download).toBe(`${TODO.slug}.zip`);
	const calls = (fetch as unknown as { mock: { calls: [string][] } }).mock.calls;
	expect(
		calls.some(([url]) => url.endsWith(`/projects/${TODO.id}/download?path=&check=1`)),
	).toBe(true);
});

/** A project over the download cap is explained, not downloaded. */
test("a project over the download cap shows the limit instead of downloading", async () => {
	await mount();
	const click = vi
		.spyOn(HTMLAnchorElement.prototype, "click")
		.mockImplementation(() => {});
	onTestFinished(() => click.mockRestore());
	stubFetch((url) => {
		if (url.includes("check=1")) {
			return json(413, { code: "FILE_TOO_LARGE", message: "too large" });
		}
		throw new Error(`unexpected request: ${url}`);
	});
	openMenu(TODO.id);
	fireEvent.click(screen.getByRole("menuitem", { name: "Download as zip" }));

	expect(await screen.findByText("Downloads are limited to 1 GB")).toBeDefined();
	expect(
		screen.getByText(/Download a smaller folder, leave out node_modules/),
	).toBeDefined();
	expect(click).not.toHaveBeenCalled();
});

test("a folder that is not a repository offers Initialize Git", async () => {
	await mount();
	openMenu(NOTES.id);

	expect(screen.getByTestId("project-git-init")).toBeDefined();
});

test("a missing project offers only Archive and Delete", async () => {
	await mount();
	openMenu(GONE.id);

	expect(screen.getByTestId("project-archive")).toBeDefined();
	// A row whose folder is gone can still be removed from the list for good.
	expect(screen.getByTestId(`project-delete-${GONE.id}`)).toBeDefined();
	expect(screen.queryByTestId("project-rename")).toBeNull();
	expect(screen.queryByTestId("project-download")).toBeNull();
	expect(screen.queryByTestId("project-recovery")).toBeNull();
});

test("delete stays disabled until the folder name is typed exactly", async () => {
	await mount();
	openMenu(TODO.id);
	fireEvent.click(screen.getByTestId(`project-delete-${TODO.id}`));

	const surface = await screen.findByTestId("dialog-delete-project");
	// Permanent delete takes the project's recovery points with it (SPEC.md §15.7).
	expect(surface.textContent).toContain("so are its recovery points");
	const dialog = within(surface);
	const button = dialog.getByTestId("dialog-confirm");
	expect((button as HTMLButtonElement).disabled).toBe(true);

	const input = dialog.getByRole("textbox");
	fireEvent.change(input, { target: { value: `${TODO.slug}x` } });
	expect((button as HTMLButtonElement).disabled).toBe(true);

	fireEvent.change(input, { target: { value: TODO.slug } });
	expect((button as HTMLButtonElement).disabled).toBe(false);
});

test("the archived list opens in place with an unarchive action", async () => {
	await mount();

	expect(screen.queryByTestId(`project-unarchive-${OLD.id}`)).toBeNull();
	fireEvent.click(screen.getByTestId("archived-projects"));
	expect(await screen.findByTestId(`project-unarchive-${OLD.id}`)).toBeDefined();
});

/** SPEC.md §25.8: the count is part of the name, not glued to it. */
test.each([
	[[OLD], "Archived projects, 1 project"],
	[[], "Archived projects, 0 projects"],
])("the archived button reads its count as words", async (archived, name) => {
	await mount([TODO], archived);
	const button = screen.getByTestId("archived-projects");
	await waitFor(() => expect(button.getAttribute("aria-label")).toBe(name));
});

test("with no projects at all the centre invites you to make one", async () => {
	await mount([], [], `/workspaces/${WORKSPACE.id}`);

	expect(await screen.findByTestId("empty-projects")).toBeDefined();
});

/** Archiving is reversible, so it is not styled as danger. */
test("archive is a neutral action and confirms with a success toast", async () => {
	await mount();
	openMenu(TODO.id);
	const item = screen.getByTestId("project-archive").closest(".pk-menu-item");
	expect(item?.classList.contains("pk-menu-item--danger")).toBe(false);
	fireEvent.click(screen.getByTestId("project-archive"));

	const surface = await screen.findByTestId("dialog-archive-project");
	const confirm = within(surface).getByTestId("dialog-confirm");
	expect(confirm.className).not.toContain("bg-status-danger");
	fireEvent.click(confirm);

	const toast = await screen.findByText(`${TODO.name} archived`);
	expect(toast).toBeDefined();
	expect(screen.getByText("Find it under Archived projects.")).toBeDefined();
});

test("duplicating shows a success toast naming the new project", async () => {
	await mount();
	openMenu(TODO.id);
	fireEvent.click(screen.getByTestId("project-duplicate"));

	const surface = await screen.findByTestId("dialog-duplicate-project");
	fireEvent.click(within(surface).getByTestId("dialog-confirm"));

	expect(await screen.findByText(`${COPY.name} created`)).toBeDefined();
});

const AGENT_TAB = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CHAT_TAB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

async function sendAgents(terminals: unknown[]) {
	await act(async () => {
		workspaceSocket?.onmessage?.({
			data: JSON.stringify({ type: "coding-agents", terminals }),
		});
	});
}

function agentTab(overrides: Record<string, unknown> = {}) {
	return {
		terminalId: AGENT_TAB,
		projectId: TODO.id,
		name: "Terminal 2",
		kind: "terminal",
		agent: "claude",
		state: "working",
		since: new Date(Date.now() - 4 * 60_000 - 5_000).toISOString(),
		subagents: [],
		...overrides,
	};
}

test("each agent tab of every project has a row that links to its tab (SPEC.md §8.2)", async () => {
	await mount();
	await sendAgents([
		agentTab(),
		agentTab({
			terminalId: CHAT_TAB,
			projectId: NOTES.id,
			kind: "chat",
			state: "needs-input",
		}),
	]);

	const here = screen.getByTestId(`project-agents-${TODO.id}`);
	const tui = within(here).getByRole("link", { name: /Claude Code \(TUI\)/ });
	// The state and how long it has held are part of the link's name.
	expect(tui.textContent).toContain("Working 4m");
	expect(tui.getAttribute("href")).toBe(
		`/workspaces/${WORKSPACE.id}/projects/${TODO.id}?tab=${AGENT_TAB}`,
	);
	// A project that is not open shows its agents too, named as their tab is.
	const there = screen.getByTestId(`project-agents-${NOTES.id}`);
	expect(within(there).getByRole("link").textContent).toContain("Claude Code (GUI)");
	expect(within(there).getByRole("link").textContent).toContain("Needs input");
	// The project's own state mark stays.
	expect(screen.getByTestId(`project-agent-${NOTES.id}`)).toBeDefined();
	// A project with no agent tab has no list and no disclosure.
	expect(screen.queryByTestId(`project-agents-${GONE.id}`)).toBeNull();
	expect(screen.queryByTestId(`project-agents-toggle-${GONE.id}`)).toBeNull();
});

test("a subagent row names its work, its type and its state, and links to its tool row", async () => {
	await mount();
	await sendAgents([
		agentTab({
			kind: "chat",
			subagents: [
				{
					id: "toolu_01",
					type: "Explore",
					description: "Find the login code",
					state: "working",
					since: new Date().toISOString(),
				},
				{
					id: "toolu_02",
					type: "general-purpose",
					description: "",
					state: "finished",
					since: new Date().toISOString(),
				},
			],
		}),
	]);

	const working = screen.getByTestId("subagent-row-toolu_01");
	expect(working.textContent).toBe("Find the login codeExplore(working)");
	expect(working.getAttribute("href")).toBe(
		`/workspaces/${WORKSPACE.id}/projects/${TODO.id}?tab=${AGENT_TAB}&subagent=toolu_01`,
	);
	// With no description the type stands in, so the row is never blank.
	expect(screen.getByTestId("subagent-row-toolu_02").textContent).toContain(
		"general-purpose",
	);
});

test("a project's agents are one disclosure, open at first and remembered while the page lives", async () => {
	const app = await mount();
	await sendAgents([agentTab()]);

	const toggle = screen.getByTestId(`project-agents-toggle-${TODO.id}`);
	const list = screen.getByTestId(`project-agents-${TODO.id}`);
	expect(toggle.getAttribute("aria-expanded")).toBe("true");
	expect(toggle.getAttribute("aria-controls")).toBe(list.id);
	expect(toggle.getAttribute("aria-label")).toBe(`Agents in ${TODO.name}`);

	fireEvent.click(toggle);
	expect(toggle.getAttribute("aria-expanded")).toBe("false");
	expect(list.hidden).toBe(true);

	// Moving to another project keeps the choice; the pane is the same.
	await act(async () => {
		await app.router.navigate({
			to: "/workspaces/$id/projects/$projectId",
			params: { id: WORKSPACE.id, projectId: NOTES.id },
		});
	});
	expect(
		screen
			.getByTestId(`project-agents-toggle-${TODO.id}`)
			.getAttribute("aria-expanded"),
	).toBe("false");
});

test("an unread finish says so in the row's name and is bold", async () => {
	await mount();
	// The first list is the baseline; the change after it is news.
	await sendAgents([agentTab({ terminalId: CHAT_TAB, projectId: NOTES.id })]);
	await sendAgents([
		agentTab({ terminalId: CHAT_TAB, projectId: NOTES.id, state: "finished" }),
	]);

	const row = screen.getByTestId(`agent-row-${CHAT_TAB}`);
	expect(row.textContent).toContain("Finished");
	expect(row.textContent).toContain(", unread");
	expect(row.className).toContain("is-unread");
});
