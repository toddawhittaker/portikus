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
	vi.unstubAllGlobals();
});

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

test("a server failure falls back to a plain sentence", async () => {
	stubFetch(() => json(500, { code: "INTERNAL", message: "boom" }));
	show({});
	expect((await screen.findByTestId("preview-error")).textContent).toBe("boom");
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
	fireEvent.click(screen.getByTestId("preview-copy"));
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
	fireEvent.change(screen.getByTestId("preview-width"), { target: { value: "768" } });
	expect(screen.getByTestId("preview-frame").style.maxWidth).toBe("768px");
});

test("resetting preview data posts to the reset route and asks for a fresh grant", async () => {
	const seen: string[] = [];
	stubFetch((url) => {
		seen.push(url);
		return url.endsWith("/preview/reset") ? json(204, null) : json(200, GRANT);
	});
	show({});
	await screen.findByTestId("preview-frame");
	fireEvent.click(screen.getByTestId("preview-reset"));
	await waitFor(() => expect(seen).toContain(`/workspaces/${WORKSPACE}/preview/reset`));
	await waitFor(() =>
		expect(
			seen.filter((url) => url.endsWith("/preview-grants")).length,
		).toBeGreaterThan(1),
	);
});

test("open in a new tab asks for a top-level grant", async () => {
	const bodies: string[] = [];
	stubFetch((_url, init) => {
		bodies.push(String(init?.body ?? ""));
		return json(200, GRANT);
	});
	const opened = { location: { href: "" }, close: vi.fn() };
	vi.stubGlobal(
		"open",
		vi.fn(() => opened),
	);
	show({});
	await screen.findByTestId("preview-frame");
	fireEvent.click(screen.getByTestId("preview-new-tab"));
	await waitFor(() => expect(opened.location.href).toBe(GRANT.bootstrapUrl));
	expect(bodies.some((body) => body.includes('"presentation":"top-level"'))).toBe(true);
});
