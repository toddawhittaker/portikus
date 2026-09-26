import type { AdminProcessSnapshot, InstanceProcess } from "@portikus/contracts";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ApiError } from "../api/request.js";
import { json, stubFetch } from "../test-utils.js";
import {
	adminStopErrorText,
	ownerText,
	POLL_LIMIT_MS,
	ProcessesSection,
	snapshotAnswers,
	sortProcesses,
	TIMEOUT_TEXT,
} from "./ProcessesSection.js";

const WS = "11111111-1111-4111-8111-111111111111";
const REQUESTED = "2026-09-26T10:00:00.000Z";

function proc(overrides: Partial<InstanceProcess>): InstanceProcess {
	return {
		pid: 100,
		uid: 1000,
		name: "node",
		startTicks: 5,
		cpuPercent: 0,
		residentBytes: 0,
		protected: false,
		...overrides,
	};
}

const MINER = proc({
	pid: 200,
	name: "<b>miner</b>",
	cpuPercent: 90,
	residentBytes: 10,
});
const HOG = proc({
	pid: 300,
	name: "hog",
	cpuPercent: 5,
	residentBytes: 2_000_000_000,
});
const AGENT = proc({ pid: 50, uid: 0, name: "portikus-agent", protected: true });

function snapshot(overrides: Partial<AdminProcessSnapshot>): AdminProcessSnapshot {
	return {
		requestedAt: REQUESTED,
		takenAt: "2026-09-26T10:00:01.500Z",
		processes: [HOG, MINER, AGENT],
		error: null,
		...overrides,
	};
}

beforeEach(() => vi.useFakeTimers({ shouldAdvanceTime: true }));
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

/** Refresh answers REQUESTED; each GET answers the next snapshot in the list. */
function stubServer(snapshots: AdminProcessSnapshot[], stop?: () => Response) {
	let reads = 0;
	return stubFetch((url, init) => {
		if (url.endsWith("/processes/refresh"))
			return json(202, { requestedAt: REQUESTED });
		if (url.endsWith("/processes") && !init?.method) {
			const next = snapshots[Math.min(reads, snapshots.length - 1)];
			reads += 1;
			return json(200, next);
		}
		if (url.includes("/stop") && stop) return stop();
		throw new Error(`unexpected ${init?.method ?? "GET"} ${url}`);
	});
}

async function tick(ms = 1000) {
	await act(async () => {
		await vi.advanceTimersByTimeAsync(ms);
	});
}

function renderSection(running = true) {
	render(<ProcessesSection workspaceId={WS} running={running} ownerName="Ada" />);
}

test("a snapshot counts only when taken at or after this browser's request", () => {
	expect(snapshotAnswers(snapshot({ takenAt: null }), REQUESTED)).toBe(false);
	expect(
		snapshotAnswers(snapshot({ takenAt: "2026-09-26T09:59:59.999Z" }), REQUESTED),
	).toBe(false);
	expect(snapshotAnswers(snapshot({ takenAt: REQUESTED }), REQUESTED)).toBe(true);
});

test("rows sort highest first by CPU or memory, and owners are student or system", () => {
	expect(sortProcesses([HOG, MINER, AGENT], "cpu").map((row) => row.pid)).toEqual([
		200, 300, 50,
	]);
	expect(sortProcesses([HOG, MINER, AGENT], "memory").map((row) => row.pid)).toEqual([
		300, 200, 50,
	]);
	expect(ownerText(1000)).toBe("student");
	expect(ownerText(0)).toBe("system");
});

test("stop refusals use Monitor's words", () => {
	expect(adminStopErrorText(new ApiError(404, "x", "PROCESS_NOT_FOUND"))).toBe(
		"That program has already stopped.",
	);
	expect(adminStopErrorText(new ApiError(409, "x", "PROCESS_PROTECTED"))).toBe(
		"Portikus needs this process, so it cannot be stopped here.",
	);
});

test("a stopped workspace shows no Refresh", () => {
	stubServer([]);
	renderSection(false);
	expect(screen.getByText("The workspace is not running.")).toBeTruthy();
	expect(screen.queryByTestId("processes-refresh")).toBeNull();
});

test("Refresh polls past an old snapshot, then shows the table sorted by CPU with names as text", async () => {
	const fetchMock = stubServer([
		snapshot({ takenAt: "2026-09-26T09:00:00.000Z" }),
		snapshot({}),
	]);
	renderSection();
	expect(screen.getByText("Press Refresh to read the processes.")).toBeTruthy();
	fireEvent.click(screen.getByTestId("processes-refresh"));
	await tick();
	expect(screen.queryByTestId("processes-table")).toBeNull();
	await tick();
	const table = screen.getByTestId("processes-table");
	const pids = within(table)
		.getAllByRole("row")
		.slice(1)
		.map((row) => row.getAttribute("data-testid"));
	expect(pids).toEqual(["process-row-200", "process-row-300", "process-row-50"]);
	// A hostile name is text, not markup.
	expect(within(table).getByText("<b>miner</b>")).toBeTruthy();
	expect(table.querySelector("b")).toBeNull();
	// The protected agent row has no Stop button.
	expect(screen.queryByTestId("processes-stop-50")).toBeNull();
	expect(screen.getByTestId("processes-stop-200")).toBeTruthy();
	fireEvent.click(screen.getByRole("button", { name: "Memory" }));
	expect(
		within(screen.getByTestId("processes-table"))
			.getAllByRole("row")[1]
			?.getAttribute("data-testid"),
	).toBe("process-row-300");
	// Polling has ended: no more reads.
	const calls = fetchMock.mock.calls.length;
	await tick(5000);
	expect(fetchMock.mock.calls.length).toBe(calls);
});

test("polling gives up after its limit with a clear message", async () => {
	stubServer([snapshot({ takenAt: null })]);
	renderSection();
	fireEvent.click(screen.getByTestId("processes-refresh"));
	await tick(POLL_LIMIT_MS + 2000);
	expect(screen.getByTestId("processes-error").textContent).toBe(TIMEOUT_TEXT);
});

test("an error code in the snapshot is shown", async () => {
	stubServer([snapshot({ error: "WORKSPACE_NOT_RUNNING", processes: [] })]);
	renderSection();
	fireEvent.click(screen.getByTestId("processes-refresh"));
	await tick();
	expect(screen.getByTestId("processes-error").textContent).toBe(
		"The workspace is not running.",
	);
});

test("Stop offers Force stop when the process stays, then removes the row", async () => {
	const bodies: unknown[] = [];
	let answer = { pid: 200, exited: false };
	const fetchMock = stubServer([snapshot({})], () => json(200, answer));
	renderSection();
	fireEvent.click(screen.getByTestId("processes-refresh"));
	await tick();
	fireEvent.click(screen.getByTestId("processes-stop-200"));
	const dialog = screen.getByRole("alertdialog");
	expect(dialog.textContent).toContain(
		"The student is told that an administrator stopped a process.",
	);
	fireEvent.click(within(dialog).getByRole("button", { name: "Stop" }));
	await tick(0);
	expect(screen.getByTestId("admin-stop-status").textContent).toBe(
		"<b>miner</b> is still running.",
	);
	answer = { pid: 200, exited: true };
	fireEvent.click(
		within(screen.getByRole("alertdialog")).getByRole("button", { name: "Force stop" }),
	);
	await tick(0);
	for (const [url, init] of fetchMock.mock.calls) {
		if (String(url).includes("/stop")) bodies.push(JSON.parse(String(init?.body)));
	}
	expect(bodies).toEqual([
		{ startTicks: 5, force: false },
		{ startTicks: 5, force: true },
	]);
	expect(screen.queryByRole("alertdialog")).toBeNull();
	expect(screen.queryByTestId("process-row-200")).toBeNull();
	expect(screen.getByTestId("processes-announce").textContent).toBe(
		"<b>miner</b> (PID 200) stopped.",
	);
	expect(document.activeElement?.id).toBe("detail-processes");
});

test("a refusal shows in the dialog", async () => {
	stubServer([snapshot({})], () =>
		json(409, { code: "PROCESS_CHANGED", message: "changed" }),
	);
	renderSection();
	fireEvent.click(screen.getByTestId("processes-refresh"));
	await tick();
	fireEvent.click(screen.getByTestId("processes-stop-300"));
	fireEvent.click(
		within(screen.getByRole("alertdialog")).getByRole("button", { name: "Stop" }),
	);
	await tick(0);
	expect(screen.getByTestId("admin-stop-status").textContent).toBe(
		"That process ID now belongs to a different program. Refresh and try again.",
	);
});
