/**
 * The Monitor tab (SPEC.md §18.3): the figures, the process list, and a
 * refresh that runs only while the tab is shown.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { MonitorPane } from "./MonitorPane.js";

const WORKSPACE = "22222222-2222-4222-8222-222222222222";

const USAGE = {
	observedAt: "2026-01-01T00:00:00.000Z",
	cpuPercent: 12.5,
	memory: { usedBytes: 512 * 1024, totalBytes: 1024 * 1024 },
	disk: { usedBytes: 2 * 1024 * 1024, totalBytes: 4 * 1024 * 1024 },
	network: { receiveBytesPerSecond: 2048, transmitBytesPerSecond: null },
	processes: [
		{ pid: 7, cpuPercent: 10, residentBytes: 4096, command: "node" },
		{ pid: 9, cpuPercent: 1, residentBytes: 1024, command: "python" },
	],
	storage: { home: null, docker: null, recovery: null },
};

function json(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function renderPane() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<MonitorPane workspaceId={WORKSPACE} />
		</QueryClientProvider>,
	);
}

afterEach(() => {
	cleanup();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

test("shows CPU, memory, disk, network rates and the process list", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => json(USAGE)),
	);
	renderPane();
	await waitFor(() =>
		expect(screen.getByTestId("monitor-cpu").textContent).toBe("12.5%"),
	);
	expect(screen.getByTestId("monitor-memory").textContent).toBe("512 KB / 1.0 MB");
	expect(screen.getByTestId("monitor-disk").textContent).toBe("2.0 MB / 4.0 MB");
	expect(screen.getByTestId("monitor-receive").textContent).toBe("2.0 KB/s");
	expect(screen.getByTestId("monitor-transmit").textContent).toBe("—");
	const rows = screen.getAllByTestId(/monitor-process-/);
	expect(rows[0]?.textContent).toContain("node");
	expect(rows[1]?.textContent).toContain("python");
	expect(screen.queryByRole("button", { name: /kill|stop/i })).toBeNull();
	expect(screen.getByTestId("monitor").textContent).not.toContain("btop");
});

test("clicking a column sorts it, and clicking again reverses it", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () =>
			json({
				...USAGE,
				processes: [
					{ pid: 10, cpuPercent: 50, residentBytes: 100, command: "node10" },
					{ pid: 2, cpuPercent: 1, residentBytes: 5000, command: "node2" },
				],
			}),
		),
	);
	renderPane();
	await waitFor(() => expect(screen.getByTestId("monitor-process-2")).toBeTruthy());
	const pids = () =>
		screen
			.getAllByTestId(/monitor-process-/)
			.map((row) => row.getAttribute("data-testid"));

	// Default is CPU descending, so the busier process is first.
	expect(pids()).toEqual(["monitor-process-10", "monitor-process-2"]);

	fireEvent.click(screen.getByRole("button", { name: "PID" }));
	expect(pids()).toEqual(["monitor-process-2", "monitor-process-10"]);
	fireEvent.click(screen.getByRole("button", { name: "PID" }));
	expect(pids()).toEqual(["monitor-process-10", "monitor-process-2"]);
});

test("refreshes once a second while shown and stops when it goes away", async () => {
	vi.useFakeTimers();
	const calls = vi.fn(async () => json(USAGE));
	vi.stubGlobal("fetch", calls);
	const view = renderPane();
	await act(async () => {});
	expect(calls.mock.calls.length).toBeGreaterThan(0);
	const first = calls.mock.calls.length;
	await act(async () => {
		await vi.advanceTimersByTimeAsync(1000);
	});
	expect(calls.mock.calls.length).toBeGreaterThan(first);
	const shown = calls.mock.calls.length;
	view.unmount();
	await act(async () => {
		await vi.advanceTimersByTimeAsync(5000);
	});
	expect(calls.mock.calls.length).toBe(shown);
});

test("the Monitor heading is for screen readers only; the tab names the pane", () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => json(USAGE)),
	);
	renderPane();
	const heading = screen.getByRole("heading", { level: 2, name: "Monitor" });
	expect(heading.className).toBe("sr-only");
});
