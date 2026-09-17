import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { useLayoutPersistence } from "./persist";
import { createLayoutStore, type LayoutStore } from "./store";

const WORKSPACE = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const URL = `/workspaces/${WORKSPACE}/projects/${PROJECT}/layout`;

function Harness({ store }: { store: LayoutStore }) {
	const loaded = useLayoutPersistence(WORKSPACE, PROJECT, store, () => {});
	return <span data-testid="loaded">{loaded ? "yes" : "no"}</span>;
}

function stubFetch(get: () => Response) {
	const fetchMock = vi.fn(async (_input: string, init?: RequestInit) => {
		if (init?.method === "PUT") return { status: 204, ok: true } as Response;
		return get();
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

function noContent(): Response {
	return { status: 204, ok: true } as Response;
}

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

test("a saved layout is loaded into the store", async () => {
	const saved = {
		tabs: [
			{
				id: "tab1",
				root: { type: "leaf", terminalId: "44444444-4444-4444-8444-444444444444" },
			},
		],
	};
	stubFetch(() => ({ status: 200, ok: true, json: async () => saved }) as Response);
	const store = createLayoutStore();
	render(<Harness store={store} />);
	await waitFor(() => expect(store.getState().layout.tabs).toHaveLength(1));
	expect(store.getState().dirty).toBe(false);
});

test("several changes are saved once, a second after the last one", async () => {
	vi.useFakeTimers({ shouldAdvanceTime: true });
	const fetchMock = stubFetch(noContent);
	const store = createLayoutStore();
	render(<Harness store={store} />);
	await waitFor(() => expect(fetchMock).toHaveBeenCalled());

	act(() => {
		store.getState().addTab("a");
		store.getState().addTab("b");
	});
	act(() => {
		vi.advanceTimersByTime(500);
	});
	store.getState().addTab("c");
	expect(fetchMock.mock.calls.filter(isPut)).toHaveLength(0);

	act(() => {
		vi.advanceTimersByTime(600);
	});
	const puts = fetchMock.mock.calls.filter(isPut);
	expect(puts).toHaveLength(1);
	expect(puts[0]?.[0]).toBe(URL);
	expect(JSON.parse(String(puts[0]?.[1]?.body)).tabs).toHaveLength(3);
	expect(store.getState().dirty).toBe(false);
});

test("unmounting flushes a pending save", async () => {
	vi.useFakeTimers({ shouldAdvanceTime: true });
	const fetchMock = stubFetch(noContent);
	const store = createLayoutStore();
	const view = render(<Harness store={store} />);
	await waitFor(() => expect(fetchMock).toHaveBeenCalled());

	act(() => {
		store.getState().addTab("a");
	});
	expect(fetchMock.mock.calls.filter(isPut)).toHaveLength(0);
	view.unmount();
	expect(fetchMock.mock.calls.filter(isPut)).toHaveLength(1);
});

test("an active tab change is never saved", async () => {
	vi.useFakeTimers({ shouldAdvanceTime: true });
	const fetchMock = stubFetch(noContent);
	const store = createLayoutStore();
	render(<Harness store={store} />);
	await waitFor(() => expect(fetchMock).toHaveBeenCalled());

	act(() => {
		store.getState().setActive("tab1");
		store.getState().setFocused("a");
		vi.advanceTimersByTime(2_000);
	});
	expect(fetchMock.mock.calls.filter(isPut)).toHaveLength(0);
});

function isPut(call: [string, RequestInit?]): boolean {
	return call[1]?.method === "PUT";
}
