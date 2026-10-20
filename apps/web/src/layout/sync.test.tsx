/**
 * Live layout sync between browsers on one project (SPEC.md §7.5): versioned
 * saves, announcements, and the rules a remote load follows.
 */
import type { ProjectLayout } from "@portikus/contracts";
import { ToastProvider } from "@portikus/ui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { announceLayout } from "./announcements";
import { useLayoutPersistence } from "./persist";
import { REMOTE_FOCUS_LOST, useRemoteFocusFallback } from "./remoteFocus";
import { createLayoutStore, type LayoutStore } from "./store";
import { layoutTerminalIds } from "./tree";

const WORKSPACE = "22222222-2222-4222-8222-222222222222";
const T1 = "44444444-4444-4444-8444-444444444441";
const T2 = "44444444-4444-4444-8444-444444444442";
const T3 = "44444444-4444-4444-8444-444444444443";

let projectSeq = 0;
/** A fresh project id per test, since announcements outlive one test. */
function newProject(): string {
	projectSeq += 1;
	return `33333333-3333-4333-8333-${String(projectSeq).padStart(12, "0")}`;
}

function oneTab(terminalId: string): ProjectLayout {
	return { tabs: [{ id: terminalId, root: { type: "leaf", terminalId } }] };
}

function Persisted({ store, projectId }: { store: LayoutStore; projectId: string }) {
	useLayoutPersistence(WORKSPACE, projectId, store);
	return null;
}

function mount(store: LayoutStore, projectId: string) {
	return render(
		<QueryClientProvider client={new QueryClient()}>
			<ToastProvider>
				<Persisted store={store} projectId={projectId} />
			</ToastProvider>
		</QueryClientProvider>,
	);
}

/**
 * The API's layout route and hub in miniature: a versioned PUT, and an
 * announcement to every browser after each save.
 */
function fakeServer(projectId: string, initial: ProjectLayout | null, version = 0) {
	const server = { layout: initial, version, puts: 0, refused: 0 };
	const fetchMock = vi.fn(async (_input: string, init?: RequestInit) => {
		const etag = { etag: `"${server.version}"` };
		if (init?.method === "PUT") {
			const ifMatch = (init.headers as Record<string, string>)["if-match"];
			if (ifMatch !== `"${server.version}"`) {
				server.refused += 1;
				return new Response(
					JSON.stringify({ code: "LAYOUT_CHANGED", message: "Changed elsewhere." }),
					{ status: 412 },
				);
			}
			server.puts += 1;
			server.layout = JSON.parse(String(init.body));
			server.version += 1;
			const saved = server.version;
			queueMicrotask(() => announceLayout(WORKSPACE, projectId, saved));
			return new Response(null, { status: 204, headers: { etag: `"${saved}"` } });
		}
		if (server.layout === null)
			return new Response(null, { status: 204, headers: etag });
		return new Response(JSON.stringify(server.layout), { status: 200, headers: etag });
	});
	vi.stubGlobal("fetch", fetchMock);
	return { server, fetchMock };
}

async function settle(ms = 1_100) {
	await act(async () => {
		vi.advanceTimersByTime(ms);
	});
	for (let i = 0; i < 5; i++) {
		await act(async () => {
			await Promise.resolve();
		});
	}
}

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

test("a save names the version it was based on and takes the new one", async () => {
	vi.useFakeTimers({ shouldAdvanceTime: true });
	const project = newProject();
	const { fetchMock } = fakeServer(project, oneTab(T1), 4);
	const store = createLayoutStore();
	mount(store, project);
	await waitFor(() => expect(store.getState().version).toBe(4));

	act(() => store.getState().addTab(T2));
	await settle();
	const put = fetchMock.mock.calls.find((call) => call[1]?.method === "PUT");
	const headers = put?.[1]?.headers as Record<string, string> | undefined;
	expect(headers?.["if-match"]).toBe('"4"');
	await waitFor(() => expect(store.getState().version).toBe(5));
});

test("a refused save loads the server's layout instead", async () => {
	vi.useFakeTimers({ shouldAdvanceTime: true });
	const project = newProject();
	const { server } = fakeServer(project, oneTab(T1));
	const store = createLayoutStore();
	mount(store, project);
	await waitFor(() => expect(store.getState().version).toBe(0));

	// Another browser saved while this one missed the announcement.
	server.layout = oneTab(T3);
	server.version = 7;
	act(() => store.getState().addTab(T2));
	await settle();
	await waitFor(() => expect(store.getState().version).toBe(7));
	expect(server.refused).toBe(1);
	expect(layoutTerminalIds(store.getState().layout)).toEqual([T3]);
	expect(store.getState().dirty).toBe(false);
});

test("two browsers reach the same layout after one change, with no further writes", async () => {
	vi.useFakeTimers({ shouldAdvanceTime: true });
	const project = newProject();
	const { server } = fakeServer(project, oneTab(T1));
	const a = createLayoutStore();
	const b = createLayoutStore();
	mount(a, project);
	mount(b, project);
	await waitFor(() => expect(a.getState().version).toBe(0));
	await waitFor(() => expect(b.getState().version).toBe(0));
	act(() => {
		a.getState().reconcile([T1]);
		b.getState().reconcile([T1]);
	});

	// A makes a terminal and splits it in; B's terminal list has not caught up.
	act(() => {
		a.getState().splitLeaf(T1, "row", T2);
		a.getState().reconcile([T1, T2]);
	});
	await settle();
	await waitFor(() => expect(b.getState().version).toBe(1));
	act(() => b.getState().reconcile([T1]));
	await settle();
	act(() => b.getState().reconcile([T1, T2]));
	await settle(3_000);

	expect(server.puts).toBe(1);
	expect(server.refused).toBe(0);
	expect(b.getState().layout).toEqual(a.getState().layout);
	expect(a.getState().layout).toEqual(server.layout);
	expect(a.getState().version).toBe(1);
});

test("a browser ignores the echo of its own save", async () => {
	vi.useFakeTimers({ shouldAdvanceTime: true });
	const project = newProject();
	const { fetchMock } = fakeServer(project, oneTab(T1));
	const store = createLayoutStore();
	mount(store, project);
	await waitFor(() => expect(store.getState().version).toBe(0));
	const reads = () => fetchMock.mock.calls.filter((call) => !call[1]?.method).length;
	const before = reads();

	act(() => store.getState().addTab(T2));
	await settle(3_000);
	expect(store.getState().version).toBe(1);
	expect(reads()).toBe(before);
});

test("a remote layout waits for a drag to end", () => {
	const store = createLayoutStore();
	store.getState().load(oneTab(T1), 0);
	store.getState().setDragging(true);
	store.getState().loadRemote(oneTab(T2), 1);
	expect(layoutTerminalIds(store.getState().layout)).toEqual([T1]);
	store.getState().setDragging(false);
	expect(layoutTerminalIds(store.getState().layout)).toEqual([T2]);
	expect(store.getState().version).toBe(1);
	expect(store.getState().dirty).toBe(false);
});

test("a file with unsaved text keeps its pane when another browser closed it", () => {
	const store = createLayoutStore();
	store.getState().load(oneTab(T1), 0);
	store.getState().openFile("notes.md");
	store.getState().openFile("clean.md");
	store.getState().setTabUnsaved("file:notes.md", true);
	store.getState().clearDirty();

	store.getState().loadRemote(oneTab(T1), 1);
	const ids = store.getState().layout.tabs.map((tab) => tab.id);
	expect(ids).toEqual([T1, "file:notes.md"]);
	expect(store.getState().dirty).toBe(false);
	// The carried text is kept because the file is still open.
	store.getState().carryBuffer("notes.md", "draft");
	expect(store.getState().takeBuffer("notes.md")).toBe("draft");
});

test("a remote layout keeps this browser's tab and pane sizes", () => {
	const store = createLayoutStore();
	store.getState().load(oneTab(T1), 0);
	store.getState().splitLeaf(T1, "row", T2);
	store.getState().addTab(T3);
	store.getState().resize(T1, [], [30, 70]);
	store.getState().setActive(T3);
	const remote: ProjectLayout = {
		tabs: [
			{
				id: T1,
				root: {
					type: "split",
					direction: "row",
					sizes: [50, 50],
					children: [
						{ type: "leaf", terminalId: T1 },
						{ type: "leaf", terminalId: T2 },
					],
				},
			},
			{ id: T3, root: { type: "leaf", terminalId: T3 } },
			{ id: "file:x.ts", root: { type: "file", path: "x.ts" } },
		],
	};
	store.getState().loadRemote(remote, 3);
	const root = store.getState().layout.tabs[0]?.root;
	expect(root?.type === "split" && root.sizes).toEqual([30, 70]);
	expect(store.getState().activeTabId).toBe(T3);
	expect(store.getState().layout.tabs).toHaveLength(3);
});

test("an older or equal version is never loaded", () => {
	const store = createLayoutStore();
	store.getState().load(oneTab(T1), 5);
	store.getState().loadRemote(oneTab(T2), 5);
	store.getState().loadRemote(oneTab(T2), 4);
	expect(layoutTerminalIds(store.getState().layout)).toEqual([T1]);
});

test("a remote load that takes away the focused pane clears it and says so once", () => {
	const store = createLayoutStore();
	store.getState().load(oneTab(T1), 0);
	store.getState().addTab(T2);
	store.getState().setActive(T1);
	store.getState().setFocused(T1);
	store.getState().clearDirty();

	// T2 goes, but it was not focused, so nothing is said.
	store.getState().loadRemote(oneTab(T1), 1);
	expect(store.getState().remoteFocusLost).toBe(0);
	expect(store.getState().focusedPaneId).toBe(T1);

	store.getState().loadRemote(oneTab(T2), 2);
	expect(store.getState().focusedPaneId).toBeNull();
	expect(store.getState().remoteFocusLost).toBe(1);
});

test("a remote load that closes the last tab takes the focused pane with it", () => {
	const store = createLayoutStore();
	store.getState().load(oneTab(T1), 0);
	store.getState().setFocused(T1);
	store.getState().loadRemote({ tabs: [] }, 1);
	expect(store.getState().activeTabId).toBeNull();
	expect(store.getState().remoteFocusLost).toBe(1);
});

test("a focused pane moved out of the tab on screen counts as gone", () => {
	const store = createLayoutStore();
	store.getState().load(
		{
			tabs: [
				{ id: T1, root: { type: "leaf", terminalId: T1 } },
				{ id: T3, root: { type: "leaf", terminalId: T3 } },
			],
		},
		0,
	);
	store.getState().splitLeaf(T1, "row", T2);
	store.getState().setActive(T1);
	store.getState().setFocused(T2);
	store.getState().clearDirty();
	// T2 now sits beside T3, in the tab this browser is not showing.
	const remote: ProjectLayout = {
		tabs: [
			{ id: T1, root: { type: "leaf", terminalId: T1 } },
			{
				id: T3,
				root: {
					type: "split",
					direction: "row",
					sizes: [50, 50],
					children: [
						{ type: "leaf", terminalId: T3 },
						{ type: "leaf", terminalId: T2 },
					],
				},
			},
		],
	};
	store.getState().loadRemote(remote, 1);
	expect(store.getState().activeTabId).toBe(T1);
	expect(store.getState().remoteFocusLost).toBe(1);
});

function Fallback({ store }: { store: LayoutStore }) {
	const area = useRef<HTMLDivElement | null>(null);
	const said = useRemoteFocusFallback(store, area);
	return (
		<main aria-label="Work area" tabIndex={-1}>
			<div ref={area}>
				<p role="status">{said}</p>
				<button type="button">Elsewhere</button>
			</div>
		</main>
	);
}

test("when focus fell to the page, the work area takes it and the region says why", async () => {
	const store = createLayoutStore();
	store.getState().load(oneTab(T1), 0);
	store.getState().setFocused(T1);
	const view = render(<Fallback store={store} />);
	(document.activeElement as HTMLElement | null)?.blur();
	act(() => store.getState().loadRemote(oneTab(T2), 1));
	expect(document.activeElement).toBe(view.getByRole("main"));
	await waitFor(() =>
		expect(view.getByRole("status").textContent).toBe(REMOTE_FOCUS_LOST),
	);
});

test("focus the student moved elsewhere stays where it is", () => {
	const store = createLayoutStore();
	store.getState().load(oneTab(T1), 0);
	store.getState().setFocused(T1);
	const view = render(<Fallback store={store} />);
	const elsewhere = view.getByRole("button", { name: "Elsewhere" });
	elsewhere.focus();
	act(() => store.getState().loadRemote(oneTab(T2), 1));
	expect(document.activeElement).toBe(elsewhere);
	expect(view.getByRole("status").textContent).toBe("");
});
