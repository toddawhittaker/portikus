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
	within,
} from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { RightPaneContext } from "../shell/rightPane.js";
import { openToggletip } from "../test-utils.js";
import { MonitorPane } from "./MonitorPane.js";

const WORKSPACE = "22222222-2222-4222-8222-222222222222";

const USAGE = {
	observedAt: "2026-01-01T00:00:00.000Z",
	cpuPercent: 12.5,
	memory: { usedBytes: 512 * 1024, totalBytes: 1024 * 1024 },
	disk: { usedBytes: 2 * 1024 * 1024, totalBytes: 4 * 1024 * 1024 },
	network: { receiveBytesPerSecond: 2048, transmitBytesPerSecond: null },
	processes: [
		{
			pid: 7,
			cpuPercent: 10,
			residentBytes: 4096,
			command: "node",
			startTicks: 100,
			stoppable: true,
			commandLine: null,
		},
		{
			pid: 9,
			cpuPercent: 1,
			residentBytes: 1024,
			command: "python",
			startTicks: 100,
			stoppable: true,
			commandLine: null,
		},
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
	expect(screen.getByTestId("monitor").textContent).not.toContain("btop");
});

test("clicking a column sorts it, and clicking again reverses it", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () =>
			json({
				...USAGE,
				processes: [
					{
						pid: 10,
						cpuPercent: 50,
						residentBytes: 100,
						command: "node10",
						startTicks: 100,
						stoppable: true,
						commandLine: null,
					},
					{
						pid: 2,
						cpuPercent: 1,
						residentBytes: 5000,
						command: "node2",
						startTicks: 100,
						stoppable: true,
						commandLine: null,
					},
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

	const spoken = screen.getByTestId("monitor-sort-announce");
	expect(spoken.textContent).toBe("");

	fireEvent.click(screen.getByRole("button", { name: "PID" }));
	expect(pids()).toEqual(["monitor-process-2", "monitor-process-10"]);
	expect(spoken.textContent).toBe("Sorted by PID, ascending");
	fireEvent.click(screen.getByRole("button", { name: "PID" }));
	expect(pids()).toEqual(["monitor-process-10", "monitor-process-2"]);
	expect(spoken.textContent).toBe("Sorted by PID, descending");

	// Memory, like CPU, starts with the biggest.
	fireEvent.click(screen.getByRole("button", { name: "Memory" }));
	expect(pids()).toEqual(["monitor-process-2", "monitor-process-10"]);
	expect(spoken.textContent).toBe("Sorted by Memory, descending");
	expect(
		screen.getByRole("columnheader", { name: "Memory" }).getAttribute("aria-sort"),
	).toBe("descending");
	expect(
		screen.getByRole("columnheader", { name: "PID" }).hasAttribute("aria-sort"),
	).toBe(false);
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
	// In a pane head like the other surfaces, so their bodies start level.
	expect(heading.parentElement?.className).toContain("pk-pane-head");
});

const OWN = {
	pid: 7,
	cpuPercent: 10,
	residentBytes: 4096,
	command: "node",
	startTicks: 123,
	stoppable: true,
	commandLine: "node server.js --port 3000",
};
const SYSTEM = {
	pid: 1,
	cpuPercent: 0,
	residentBytes: 1024,
	command: "systemd",
	startTicks: 1,
	stoppable: false,
	commandLine: null,
};

function errorBody(status: number, code: string): Response {
	return new Response(JSON.stringify({ code, message: code }), {
		status,
		headers: { "content-type": "application/json" },
	});
}

/** Usage answers with `processes`; a stop answers with the next queued response. */
function stubStops(processes: unknown[], stops: Response[]) {
	const calls: { url: string; body: unknown }[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			if (url.endsWith("/stop")) {
				calls.push({ url, body: JSON.parse(String(init?.body)) });
				return stops.shift() ?? json({ pid: 7, exited: true });
			}
			return json({ ...USAGE, processes });
		}),
	);
	return calls;
}

test("Stop is offered only on processes the student may stop", async () => {
	stubStops([OWN, SYSTEM], []);
	renderPane();
	await screen.findByRole("button", { name: "Stop node (PID 7)" });
	expect(screen.queryByRole("button", { name: /Stop systemd/ })).toBeNull();
	expect(
		screen
			.getByTestId("monitor-process-1")
			.querySelector("[title]")
			?.getAttribute("title"),
	).toBe("systemd");
});

test("every row has two fixed action cells: the command disclosure, then the danger-red Stop", async () => {
	const chevronOnly = { ...OWN, pid: 8, stoppable: false };
	const stopOnly = { ...OWN, pid: 9, commandLine: null };
	stubStops([OWN, SYSTEM, chevronOnly, stopOnly], []);
	renderPane();
	await screen.findByRole("button", { name: "Stop node (PID 7)" });
	const slots = (pid: number) =>
		Array.from(
			screen.getByTestId(`monitor-process-${pid}`).querySelectorAll(".pk-action-slot"),
		);
	for (const pid of [7, 1, 8, 9]) expect(slots(pid)).toHaveLength(2);
	expect(slots(7)[0]?.querySelector("[aria-expanded]")).not.toBeNull();
	expect(slots(7)[1]?.getAttribute("data-testid")).toBeNull();
	expect(slots(7)[1]?.querySelector("[data-testid='monitor-stop-7']")).not.toBeNull();
	// A missing button leaves its own cell empty rather than moving the other.
	expect(slots(8)[1]?.childElementCount).toBe(0);
	expect(slots(9)[0]?.childElementCount).toBe(0);
	expect(slots(9)[1]?.querySelector("[data-testid='monitor-stop-9']")).not.toBeNull();
	expect(slots(1).every((slot) => slot.childElementCount === 0)).toBe(true);
	expect(
		screen.getByTestId("monitor-stop-7").classList.contains("pk-iconbtn-danger"),
	).toBe(true);
});

test("stopping sends the start ticks, hides the row, announces it and moves focus to the heading", async () => {
	const calls = stubStops([OWN, SYSTEM], [json({ pid: 7, exited: true })]);
	renderPane();
	fireEvent.click(await screen.findByRole("button", { name: "Stop node (PID 7)" }));
	const dialog = screen.getByTestId("dialog-stop-process");
	expect(dialog.textContent).toContain("Stop node?");
	expect(dialog.textContent).toContain("PID 7");
	fireEvent.click(within(dialog).getByRole("button", { name: "Stop" }));

	await waitFor(() => expect(screen.queryByTestId("dialog-stop-process")).toBeNull());
	expect(calls[0]?.url).toBe(`/workspaces/${WORKSPACE}/processes/7/stop`);
	expect(calls[0]?.body).toEqual({ startTicks: 123, force: false });
	expect(screen.queryByTestId("monitor-process-7")).toBeNull();
	expect(screen.getByTestId("monitor-stop-announce").textContent).toBe(
		"node (PID 7) stopped.",
	);
	await waitFor(() =>
		expect(document.activeElement).toBe(
			screen.getByTestId("monitor-processes-heading"),
		),
	);
});

test("a process that outlives Stop keeps the dialog open and offers Force stop", async () => {
	const calls = stubStops(
		[OWN],
		[json({ pid: 7, exited: false }), json({ pid: 7, exited: true })],
	);
	renderPane();
	fireEvent.click(await screen.findByRole("button", { name: "Stop node (PID 7)" }));
	fireEvent.click(
		within(screen.getByTestId("dialog-stop-process")).getByRole("button", {
			name: "Stop",
		}),
	);

	const force = await screen.findByRole("button", { name: "Force stop" });
	expect(screen.getByTestId("stop-process-status").textContent).toBe(
		"node is still running.",
	);
	expect(screen.getByTestId("stop-process-status").getAttribute("role")).toBe("status");
	fireEvent.click(force);
	await waitFor(() => expect(screen.queryByTestId("dialog-stop-process")).toBeNull());
	expect(calls.map((call) => call.body)).toEqual([
		{ startTicks: 123, force: false },
		{ startTicks: 123, force: true },
	]);
});

test.each([
	[404, "PROCESS_NOT_FOUND", "That program has already stopped."],
	[
		409,
		"PROCESS_CHANGED",
		"That process ID now belongs to a different program. Refresh and try again.",
	],
	[
		403,
		"PROCESS_PROTECTED",
		"Portikus needs this process, so it cannot be stopped here.",
	],
	[
		500,
		"INTERNAL",
		"That program could not be stopped. Try again, or end it from a terminal.",
	],
])("a %i %s refusal shows in the dialog in plain words", async (status, code, text) => {
	stubStops([OWN], [errorBody(status, code)]);
	renderPane();
	fireEvent.click(await screen.findByRole("button", { name: "Stop node (PID 7)" }));
	fireEvent.click(
		within(screen.getByTestId("dialog-stop-process")).getByRole("button", {
			name: "Stop",
		}),
	);
	await waitFor(() =>
		expect(screen.getByTestId("stop-process-status").textContent).toBe(text),
	);
	expect(screen.getByTestId("dialog-stop-process")).toBeTruthy();
});

test("the disclosure reveals the student's own full command line", async () => {
	stubStops([OWN, SYSTEM], []);
	renderPane();
	const toggle = await screen.findByRole("button", {
		name: "Show the full command for PID 7",
	});
	expect(
		screen.queryByRole("button", { name: "Show the full command for PID 1" }),
	).toBeNull();
	expect(toggle.getAttribute("aria-expanded")).toBe("false");
	fireEvent.click(toggle);
	expect(toggle.getAttribute("aria-expanded")).toBe("true");
	expect(screen.getByTestId("monitor-command-7").textContent).toBe(
		"node server.js --port 3000",
	);
	expect(toggle.getAttribute("aria-controls")).toBe("monitor-command-7");
	fireEvent.click(toggle);
	expect(screen.queryByTestId("monitor-command-7")).toBeNull();
});

test("the sort comes from the right pane, so a notice can open Monitor sorted", async () => {
	stubStops(
		[
			{ ...OWN, pid: 3, cpuPercent: 90, residentBytes: 10 },
			{ ...OWN, pid: 4, cpuPercent: 1, residentBytes: 9000 },
		],
		[],
	);
	const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	render(
		<QueryClientProvider client={client}>
			<RightPaneContext.Provider
				value={{
					pane: "monitor",
					show: () => {},
					monitorSort: { column: "memory", direction: "descending" },
					setMonitorSort: () => {},
					monitorFocus: false,
					setMonitorFocus: () => {},
				}}
			>
				<MonitorPane workspaceId={WORKSPACE} />
			</RightPaneContext.Provider>
		</QueryClientProvider>,
	);
	await screen.findByTestId("monitor-process-4");
	expect(
		screen
			.getAllByTestId(/monitor-process-/)
			.map((row) => row.getAttribute("data-testid")),
	).toEqual(["monitor-process-4", "monitor-process-3"]);
	expect(
		screen.getByRole("columnheader", { name: "Memory" }).getAttribute("aria-sort"),
	).toBe("descending");
});

/** Usage answers with whatever `list.rows` holds when asked. */
function stubLive(rows: unknown[], stops: Response[] = []) {
	const list = { rows };
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			if (String(input).endsWith("/stop")) {
				return stops.shift() ?? json({ pid: 7, exited: true });
			}
			return json({ ...USAGE, processes: list.rows });
		}),
	);
	return list;
}

test("when a sample takes away the focused row, focus goes to the Processes heading", async () => {
	const list = stubLive([OWN, SYSTEM]);
	renderPane();
	const stop = await screen.findByRole("button", { name: "Stop node (PID 7)" });
	stop.focus();
	list.rows = [SYSTEM];
	await waitFor(() => expect(screen.queryByTestId("monitor-process-7")).toBeNull(), {
		timeout: 3000,
	});
	await waitFor(() =>
		expect(document.activeElement).toBe(
			screen.getByTestId("monitor-processes-heading"),
		),
	);
});

test("after 'already stopped' and Cancel, the row leaving moves focus to the heading", async () => {
	const list = stubLive([OWN, SYSTEM], [errorBody(404, "PROCESS_NOT_FOUND")]);
	renderPane();
	fireEvent.click(await screen.findByRole("button", { name: "Stop node (PID 7)" }));
	const dialog = screen.getByTestId("dialog-stop-process");
	fireEvent.click(within(dialog).getByRole("button", { name: "Stop" }));
	await waitFor(() =>
		expect(screen.getByTestId("stop-process-status").textContent).toBe(
			"That program has already stopped.",
		),
	);
	fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
	await waitFor(() => expect(screen.queryByTestId("dialog-stop-process")).toBeNull());
	list.rows = [SYSTEM];
	await waitFor(
		() =>
			expect(document.activeElement).toBe(
				screen.getByTestId("monitor-processes-heading"),
			),
		{ timeout: 3000 },
	);
});

test("the row order holds while focus is in the list, and sorts again when it leaves", async () => {
	const busy = { ...OWN, pid: 3, cpuPercent: 90 };
	const quiet = { ...OWN, pid: 4, cpuPercent: 1 };
	const list = stubLive([busy, quiet]);
	renderPane();
	const order = () =>
		screen
			.getAllByTestId(/monitor-process-\d/)
			.map((row) => row.getAttribute("data-testid"));
	(await screen.findByRole("button", { name: "Stop node (PID 4)" })).focus();
	expect(order()).toEqual(["monitor-process-3", "monitor-process-4"]);
	list.rows = [busy, { ...quiet, cpuPercent: 99 }];
	await waitFor(
		() => expect(screen.getByTestId("monitor-process-4").textContent).toContain("99"),
		{
			timeout: 3000,
		},
	);
	expect(order()).toEqual(["monitor-process-3", "monitor-process-4"]);
	act(() => screen.getByTestId("monitor-processes-heading").focus());
	await waitFor(() =>
		expect(order()).toEqual(["monitor-process-4", "monitor-process-3"]),
	);
});

test("Processes explains what Stop may end", async () => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => json(USAGE)),
	);
	renderPane();
	const tip = await screen.findByRole("button", { name: "About Processes" });
	// Beside the heading, not inside it, so the heading's name stays "Processes".
	expect(screen.getByRole("heading", { level: 3, name: "Processes" })).toBeTruthy();
	fireEvent.click(tip);
	expect(openToggletip().textContent).toContain("busiest first");
});
