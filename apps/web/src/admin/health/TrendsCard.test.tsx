import type { HealthSeries } from "@portikus/contracts";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderWithQuery, stubFetch } from "../../test-utils.js";
import { TrendsCard } from "./TrendsCard.js";

afterEach(() => {
	vi.unstubAllGlobals();
	localStorage.clear();
});

function series(
	range: HealthSeries["range"],
	bucketSeconds: number,
	span: number,
): HealthSeries {
	const to = Date.parse("2026-09-26T12:00:00.000Z");
	const from = to - span * 1000;
	const at = (back: number) => new Date(to - back * bucketSeconds * 1000).toISOString();
	return {
		range,
		bucketSeconds,
		from: new Date(from).toISOString(),
		to: new Date(to).toISOString(),
		cpuCount: 4,
		host: [
			{
				at: at(3),
				poolPercent: 18,
				memoryPercent: 30,
				load1: 1.2,
				load5: 1,
				load15: 0.8,
			},
			{
				at: at(1),
				poolPercent: 16,
				memoryPercent: 25,
				load1: 0.42,
				load5: 0.5,
				load15: 0.6,
			},
		],
		platform: [],
		events: [],
		usage: { retentionMinutes: 0, from: new Date(from).toISOString(), workspaces: [] },
		api: [],
	};
}

test("the charts load for the stored range and switch with the control", async () => {
	const requested: string[] = [];
	stubFetch((url) => {
		requested.push(url);
		if (url.endsWith("range=1d")) return json(200, series("1d", 900, 86_400));
		if (url.endsWith("range=1h")) return json(200, series("1h", 60, 3600));
		throw new Error(`unexpected request: ${url}`);
	});

	renderWithQuery(<TrendsCard warnPercent={80} />);

	expect(
		await screen.findByRole("img", {
			name: "Storage pool used: Now 16%, highest 18%.",
		}),
	).toBeDefined();
	expect(
		screen.getByRole("img", { name: "Load average: Now 0.42, highest 1.20. 4 CPUs." }),
	).toBeDefined();
	expect(screen.getAllByText("80% warning")).toHaveLength(2);
	expect(screen.getByText("4 CPUs")).toBeDefined();

	fireEvent.click(screen.getByRole("button", { name: "1 hour" }));
	await waitFor(() => expect(requested.at(-1)).toBe("/admin/health/series?range=1h"));
});

test("a failed load is announced", async () => {
	stubFetch(() => json(500, { code: "INTERNAL", message: "Something broke." }));
	renderWithQuery(<TrendsCard warnPercent={80} />);
	expect((await screen.findByRole("alert")).textContent).toBe("Something broke.");
});
