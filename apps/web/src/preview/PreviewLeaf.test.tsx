/**
 * The Preview tab's states (SPEC.md §14.6, §14.8, BROWSER-HANDLING.md §12).
 * The grant call is stubbed, so these tests are about what the student sees
 * and about the frame policy the design fixes.
 */
import type { ListeningService } from "@portikus/contracts";
import { ToastProvider } from "@portikus/ui";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ListeningContext } from "../running/services.js";
import { json, stubFetch } from "../test-utils.js";
import { resetPreviewHistory } from "./history.js";
import { PreviewLeaf } from "./PreviewLeaf.js";

const WORKSPACE = "22222222-2222-4222-8222-222222222222";

const GRANT = {
	previewOrigin: "https://alice-5173.preview.portikus.example.edu",
	bootstrapUrl:
		"https://alice-5173.preview.portikus.example.edu/__portikus/bootstrap?t=abc",
	expiresAt: "2026-01-01T00:00:30.000Z",
};

function service(port: number): ListeningService {
	return {
		workspaceId: WORKSPACE,
		port,
		addresses: ["0.0.0.0"],
		protocolHint: "http",
		process: { pid: 1, command: "node" },
		previewReachability: "reachable",
		system: false,
		observedAt: "2026-01-01T00:00:00.000Z",
	};
}

function show(options: {
	services?: ListeningService[];
	loaded?: boolean;
	port?: number;
}) {
	const port = options.port ?? 5173;
	render(
		<ToastProvider>
			<ListeningContext.Provider
				value={{
					services: options.services ?? [service(port)],
					loaded: options.loaded ?? true,
				}}
			>
				<PreviewLeaf
					workspaceId={WORKSPACE}
					port={port}
					visible={true}
					onShowRunning={() => {}}
				/>
			</ListeningContext.Provider>
		</ToastProvider>,
	);
}

afterEach(() => {
	cleanup();
	resetPreviewHistory();
	vi.unstubAllGlobals();
});

/**
 * A stand-in for the browser tab's history, so a test can say whether the
 * frame has an entry of its own beyond the anchor (issue #283).
 */
function stubHistory() {
	const back = vi.fn();
	const forward = vi.fn();
	let length = 1;
	vi.stubGlobal("history", {
		get length() {
			return length;
		},
		state: null,
		back,
		forward,
		pushState: () => {
			length += 1;
		},
	});
	return { back, forward, frameNavigates: () => (length += 1) };
}

beforeEach(() => {
	vi.useRealTimers();
});

test("a granted preview points the frame at the bootstrap URL", async () => {
	stubFetch(() => json(200, GRANT));
	show({});
	const frame = await screen.findByTestId("preview-frame");
	expect(frame.getAttribute("src")).toBe(GRANT.bootstrapUrl);
	expect(screen.getByTestId("preview-host").textContent).toBe(
		"alice-5173.preview.portikus.example.edu",
	);
});

test("the frame carries the sandbox and permissions policy the design fixes", async () => {
	stubFetch(() => json(200, GRANT));
	show({});
	const frame = await screen.findByTestId("preview-frame");
	expect(frame.getAttribute("sandbox")).toBe(
		"allow-scripts allow-same-origin allow-forms allow-modals allow-popups allow-downloads allow-pointer-lock",
	);
	expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
	expect(frame.getAttribute("allow")).toBe(
		"clipboard-read 'none'; clipboard-write 'self'; camera 'none'; microphone 'none'; geolocation 'none'",
	);
	// Top navigation is never granted (BROWSER-HANDLING.md §12).
	expect(frame.getAttribute("sandbox")).not.toContain("allow-top-navigation");
});

test("a port nothing is listening on says so and asks no grant", async () => {
	const fetchMock = stubFetch(() => json(200, GRANT));
	show({ services: [] });
	expect((await screen.findByTestId("preview-inactive")).textContent).toBe(
		"Nothing is currently listening on port 5173. Start your application to reconnect this preview.",
	);
	expect(fetchMock).not.toHaveBeenCalled();
	// Announced, not only shown (issue #363).
	expect(screen.getByTestId("preview-status").getAttribute("role")).toBe("status");
	expect(screen.getByTestId("preview-status").textContent).toBe(
		"Nothing is running on port 5173",
	);
});

test("the preview reconnects when the port starts listening again", async () => {
	stubFetch(() => json(200, GRANT));
	const { rerender } = render(
		<ToastProvider>
			<ListeningContext.Provider value={{ services: [], loaded: true }}>
				<PreviewLeaf
					workspaceId={WORKSPACE}
					port={5173}
					visible={true}
					onShowRunning={() => {}}
				/>
			</ListeningContext.Provider>
		</ToastProvider>,
	);
	await screen.findByTestId("preview-inactive");
	rerender(
		<ToastProvider>
			<ListeningContext.Provider value={{ services: [service(5173)], loaded: true }}>
				<PreviewLeaf
					workspaceId={WORKSPACE}
					port={5173}
					visible={true}
					onShowRunning={() => {}}
				/>
			</ListeningContext.Provider>
		</ToastProvider>,
	);
	expect((await screen.findByTestId("preview-frame")).getAttribute("src")).toBe(
		GRANT.bootstrapUrl,
	);
});

test("a refused grant says the student may not preview this workspace", async () => {
	stubFetch(() => json(403, { code: "FORBIDDEN", message: "no" }));
	show({});
	expect(await screen.findByTestId("preview-unauthorized")).toBeTruthy();
	expect(screen.getByTestId("preview-status").textContent).toBe(
		"You cannot preview this workspace",
	);
});

test("a grant the gateway could not open shows its message", async () => {
	stubFetch(() =>
		json(409, {
			code: "AGENT_UNAVAILABLE",
			message: "That port could not be reached inside your workspace.",
		}),
	);
	show({});
	expect((await screen.findByTestId("preview-error")).textContent).toBe(
		"That port could not be reached inside your workspace.",
	);
});

test("a port policy refuses keeps the sentence about the port", async () => {
	stubFetch(() =>
		json(403, {
			code: "PREVIEW_PORT_NOT_ALLOWED",
			message: "Port 5432 cannot be previewed",
		}),
	);
	show({});
	expect((await screen.findByTestId("preview-error")).textContent).toBe(
		"Port 5432 cannot be previewed",
	);
	expect(screen.queryByTestId("preview-unauthorized")).toBeNull();
});

test("a server failure falls back to a plain sentence", async () => {
	stubFetch(() => json(500, { code: "INTERNAL", message: "boom" }));
	show({});
	expect((await screen.findByTestId("preview-error")).textContent).toBe("boom");
});

test("an application that refuses framing is offered in a new tab at once", async () => {
	// Chromium fires the frame's load event even for a navigation it refused,
	// so the eight-second guess never fires. The control plane's probe is what
	// tells the tab (BROWSER-HANDLING.md §12).
	stubFetch((url) =>
		url.includes("/preview/embeddable")
			? json(200, { embeddable: false, reason: "x-frame-options" })
			: json(200, GRANT),
	);
	show({});
	const frame = await screen.findByTestId("preview-frame");
	expect(await screen.findByTestId("preview-blocked")).toBeTruthy();
	expect(screen.getByTestId("preview-blocked-new-tab")).toBeTruthy();

	// The refused navigation's load event must not clear the notice.
	fireEvent.load(frame);
	await waitFor(() =>
		expect(screen.getByTestId("preview-pane-5173").dataset.state).toBe("blocked"),
	);
	expect(screen.getByTestId("preview-blocked")).toBeTruthy();
});

test("a dev server refusing the preview host gets the line to paste", async () => {
	// The control plane recognised Vite's blocked-host answer (issue #262).
	stubFetch((url) =>
		url.includes("/preview/embeddable")
			? json(200, {
					embeddable: false,
					reason: "host-refused",
					refusedHost: "alice-5173.preview.portikus.example.edu",
					refusedServer: "vite",
				})
			: json(200, GRANT),
	);
	const writeText = vi.fn(async () => {});
	vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
	show({});

	const line = await screen.findByTestId("preview-refused-line");
	// The suffix is the real one, with the workspace label dropped so the
	// line covers every port and project.
	expect(line.textContent).toBe(
		'server: { allowedHosts: [".preview.portikus.example.edu"] }',
	);
	expect(screen.getByTestId("preview-refused").textContent).toContain(
		"alice-5173.preview.portikus.example.edu",
	);
	expect(screen.getByTestId("preview-pane-5173").dataset.state).toBe("host-refused");
	// The student is not told the application cannot be embedded: it can.
	expect(screen.queryByTestId("preview-blocked")).toBeNull();

	fireEvent.click(screen.getByTestId("preview-refused-copy"));
	await waitFor(() =>
		expect(writeText).toHaveBeenCalledWith(
			'server: { allowedHosts: [".preview.portikus.example.edu"] }',
		),
	);
	expect(screen.getByTestId("preview-retry")).toBeTruthy();
});

test("webpack-dev-server gets its own setting", async () => {
	stubFetch((url) =>
		url.includes("/preview/embeddable")
			? json(200, {
					embeddable: false,
					reason: "host-refused",
					refusedHost: "alice-8080.preview.portikus.example.edu",
					refusedServer: "webpack-dev-server",
				})
			: json(200, GRANT),
	);
	show({});
	const line = await screen.findByTestId("preview-refused-line");
	expect(line.textContent).toBe(
		'devServer: { allowedHosts: [".preview.portikus.example.edu"] }',
	);
});

/**
 * Back must never take the Portikus document away, so a press with nothing
 * behind the anchor does nothing at all (issue #283).
 */
test("Back on a fresh preview does nothing and explains itself", async () => {
	stubFetch(() => json(200, GRANT));
	const tab = stubHistory();
	show({});
	await screen.findByTestId("preview-frame");

	const backButton = screen.getByTestId("preview-back") as HTMLButtonElement;
	expect(backButton.disabled).toBe(false);
	fireEvent.click(backButton);
	expect(tab.back).not.toHaveBeenCalled();
	await waitFor(() =>
		expect(backButton.getAttribute("title")).toBe("Nothing to go back to"),
	);
});

test("a late load from an earlier Back does not clear the hint", async () => {
	// Chromium can fire the frame's load for a step Back after the next
	// press has already found nothing left.
	stubFetch(() => json(200, GRANT));
	stubHistory();
	show({});
	const frame = await screen.findByTestId("preview-frame");
	fireEvent.load(frame);

	const backButton = screen.getByTestId("preview-back") as HTMLButtonElement;
	fireEvent.click(backButton);
	await waitFor(() =>
		expect(backButton.getAttribute("title")).toBe("Nothing to go back to"),
	);
	fireEvent.load(frame);
	expect(backButton.getAttribute("title")).toBe("Nothing to go back to");
});

test("a load that adds an entry clears the hint", async () => {
	stubFetch(() => json(200, GRANT));
	const tab = stubHistory();
	show({});
	const frame = await screen.findByTestId("preview-frame");
	const backButton = screen.getByTestId("preview-back") as HTMLButtonElement;
	fireEvent.click(backButton);
	await waitFor(() =>
		expect(backButton.getAttribute("title")).toBe("Nothing to go back to"),
	);
	tab.frameNavigates();
	fireEvent.load(frame);
	await waitFor(() => expect(backButton.getAttribute("title")).toBe(null));
});

test("Back steps once the frame has an entry of its own, and Forward always does", async () => {
	stubFetch(() => json(200, GRANT));
	const tab = stubHistory();
	show({});
	await screen.findByTestId("preview-frame");
	tab.frameNavigates();

	const backButton = screen.getByTestId("preview-back") as HTMLButtonElement;
	const forwardButton = screen.getByTestId("preview-forward") as HTMLButtonElement;
	expect(forwardButton.disabled).toBe(false);

	fireEvent.click(backButton);
	fireEvent.click(forwardButton);
	expect(tab.back).toHaveBeenCalledTimes(1);
	expect(tab.forward).toHaveBeenCalledTimes(1);
	expect(backButton.getAttribute("title")).toBe(null);
});

test("an application the probe could not reach keeps the timeout", async () => {
	vi.useFakeTimers({ shouldAdvanceTime: true });
	stubFetch((url) =>
		url.includes("/preview/embeddable")
			? json(200, { embeddable: false, reason: "unreachable" })
			: json(200, GRANT),
	);
	show({});
	const frame = await screen.findByTestId("preview-frame");
	// An application still starting up is not a refusal; a load clears it.
	fireEvent.load(frame);
	await vi.advanceTimersByTimeAsync(9_000);
	expect(screen.queryByTestId("preview-blocked")).toBeNull();
	expect(screen.getByTestId("preview-pane-5173").dataset.state).toBe("available");
	vi.useRealTimers();
});

test("an application the probe allows is shown in the frame", async () => {
	stubFetch((url) =>
		url.includes("/preview/embeddable")
			? json(200, { embeddable: true })
			: json(200, GRANT),
	);
	show({});
	const frame = await screen.findByTestId("preview-frame");
	fireEvent.load(frame);
	await waitFor(() =>
		expect(screen.getByTestId("preview-pane-5173").dataset.state).toBe("available"),
	);
	expect(screen.queryByTestId("preview-blocked")).toBeNull();
});

test("a frame that never loads offers to open the preview in a new tab", async () => {
	vi.useFakeTimers({ shouldAdvanceTime: true });
	stubFetch(() => json(200, GRANT));
	show({});
	await screen.findByTestId("preview-frame");
	await vi.advanceTimersByTimeAsync(9_000);
	expect(await screen.findByTestId("preview-blocked")).toBeTruthy();
	expect(screen.getByTestId("preview-blocked-new-tab")).toBeTruthy();
	vi.useRealTimers();
});

test("copying the URL copies the origin and warns that sign-in is needed", async () => {
	stubFetch(() => json(200, GRANT));
	const writeText = vi.fn(async () => {});
	vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
	show({});
	await screen.findByTestId("preview-frame");
	openMore();
	fireEvent.click(await screen.findByTestId("preview-copy"));
	await waitFor(() => expect(writeText).toHaveBeenCalledWith(GRANT.previewOrigin));
	expect(
		await screen.findByText("This link only works while you are signed in."),
	).toBeTruthy();
});

test("a viewport preset limits the width of the frame", async () => {
	stubFetch(() => json(200, GRANT));
	show({});
	const frame = await screen.findByTestId("preview-frame");
	expect(frame.style.maxWidth).toBe("");
	openMore();
	fireEvent.click(await screen.findByTestId("preview-width-768"));
	expect(screen.getByTestId("preview-frame").style.maxWidth).toBe("768px");
	openMore();
	expect(
		(await screen.findByTestId("preview-width-768")).getAttribute("aria-checked"),
	).toBe("true");
});

test("resetting preview data revokes, clears the origin, and re-grants", async () => {
	// Three steps in order (BROWSER-HANDLING.md §16.4). The middle one goes to
	// the preview origin from this page, because a service worker inside the
	// frame could answer a navigation the frame made itself.
	const seen: string[] = [];
	const modes: (string | undefined)[] = [];
	stubFetch((url, init) => {
		seen.push(url);
		modes.push(init?.mode);
		return url.endsWith("/preview/reset") ? json(204, null) : json(200, GRANT);
	});
	show({});
	await screen.findByTestId("preview-frame");
	const grantsBefore = seen.filter((url) => url.endsWith("/preview-grants")).length;
	openMore();
	fireEvent.click(await screen.findByTestId("preview-reset"));

	await waitFor(() =>
		expect(
			seen.filter((url) => url.endsWith("/preview-grants")).length,
		).toBeGreaterThan(grantsBefore),
	);
	const revoke = seen.indexOf(`/workspaces/${WORKSPACE}/preview/reset`);
	const clear = seen.indexOf(`${GRANT.previewOrigin}/__portikus/reset`);
	const regrant = seen.map((url) => url.endsWith("/preview-grants")).lastIndexOf(true);
	expect(revoke).toBeGreaterThanOrEqual(0);
	expect(clear).toBeGreaterThan(revoke);
	expect(regrant).toBeGreaterThan(clear);
	expect(modes[clear]).toBe("no-cors");
});

/** Open the toolbar's "more" menu (Radix opens a dropdown on pointer down). */
function openMore() {
	fireEvent.pointerDown(screen.getByTestId("preview-more"), {
		button: 0,
		ctrlKey: false,
	});
}

test("the bar keeps host, Back, Forward, Reload and new tab; the rest is in the menu", async () => {
	stubFetch(() => json(200, GRANT));
	show({});
	await screen.findByTestId("preview-frame");
	for (const id of [
		"preview-host",
		"preview-back",
		"preview-forward",
		"preview-reload",
		"preview-new-tab",
	]) {
		expect(screen.getByTestId(id)).toBeTruthy();
	}
	expect(screen.queryByTestId("preview-copy")).toBeNull();
	expect(screen.getByRole("button", { name: "More preview actions" })).toBeTruthy();

	openMore();
	const menu = await screen.findByRole("menu", { name: "More preview actions" });
	const names = Array.from(
		menu.querySelectorAll('[role="menuitem"], [role="menuitemcheckbox"]'),
	).map((item) => item.textContent);
	expect(names).toEqual([
		"Copy URL",
		"Fit",
		"375 px",
		"768 px",
		"1024 px",
		"1440 px",
		"Reset preview data",
		"Show in Running",
	]);
	expect(menu.textContent).toContain("Width");
	expect(screen.getByTestId("preview-width-fit").getAttribute("aria-checked")).toBe(
		"true",
	);
	expect(screen.getByTestId("preview-width-768").getAttribute("aria-checked")).toBe(
		"false",
	);
});

test("Show in Running calls back to the shell", async () => {
	stubFetch(() => json(200, GRANT));
	const onShowRunning = vi.fn();
	render(
		<ToastProvider>
			<ListeningContext.Provider value={{ services: [service(5173)], loaded: true }}>
				<PreviewLeaf
					workspaceId={WORKSPACE}
					port={5173}
					visible
					onShowRunning={onShowRunning}
				/>
			</ListeningContext.Provider>
		</ToastProvider>,
	);
	await screen.findByTestId("preview-frame");
	openMore();
	fireEvent.click(await screen.findByTestId("preview-running-link"));
	expect(onShowRunning).toHaveBeenCalledOnce();
});

/** A stand-in for the window a click opens, with the parts the tab uses. */
function placeholder() {
	return {
		opener: {} as unknown,
		location: { replace: vi.fn() },
		close: vi.fn(),
	};
}

test("open in a new tab asks for a top-level grant and opens exactly one tab", async () => {
	const bodies: string[] = [];
	stubFetch((_url, init) => {
		bodies.push(String(init?.body ?? ""));
		return json(200, GRANT);
	});
	const opened = placeholder();
	const open = vi.fn((_url?: string, _target?: string, _features?: string) => opened);
	vi.stubGlobal("open", open);
	show({});
	await screen.findByTestId("preview-frame");
	fireEvent.click(screen.getByTestId("preview-new-tab"));
	await waitFor(() =>
		expect(opened.location.replace).toHaveBeenCalledWith(GRANT.bootstrapUrl),
	);
	expect(bodies.some((body) => body.includes('"presentation":"top-level"'))).toBe(true);
	// One call only: a second open would leave the student with two tabs.
	expect(open).toHaveBeenCalledTimes(1);
	// Asking for `noopener` or `noreferrer` makes Chromium return null, which
	// is what orphaned the placeholder; the back-reference is cut on the
	// handle instead.
	expect(open.mock.calls[0]?.[2]).toBeUndefined();
	expect(opened.opener).toBeNull();
	expect(opened.close).not.toHaveBeenCalled();
});

test("a failed grant closes the tab that was opened for it", async () => {
	stubFetch((url) =>
		String(url).endsWith("/preview-grants")
			? json(500, { code: "INTERNAL", message: "no" })
			: json(200, GRANT),
	);
	const opened = placeholder();
	const open = vi.fn(() => opened);
	vi.stubGlobal("open", open);
	show({});
	fireEvent.click(screen.getByTestId("preview-new-tab"));
	await waitFor(() => expect(opened.close).toHaveBeenCalled());
	expect(opened.location.replace).not.toHaveBeenCalled();
	expect(open).toHaveBeenCalledTimes(1);
});

/** A tab wired to one listening list, for the re-render tests below. */
function tab(services: ListeningService[]) {
	return (
		<ToastProvider>
			<ListeningContext.Provider value={{ services, loaded: true }}>
				<PreviewLeaf
					workspaceId={WORKSPACE}
					port={5173}
					visible={true}
					onShowRunning={() => {}}
				/>
			</ListeningContext.Provider>
		</ToastProvider>
	);
}

test("a slow application that loads after the blocked guess recovers", async () => {
	// The eight-second guess is only a guess: a first `next dev` compile can
	// take longer, so a late load has to put the tab right by itself.
	vi.useFakeTimers({ shouldAdvanceTime: true });
	stubFetch(() => json(200, GRANT));
	show({});
	const frame = await screen.findByTestId("preview-frame");
	await vi.advanceTimersByTimeAsync(9_000);
	await screen.findByTestId("preview-blocked");
	// The frame is still there, so the load that was in flight still is too.
	expect(screen.getByTestId("preview-frame")).toBe(frame);

	fireEvent.load(frame);
	await waitFor(() => expect(screen.queryByTestId("preview-blocked")).toBeNull());
	expect(screen.getByTestId("preview-pane-5173").dataset.state).toBe("available");

	// The guess does not come back for a frame that has already loaded.
	await vi.advanceTimersByTimeAsync(9_000);
	expect(screen.queryByTestId("preview-blocked")).toBeNull();
	vi.useRealTimers();
});

test("a listening list that empties for a moment leaves a running preview alone", async () => {
	// The registry reports an empty list for a second or two after an API
	// restart. Tearing the frame down and minting a new grant would reload
	// the student's application for no reason (SPEC.md §14.8).
	vi.useFakeTimers({ shouldAdvanceTime: true });
	let grants = 0;
	stubFetch((url) => {
		if (url.endsWith("/preview-grants")) grants += 1;
		return json(200, GRANT);
	});
	const { rerender } = render(tab([service(5173)]));
	const frame = await screen.findByTestId("preview-frame");
	await waitFor(() => expect(grants).toBe(1));

	rerender(tab([]));
	await vi.advanceTimersByTimeAsync(1_000);
	expect(screen.getByTestId("preview-frame")).toBe(frame);

	rerender(tab([service(5173)]));
	await vi.advanceTimersByTimeAsync(1_000);
	expect(screen.getByTestId("preview-frame")).toBe(frame);
	expect(grants).toBe(1);
	vi.useRealTimers();
});

test("a list that empties while the grant is in flight asks for one grant, not two", async () => {
	// A second grant would remount the frame and load the application twice.
	const answers: ((response: Response) => void)[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(
			(input: RequestInfo | URL) =>
				new Promise<Response>((resolve) => {
					if (String(input).endsWith("/preview-grants")) answers.push(resolve);
					else resolve(json(200, { embeddable: true }));
				}),
		),
	);
	const { rerender } = render(tab([service(5173)]));
	await waitFor(() => expect(answers).toHaveLength(1));

	rerender(tab([]));
	rerender(tab([service(5173)]));
	for (const answer of answers) answer(json(200, GRANT));
	await screen.findByTestId("preview-frame");
	expect(answers).toHaveLength(1);
});

test("a port that stays quiet past the grace says nothing is listening", async () => {
	vi.useFakeTimers({ shouldAdvanceTime: true });
	stubFetch(() => json(200, GRANT));
	const { rerender } = render(tab([service(5173)]));
	await screen.findByTestId("preview-frame");

	rerender(tab([]));
	await vi.advanceTimersByTimeAsync(5_000);
	expect(await screen.findByTestId("preview-inactive")).toBeTruthy();
	expect(screen.queryByTestId("preview-frame")).toBeNull();
	vi.useRealTimers();
});
