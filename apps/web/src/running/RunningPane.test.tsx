/**
 * The Running surface (SPEC.md §18.2): what each row says, which ports
 * offer actions, how a system listener is hidden, and what selecting a
 * row shows (issues #265, #272, #273, #325, #326).
 */
import type { ListeningService } from "@portikus/contracts";
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
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { RunningPane } from "./RunningPane.js";
import { ListeningContext } from "./services.js";

const USAGE = {
	observedAt: "2026-01-01T00:00:00.000Z",
	cpuPercent: 1,
	memory: { usedBytes: 1024, totalBytes: 2048 },
	disk: { usedBytes: 1024, totalBytes: 4096 },
	network: { receiveBytesPerSecond: 0, transmitBytesPerSecond: 0 },
	processes: [
		{
			pid: 7,
			cpuPercent: 1,
			residentBytes: 4096,
			command: "node",
			startTicks: 100,
			stoppable: true,
			commandLine: null,
		},
	],
	storage: { home: null, docker: null, recovery: null },
};

let client: QueryClient;

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

function selectRow(port: number) {
	const button = screen
		.getByTestId(`running-row-${port}`)
		.querySelector("button.pk-portrow-select");
	if (!(button instanceof HTMLButtonElement)) {
		throw new Error(`row ${port} has no select button`);
	}
	fireEvent.click(button);
}

function tree(
	services: ListeningService[],
	options: {
		activePort?: number | null;
		onOpenPreview?: (port: number) => void;
	} = {},
) {
	return (
		<QueryClientProvider client={client}>
			<ToastProvider>
				<ListeningContext.Provider value={{ services, loaded: true }}>
					<RunningPane
						workspaceId={WORKSPACE}
						activePort={options.activePort ?? null}
						onOpenPreview={options.onOpenPreview ?? (() => {})}
					/>
				</ListeningContext.Provider>
			</ToastProvider>
		</QueryClientProvider>
	);
}

function show(
	services: ListeningService[],
	options: {
		activePort?: number | null;
		onOpenPreview?: (port: number) => void;
	} = {},
) {
	return render(tree(services, options));
}

beforeEach(() => {
	localStorage.clear();
	sessionStorage.clear();
	client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			unobserve() {}
			disconnect() {}
		},
	);
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async () =>
				new Response(JSON.stringify(USAGE), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		),
	);
});

afterEach(() => {
	cleanup();
	client.clear();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
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
	const tags = screen
		.getByTestId("running-row-3000")
		.querySelector(".pk-portrow-select");
	expect(tags?.textContent).not.toContain("Preview");
	expect(screen.getByTestId("running-row-8080").textContent).toContain("Docker");
});

test("a previewable port offers a visible Preview button, then a new tab and stop icons", () => {
	show([service({ port: 3000 })]);
	const open = screen.getByTestId("running-open-3000");
	// The accessible name contains the visible word (WCAG 2.5.3).
	expect(open.getAttribute("aria-label")).toBe("Preview port 3000");
	expect(open.textContent).toBe("Preview");
	expect(screen.getByRole("button", { name: "Preview port 3000" })).toBe(open);
	const tab = screen.getByTestId("running-new-tab-3000");
	expect(tab.getAttribute("aria-label")).toBe("Open port 3000 in a new tab");
	expect(tab.querySelector("[data-icon=external]")).toBeTruthy();
	const stop = screen.getByTestId("running-stop-3000");
	expect(stop.getAttribute("aria-label")).toBe("Stop port 3000");
	expect(stop.className).toContain("pk-running-stop");
	expect(stop.querySelector("[data-icon=stop]")).toBeTruthy();
	expect(screen.queryByText("Open preview")).toBeNull();
	expect(screen.queryByText("Stop")).toBeNull();
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
	const stop = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
		const url = String(input);
		const body = url.includes("/usage") ? USAGE : {};
		return new Response(JSON.stringify(body), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	});
	show([service({ port: 5173 })]);
	fireEvent.click(screen.getByTestId("running-stop-5173"));
	expect(screen.getByTestId("dialog-stop-listener").textContent).toContain(
		"Stop node on port 5173?",
	);
	fireEvent.click(screen.getByTestId("dialog-confirm"));
	await waitFor(() =>
		expect(
			stop.mock.calls.some((call) =>
				String(call[0]).includes(`/workspaces/${WORKSPACE}/listening/5173/stop`),
			),
		).toBe(true),
	);
});

test("the row of the Preview tab in view is marked current", () => {
	show([service({ port: 3000 }), service({ port: 5173 })], { activePort: 5173 });
	expect(screen.getByTestId("running-row-5173").className).toContain("is-current");
	expect(screen.getByTestId("running-row-3000").className).not.toContain("is-current");
	// Screen readers hear it too (issue #369).
	expect(
		screen.getByRole("button", { name: /^5173/ }).getAttribute("aria-current"),
	).toBe("true");
	expect(
		screen.getByRole("button", { name: /^3000/ }).getAttribute("aria-current"),
	).toBeNull();
});

test("the command cell carries the full command as a tooltip", () => {
	show([service({ port: 3000, process: { command: "node" } })]);
	expect(
		screen.getByTestId("running-row-3000").querySelector("[title='node']"),
	).toBeTruthy();
});

test("a port that is not listening is not listed", () => {
	show([service({ port: 3000 })]);
	expect(screen.queryByTestId("running-stale-5173")).toBeNull();
	expect(screen.queryByText("not running")).toBeNull();
});

test("clicking a row shows the port, addresses, pid, command and command line", () => {
	show([
		service({
			port: 3000,
			addresses: ["127.0.0.1", "0.0.0.0"],
			process: {
				pid: 7,
				command: "MainThread",
				commandLine: "python server.py",
			},
		}),
	]);
	expect(screen.queryByTestId("running-details")).toBeNull();
	selectRow(3000);
	const details = screen.getByTestId("running-details");
	expect(details.textContent).toContain("3000");
	expect(details.textContent).toContain("127.0.0.1, 0.0.0.0");
	expect(details.textContent).toContain("7");
	expect(details.textContent).toContain("MainThread");
	expect(details.textContent).toContain("python server.py");
	expect(screen.getByTestId("running-row-3000").className).toContain("is-selected");
});

test("a process with no command line says it is unknown", () => {
	show([service({ port: 3000 })]);
	selectRow(3000);
	expect(screen.getByTestId("running-details").textContent).toContain("Command line");
	expect(screen.getByTestId("running-details").textContent).toContain("unknown");
});

test("selecting another row replaces the details", () => {
	show([
		service({
			port: 3000,
			process: { pid: 1, command: "node", commandLine: "node one" },
		}),
		service({
			port: 5173,
			process: { pid: 2, command: "node", commandLine: "node two" },
		}),
	]);
	selectRow(3000);
	expect(screen.getByTestId("running-details").textContent).toContain("node one");
	selectRow(5173);
	const details = screen.getByTestId("running-details");
	expect(details.textContent).toContain("node two");
	expect(details.textContent).not.toContain("node one");
	expect(screen.getByTestId("running-row-5173").className).toContain("is-selected");
	expect(screen.getByTestId("running-row-3000").className).not.toContain("is-selected");
});

test("the panel closes when the selected port disappears", () => {
	const view = show([service({ port: 3000 }), service({ port: 5173 })]);
	selectRow(3000);
	expect(screen.getByTestId("running-details")).toBeTruthy();
	view.rerender(tree([service({ port: 5173 })]));
	expect(screen.queryByTestId("running-row-3000")).toBeNull();
	expect(screen.queryByTestId("running-details")).toBeNull();
});

test("a selected row shows CPU and memory, and the details divider can be focused", async () => {
	show([service({ port: 3000 })]);
	expect(vi.mocked(fetch).mock.calls.length).toBe(0);
	selectRow(3000);
	await waitFor(() =>
		expect(screen.getByTestId("running-cpu").textContent).toBe("1.0%"),
	);
	expect(screen.getByTestId("running-memory").textContent).toBe("4.0 KB");
	const handle = screen.getByRole("separator", { name: "Resize details" });
	expect(handle.getAttribute("tabindex")).toBe("0");
	expect(handle.className).toContain("pk-handle");
});

test("a selected process that has exited says so", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async () =>
				new Response(JSON.stringify({ ...USAGE, processes: [] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		),
	);
	show([service({ port: 3000 })]);
	selectRow(3000);
	await waitFor(() =>
		expect(screen.getByTestId("running-process-gone").textContent).toBe(
			"This process is no longer running.",
		),
	);
});

test("usage polling stops when the row is no longer selected", async () => {
	vi.useFakeTimers();
	try {
		const calls = vi.fn(
			async () =>
				new Response(JSON.stringify(USAGE), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		vi.stubGlobal("fetch", calls);
		const view = show([service({ port: 3000 })]);
		await act(async () => {});
		expect(calls).not.toHaveBeenCalled();
		selectRow(3000);
		await act(async () => {});
		expect(calls.mock.calls.length).toBeGreaterThan(0);
		const selected = calls.mock.calls.length;
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1000);
		});
		expect(calls.mock.calls.length).toBeGreaterThan(selected);
		const whileSelected = calls.mock.calls.length;
		view.rerender(tree([]));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(3000);
		});
		expect(calls.mock.calls.length).toBe(whileSelected);
	} finally {
		vi.useRealTimers();
	}
});

test("Docker and reserved-port tags sit on a second line under the name", () => {
	show([
		service({
			port: 8080,
			process: { command: "postgres" },
			container: { id: "abc", name: "postgres" },
		}),
	]);
	const row = screen.getByTestId("running-row-8080");
	const tags = row.querySelector(".pk-portrow-main .pk-portrow-tags");
	expect(tags?.textContent).toContain("Docker");
	expect(row.querySelector(".pk-portrow-name")?.textContent).toBe("postgres");
});
