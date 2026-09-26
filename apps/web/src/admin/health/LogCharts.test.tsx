import type { LogCounts } from "@portikus/contracts";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderApp, stubFetch, USER } from "../../test-utils.js";
import { frameOf } from "./charts/scales.js";
import { countSummary, countValues } from "./LogCharts.js";

afterEach(() => {
	vi.unstubAllGlobals();
	localStorage.clear();
});

const FROM = "2026-09-26T09:00:00.000Z";

function counts(overrides: Partial<LogCounts> = {}): LogCounts {
	return {
		bucketSeconds: 60,
		from: FROM,
		to: "2026-09-26T10:00:00.000Z",
		buckets: [
			{ at: "2026-09-26T09:30:00.000Z", errors: 2, warnings: 1 },
			{ at: "2026-09-26T09:59:00.000Z", errors: 0, warnings: 3 },
		],
		complete: true,
		oldestAt: "2026-09-26T09:10:30.000Z",
		...overrides,
	};
}

test("buckets before the journal's oldest line are gaps, later empty ones are zero", () => {
	const body = counts();
	const frame = frameOf({ ...body, range: "1h" });
	const { errors, warnings } = countValues(frame, body);
	expect(errors).toHaveLength(60);
	expect(errors[9]).toBeNull();
	expect(errors[10]).toBe(0);
	expect(errors[30]).toBe(2);
	expect(warnings[59]).toBe(3);
	expect(countSummary(errors, warnings, "1h", true)).toBe(
		"2 errors and 4 warnings in the last 1 hour.",
	);
	expect(countSummary([1], [null], "1d", false)).toBe(
		"1 error and 0 warnings in the last 1 day. Still counting older lines.",
	);
	// No journal at all: nothing is known.
	expect(
		countValues(frame, counts({ oldestAt: null, buckets: [] })).errors[59],
	).toBeNull();
});

const REPORT = {
	sampledAt: "2026-09-26T09:59:30.000Z",
	workerStale: false,
	controller: { reachable: true, errorCode: null },
	host: null,
	workspacesByState: {},
	agents: { answering: 0, running: 0 },
	last24h: {
		startFailures: 0,
		stopFailures: 0,
		forcedStops: 0,
		provisionFailures: 0,
		controllerOutages: 0,
		signInFailures: 0,
		previewRefusals: 0,
	},
	guard: [],
};

function stubHealth(body: LogCounts | Response) {
	stubFetch((url) => {
		if (url === "/auth/me") return json(200, { ...USER, role: "administrator" });
		if (url.startsWith("/admin/logs/counts")) {
			return body instanceof Response ? body : json(200, body);
		}
		if (url.startsWith("/admin/logs?")) {
			return json(200, {
				lines: [],
				nextCursor: null,
				scanComplete: true,
				skippedLines: 0,
			});
		}
		if (url === "/admin/health") return json(200, REPORT);
		if (url.startsWith("/admin/health/series")) {
			return json(200, {
				range: "1h",
				bucketSeconds: 60,
				from: FROM,
				to: "2026-09-26T10:00:00.000Z",
				cpuCount: 4,
				host: [],
				platform: [],
				events: [],
				usage: { retentionMinutes: 0, from: FROM, workspaces: [] },
				api: [],
			});
		}
		return json(200, {});
	});
}

test("Enter on a bar opens the Logs tab for that bucket and the picked level", async () => {
	localStorage.setItem("portikus.admin.healthRange", "1h");
	stubHealth(counts());
	const { router } = renderApp("/admin?tab=health");

	const plot = await screen.findByTestId("health-chart-logs-plot");
	expect(screen.getByTestId("health-chart-logs-summary").textContent).toBe(
		"2 errors and 4 warnings in the last 1 hour.",
	);
	fireEvent.keyDown(plot, { key: "End" });
	fireEvent.keyDown(plot, { key: "ArrowUp" });
	fireEvent.keyDown(plot, { key: "Enter" });

	await waitFor(() =>
		expect(router.state.location.search).toEqual({
			tab: "logs",
			level: "warn",
			since: "2026-09-26T09:59:00.000Z",
			until: "2026-09-26T10:00:00.000Z",
		}),
	);
});

test("an unavailable journal is said in the chart's place", async () => {
	stubHealth(json(503, { code: "LOGS_UNAVAILABLE", message: "No journal here." }));
	renderApp("/admin?tab=health");
	expect(await screen.findByText("No journal here.")).toBeDefined();
});
