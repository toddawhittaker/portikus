import type { HealthSeries } from "@portikus/contracts";
import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { ApiCharts } from "./ApiCharts.js";
import type { ChartFrame } from "./charts/scales.js";

const FROM = Date.parse("2026-09-26T06:00:00.000Z");
// 6h range: five-minute buckets.
const FRAME: ChartFrame = { range: "6h", from: FROM, bucketSeconds: 300, count: 72 };

function series(api: HealthSeries["api"]): HealthSeries {
	return {
		range: "6h",
		bucketSeconds: 300,
		from: new Date(FROM).toISOString(),
		to: new Date(FROM + 6 * 3_600_000).toISOString(),
		cpuCount: 4,
		host: [],
		platform: [],
		events: [],
		usage: { retentionMinutes: 0, from: new Date(FROM).toISOString(), workspaces: [] },
		api,
	};
}

const at = (bucket: number) => new Date(FROM + bucket * 300_000).toISOString();

test("the three charts average the rate per minute and show error shares and percentiles", () => {
	render(
		<ApiCharts
			frame={FRAME}
			series={series([
				{
					at: at(0),
					requests: 100,
					clientErrors: 10,
					serverErrors: 0,
					webSocketUpgrades: 2,
					medianMs: 20,
					p95Ms: 400,
				},
				{
					at: at(1),
					requests: 50,
					clientErrors: 1,
					serverErrors: 2,
					webSocketUpgrades: 1,
					medianMs: 12.4,
					p95Ms: 90,
				},
			])}
		/>,
	);
	expect(
		screen.getByRole("img", {
			name: "API requests: Now 10/min, highest 20/min. 3 WebSocket upgrades in this range.",
		}),
	).toBeTruthy();
	expect(
		screen.getByRole("img", {
			name: "API error rate: 4xx: Now 2%, highest 10%. 5xx: Now 4%, highest 4%.",
		}),
	).toBeTruthy();
	expect(
		screen.getByRole("img", {
			name: "API response time: Median: Now 12 ms, highest 20 ms. 95th percentile: Now 90 ms, highest 400 ms.",
		}),
	).toBeTruthy();
});

test("with no requests the charts say so", () => {
	render(<ApiCharts frame={FRAME} series={series([])} />);
	expect(
		screen.getByRole("img", {
			name: "API requests: No samples in this range. 0 WebSocket upgrades in this range.",
		}),
	).toBeTruthy();
	expect(
		screen.getByRole("img", { name: "API error rate: No requests in this range." }),
	).toBeTruthy();
	expect(
		screen.getByRole("img", { name: "API response time: No requests in this range." }),
	).toBeTruthy();
});

test("a bucket with only WebSocket upgrades has a rate of zero and no error share", () => {
	render(
		<ApiCharts
			frame={FRAME}
			series={series([
				{
					at: at(0),
					requests: 0,
					clientErrors: 0,
					serverErrors: 0,
					webSocketUpgrades: 1,
					medianMs: null,
					p95Ms: null,
				},
			])}
		/>,
	);
	expect(
		screen.getByRole("img", {
			name: "API requests: Now 0/min, highest 0/min. 1 WebSocket upgrade in this range.",
		}),
	).toBeTruthy();
	expect(
		screen.getByRole("img", { name: "API error rate: No requests in this range." }),
	).toBeTruthy();
});
