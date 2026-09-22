import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
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
const NOTES = project({
	id: "55555555-5555-4555-8555-555555555555",
	slug: "notes",
	name: "notes",
	path: "/home/student/projects/notes",
	isGitRepo: false,
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

afterEach(() => vi.unstubAllGlobals());

/** Mounts the shell on the todo-api project with the given project lists. */
async function mount(
	active = [TODO, NOTES, GONE],
	archived = [OLD],
	path = `/workspaces/${WORKSPACE.id}/projects/${TODO.id}`,
) {
	stubFetch((url) => {
		if (url === "/auth/me") return json(200, USER);
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
	expect(screen.queryByTestId("project-git-init")).toBeNull();
});

/** Issue #361: Enter on the download item must start the download itself. */
test("the zip download is the menu item itself, a link", async () => {
	await mount();
	openMenu(TODO.id);

	const item = screen.getByRole("menuitem", { name: "Download as zip" });
	expect(item.tagName).toBe("A");
	expect(item.getAttribute("data-testid")).toBe("project-download");
	expect(item.getAttribute("href")).toContain(`/projects/${TODO.id}/`);
	expect(item.getAttribute("download")).toBe(`${TODO.slug}.zip`);
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
});

test("delete stays disabled until the folder name is typed exactly", async () => {
	await mount();
	openMenu(TODO.id);
	fireEvent.click(screen.getByTestId(`project-delete-${TODO.id}`));

	const dialog = within(await screen.findByTestId("dialog-delete-project"));
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

test("with no projects at all the centre invites you to make one", async () => {
	await mount([], [], `/workspaces/${WORKSPACE.id}`);

	expect(await screen.findByTestId("empty-projects")).toBeDefined();
});
