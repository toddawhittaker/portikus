/**
 * The shell-level holder of the project events socket (SPEC.md §11.4,
 * BROWSER-HANDLING.md §18): one socket per open project, browser-open
 * requests queued once each, and the watch-limited flag shared.
 */
import type { BrowserOpenRequest } from "@portikus/contracts";
import { ToastProvider } from "@portikus/ui";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { createLayoutStore } from "../layout/store.js";
import { ProjectEvents, useWatchLimited } from "./ProjectEvents.js";

const hook = vi.hoisted(() => ({
	calls: [] as { workspaceId: string; projectId: string }[],
	onBrowserOpen: undefined as ((request: BrowserOpenRequest) => void) | undefined,
	limited: false,
}));

vi.mock("./useProjectEvents.js", () => ({
	useProjectEvents: (
		workspaceId: string,
		projectId: string,
		onBrowserOpen: (request: BrowserOpenRequest) => void,
	) => {
		hook.calls.push({ workspaceId, projectId });
		hook.onBrowserOpen = onBrowserOpen;
		return { limited: hook.limited };
	},
}));

const WORKSPACE = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";

afterEach(() => {
	cleanup();
	hook.calls = [];
	hook.onBrowserOpen = undefined;
	hook.limited = false;
});

function request(requestId: string): BrowserOpenRequest {
	return {
		type: "browser.open.request",
		requestId,
		workspaceId: WORKSPACE,
		url: `https://h${requestId.slice(0, 4)}.example.com/`,
		brokerClass: "external",
		requestedAt: "2026-01-01T00:00:00.000Z",
	};
}

function Limited() {
	return <span data-testid="limited">{String(useWatchLimited())}</span>;
}

function show(projectId: string | undefined) {
	const layoutStore = createLayoutStore();
	return render(
		<ToastProvider>
			<ProjectEvents
				workspaceId={WORKSPACE}
				projectId={projectId}
				layoutStore={layoutStore}
			>
				<Limited />
			</ProjectEvents>
		</ToastProvider>,
	);
}

test("no socket is opened while no project is open", () => {
	show(undefined);
	expect(hook.calls).toEqual([]);
	expect(screen.getByTestId("limited").textContent).toBe("false");
});

test("the open project's socket is opened", () => {
	show(PROJECT);
	expect(hook.calls[0]).toEqual({ workspaceId: WORKSPACE, projectId: PROJECT });
});

test("a repeated request shows once and requests queue one at a time", () => {
	show(PROJECT);
	act(() => {
		hook.onBrowserOpen?.(request("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"));
		hook.onBrowserOpen?.(request("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"));
		hook.onBrowserOpen?.(request("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"));
	});
	expect(screen.getAllByTestId("browser-open-dialog")).toHaveLength(1);
	expect(screen.getByTestId("browser-open-origin").textContent).toContain("haaaa");

	fireEvent.click(screen.getByTestId("browser-open-cancel"));
	expect(screen.getByTestId("browser-open-origin").textContent).toContain("hbbbb");
	fireEvent.click(screen.getByTestId("browser-open-cancel"));
	expect(screen.queryByTestId("browser-open-dialog")).toBeNull();
});

test("focus returns to the original element after a queue of two dialogs closes", async () => {
	const opener = document.createElement("button");
	document.body.append(opener);
	opener.focus();
	show(PROJECT);
	act(() => {
		hook.onBrowserOpen?.(request("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"));
		hook.onBrowserOpen?.(request("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"));
	});
	fireEvent.click(screen.getByTestId("browser-open-cancel"));
	fireEvent.click(screen.getByTestId("browser-open-cancel"));
	await waitFor(() => expect(document.activeElement).toBe(opener));
	opener.remove();
});

test("the watch-limited flag reaches the shell and clears when the project closes", () => {
	hook.limited = true;
	const view = show(PROJECT);
	expect(screen.getByTestId("limited").textContent).toBe("true");

	view.rerender(
		<ToastProvider>
			<ProjectEvents
				workspaceId={WORKSPACE}
				projectId={undefined}
				layoutStore={createLayoutStore()}
			>
				<Limited />
			</ProjectEvents>
		</ToastProvider>,
	);
	expect(screen.getByTestId("limited").textContent).toBe("false");
});
