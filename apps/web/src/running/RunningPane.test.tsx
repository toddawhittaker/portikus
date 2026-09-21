/**
 * The Running surface (SPEC.md §18.2): what each row says, which ports
 * offer actions, how a system listener is hidden, and how a saved preview
 * with no listener is marked (issues #265, #272, #273).
 */
import type { ListeningService } from "@portikus/contracts";
import { ToastProvider } from "@portikus/ui";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { RunningPane } from "./RunningPane.js";
import { ListeningContext } from "./services.js";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";

function service(over: Partial<ListeningService>): ListeningService {
	return {
		workspaceId: "22222222-2222-4222-8222-222222222222",
		port: 3000,
		addresses: ["0.0.0.0"],
		protocolHint: "http",
		process: { pid: 7, command: "node" },
		previewReachability: "reachable",
		system: false,
		observedAt: "2026-01-01T00:00:00.000Z",
		...over,
	};
}

function show(
	services: ListeningService[],
	options: { previewPorts?: number[]; onOpenPreview?: (port: number) => void } = {},
) {
	render(
		<ToastProvider>
			<ListeningContext.Provider value={{ services, loaded: true }}>
				<RunningPane
					workspaceId={WORKSPACE}
					previewPorts={options.previewPorts ?? []}
					onOpenPreview={options.onOpenPreview ?? (() => {})}
				/>
			</ListeningContext.Provider>
		</ToastProvider>,
	);
}

beforeEach(() => {
	localStorage.clear();
});

afterEach(() => {
	cleanup();
	vi.restoreAllMocks();
});

test("an empty workspace says nothing is running yet", () => {
	show([]);
	expect(screen.getByText("Nothing is running yet")).toBeTruthy();
});

test("a row names the port and the command", () => {
	show([service({ port: 3000 })]);
	expect(screen.getByTestId("running-row-3000").textContent).toContain("3000");
	expect(screen.getByTestId("running-row-3000").textContent).toContain("node");
});

test("the Docker chip appears only for a container, and never a Preview chip", () => {
	show([
		service({ port: 3000 }),
		service({
			port: 8080,
			process: { command: "postgres" },
			container: { id: "abc", name: "postgres" },
		}),
	]);
	expect(screen.getByTestId("running-row-3000").textContent).not.toContain("Docker");
	expect(screen.getByTestId("running-row-3000").textContent).not.toContain("Preview");
	expect(screen.getByTestId("running-row-8080").textContent).toContain("Docker");
});

test("a previewable port offers Open preview, a new tab and Stop", () => {
	show([service({ port: 3000 })]);
	expect(screen.getByTestId("running-open-3000")).toBeTruthy();
	expect(screen.getByTestId("running-new-tab-3000")).toBeTruthy();
	expect(screen.getByTestId("running-stop-3000")).toBeTruthy();
});

test("ports are listed lowest first", () => {
	show([service({ port: 8000 }), service({ port: 3000 })]);
	const ports = [...screen.getByTestId("running-list").querySelectorAll(".pk-portrow")]
		.map((row) => row.textContent?.slice(0, 4))
		.filter(Boolean);
	expect(ports[0]).toBe("3000");
	expect(ports[1]).toBe("8000");
});

test("Open preview opens the port it names", () => {
	const onOpenPreview = vi.fn();
	show([service({ port: 3000 })], { onOpenPreview });
	fireEvent.click(screen.getByTestId("running-open-3000"));
	expect(onOpenPreview).toHaveBeenCalledWith(3000);
});

test("a port policy denies says why instead of offering a preview", () => {
	// The API owns the port policy and reports it as previewReachability;
	// the pane does not keep a copy of the rules.
	show([service({ port: 5432, previewReachability: "denied" })]);
	expect(screen.queryByTestId("running-open-5432")).toBeNull();
	expect(screen.getByTestId("running-reason-5432").textContent).toBe("reserved port");
	// It is still the student's process, so it can still be stopped.
	expect(screen.getByTestId("running-stop-5432")).toBeTruthy();
});

test("a system listener is hidden until the toggle is on", () => {
	show([
		service({ port: 5173 }),
		service({ port: 5355, system: true, process: { command: "systemd-resolve" } }),
	]);
	expect(screen.queryByTestId("running-row-5355")).toBeNull();
	fireEvent.click(screen.getByRole("checkbox"));
	expect(screen.getByTestId("running-row-5355")).toBeTruthy();
	expect(screen.getByTestId("running-reason-5355").textContent).toBe("system service");
	// Nothing about a system service can be acted on.
	expect(screen.queryByTestId("running-stop-5355")).toBeNull();
	expect(screen.queryByTestId("running-open-5355")).toBeNull();
});

test("the toggle is remembered for the next visit", () => {
	show([service({ port: 5355, system: true })]);
	fireEvent.click(screen.getByRole("checkbox"));
	cleanup();
	show([service({ port: 5355, system: true })]);
	expect(screen.getByTestId("running-row-5355")).toBeTruthy();
});

test("no toggle is shown when nothing is hidden", () => {
	show([service({ port: 3000 })]);
	expect(screen.queryByTestId("running-system-toggle")).toBeNull();
});

test("Stop asks first, naming the command and the port", async () => {
	const stop = vi.spyOn(globalThis, "fetch").mockResolvedValue(
		new Response("{}", {
			status: 200,
			headers: { "content-type": "application/json" },
		}),
	);
	show([service({ port: 5173 })]);
	fireEvent.click(screen.getByTestId("running-stop-5173"));
	expect(screen.getByTestId("dialog-stop-listener").textContent).toContain(
		"Stop node on port 5173?",
	);
	fireEvent.click(screen.getByTestId("dialog-confirm"));
	await waitFor(() => expect(stop).toHaveBeenCalled());
	expect(String(stop.mock.calls[0]?.[0])).toContain(
		`/workspaces/${WORKSPACE}/listening/5173/stop`,
	);
});

test("a saved preview whose port stopped is marked as not running", () => {
	show([service({ port: 3000 })], { previewPorts: [3000, 5173] });
	expect(screen.queryByTestId("running-stale-3000")).toBeNull();
	expect(screen.getByTestId("running-stale-5173").textContent).toContain("not running");
});
