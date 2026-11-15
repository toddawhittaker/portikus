/**
 * The check history list (SPEC.md §18.1, §25): the kept runs of one check,
 * newest first, with when each ran, how long it took, how it ended, and its
 * output on request.
 */
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { renderWithQuery } from "../test-utils.js";
import { CheckHistory } from "./CheckHistory.js";

const WORKSPACE = "22222222-2222-4222-8222-222222222222";
const PROJECT = "44444444-4444-4444-8444-444444444444";
const RUN_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RUN_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function stub(history: unknown, output: Record<string, unknown> = {}) {
	const calls: string[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			calls.push(url);
			const match = /history\/([^/]+)\/output$/.exec(url);
			if (match) {
				const body = output[match[1] ?? ""];
				return body
					? json(body)
					: json({ code: "NOT_FOUND", message: "That run is no longer kept." }, 404);
			}
			return json(history);
		}),
	);
	return calls;
}

afterEach(() => {
	cleanup();
	vi.unstubAllGlobals();
});

function render() {
	renderWithQuery(
		<CheckHistory
			workspaceId={WORKSPACE}
			projectId={PROJECT}
			checkId="tests"
			name="Tests"
		/>,
	);
}

test("each kept run shows how it ended, how long it took and its exit code", async () => {
	const calls = stub({
		runs: [
			{
				id: RUN_A,
				checkId: "tests",
				state: "failed",
				startedAt: "2026-11-14T10:05:00.000Z",
				endedAt: "2026-11-14T10:05:02.400Z",
				durationMs: 2400,
				exitCode: 1,
			},
			{
				id: RUN_B,
				checkId: "tests",
				state: "passed",
				startedAt: "2026-11-14T10:00:00.000Z",
				endedAt: "2026-11-14T10:00:00.850Z",
				durationMs: 850,
				exitCode: 0,
			},
		],
	});
	render();
	await waitFor(() =>
		expect(screen.getAllByTestId("check-history-item")).toHaveLength(2),
	);
	const [first, second] = screen.getAllByTestId("check-history-item");
	expect(first?.textContent).toContain("Failed");
	expect(first?.textContent).toContain("2.4 s, exit code 1");
	expect(second?.textContent).toContain("Passed");
	expect(second?.textContent).toContain("850 ms, exit code 0");
	expect(first?.querySelector("time")?.getAttribute("dateTime")).toBe(
		"2026-11-14T10:05:00.000Z",
	);
	expect(calls[0]).toBe(
		`/workspaces/${WORKSPACE}/projects/${PROJECT}/checks/tests/history`,
	);
});

test("output is fetched only when asked for, and shown as plain text", async () => {
	const calls = stub(
		{
			runs: [
				{
					id: RUN_A,
					checkId: "tests",
					state: "passed",
					startedAt: "2026-11-14T10:05:00.000Z",
					endedAt: "2026-11-14T10:05:01.000Z",
					durationMs: 1000,
					exitCode: 0,
				},
			],
		},
		{ [RUN_A]: { output: btoa("\x1b[32mall passed\x1b[0m\r\n") } },
	);
	render();
	const toggle = await screen.findByRole("button", { name: /Show output/ });
	expect(calls.some((url) => url.endsWith("/output"))).toBe(false);
	expect(toggle.getAttribute("aria-expanded")).toBe("false");
	fireEvent.click(toggle);
	const output = await screen.findByTestId("check-history-output");
	expect(output.textContent).toBe("all passed\n");
	expect(toggle.getAttribute("aria-expanded")).toBe("true");
	expect(toggle.textContent).toContain("Hide output");
});

test("a run whose output is gone says so", async () => {
	stub({
		runs: [
			{
				id: RUN_B,
				checkId: "tests",
				state: "error",
				startedAt: "2026-11-14T10:05:00.000Z",
				endedAt: "2026-11-14T10:05:00.000Z",
				durationMs: 0,
				exitCode: null,
			},
		],
	});
	render();
	const item = await screen.findByTestId("check-history-item");
	expect(item.textContent).toContain("Could not run");
	expect(item.textContent).not.toContain("exit code");
	fireEvent.click(screen.getByRole("button", { name: /Show output/ }));
	await screen.findByText("The output of this run is no longer kept.");
});

test("a check with no kept runs says so, and a failed load is reported", async () => {
	stub({ runs: [] });
	render();
	await screen.findByText("No finished runs yet.");
	cleanup();
	vi.unstubAllGlobals();
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => json({ code: "INTERNAL", message: "no" }, 500)),
	);
	render();
	await screen.findByTestId("check-history-error");
});

const FINISHED_RUN = {
	id: RUN_A,
	checkId: "tests",
	state: "passed",
	startedAt: "2026-11-14T10:05:00.000Z",
	endedAt: "2026-11-14T10:05:01.000Z",
	durationMs: 1000,
	exitCode: 0,
};

test("opened output can take focus and is named by the time of its run (SPEC.md §25.8)", async () => {
	stub({ runs: [FINISHED_RUN] }, { [RUN_A]: { output: btoa("all passed\n") } });
	render();
	fireEvent.click(await screen.findByRole("button", { name: /Show output/ }));
	const output = await screen.findByTestId("check-history-output");
	const when = screen.getByText((_, el) => el?.tagName === "TIME").textContent;
	expect(output.getAttribute("tabindex")).toBe("0");
	expect(output.getAttribute("aria-label")).toBe(`Output of the run at ${when}`);
	expect(screen.getByRole("group", { name: `Output of the run at ${when}` })).toBe(
		output,
	);
});

test("the loading and no-longer-kept messages are status messages (SPEC.md §25.8)", async () => {
	let release: () => void = () => {};
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	vi.stubGlobal(
		"fetch",
		vi.fn(async (input: RequestInfo | URL) => {
			if (String(input).endsWith("/output")) {
				await gate;
				return json({ code: "NOT_FOUND", message: "gone" }, 404);
			}
			return json({ runs: [FINISHED_RUN] });
		}),
	);
	render();
	fireEvent.click(await screen.findByRole("button", { name: /Show output/ }));
	expect((await screen.findByText("Loading…")).getAttribute("role")).toBe("status");
	release();
	const gone = await screen.findByText("The output of this run is no longer kept.");
	expect(gone.getAttribute("role")).toBe("status");
});

test("loaded output is not a live region", async () => {
	stub({ runs: [FINISHED_RUN] }, { [RUN_A]: { output: btoa("all passed\n") } });
	render();
	fireEvent.click(await screen.findByRole("button", { name: /Show output/ }));
	const output = await screen.findByTestId("check-history-output");
	expect(output.closest('[role="status"], [aria-live]')).toBeNull();
});
