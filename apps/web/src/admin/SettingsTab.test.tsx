import { screen, within } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { json, renderApp, stubFetch, USER } from "../test-utils.js";

afterEach(() => vi.unstubAllGlobals());

const SETTINGS = {
	shutdownGraceSeconds: 600,
	logLevel: null,
	cpuGuardThresholdPercent: 80,
	memoryGuardThresholdPercent: 90,
	guardWindowMinutes: 30,
	cpuThrottleSharePercent: 25,
	cpuIdleLiftMinutes: 5,
	cpuIdleLiftPercent: 10,
	cpuThrottleHoldAfter: 3,
	cpuThrottleHoldHours: 24,
	idleStopMinutes: 60,
	acceptableUseText: null,
	acceptableUseVersion: 1,
	updatedAt: null,
};

function stubSettings() {
	stubFetch((url) => {
		if (url === "/auth/me") return json(200, { ...USER, role: "administrator" });
		if (url === "/admin/settings") return json(200, SETTINGS);
		throw new Error(`unexpected request: ${url}`);
	});
}

test("Settings is three sections in one column, and the log level is not among them", async () => {
	stubSettings();
	renderApp("/admin?tab=settings");

	const column = await screen.findByTestId("settings-sections");
	const headings = within(column)
		.getAllByRole("heading", { level: 3 })
		.map((heading) => heading.textContent);
	expect(headings).toEqual([
		"When workspaces stop",
		"Resource guard",
		"Acceptable use",
	]);
	expect(screen.queryByTestId("log-level-select")).toBeNull();
});

test("the resource guard is four named groups, each with its fields and one line", async () => {
	stubSettings();
	renderApp("/admin?tab=settings");

	const guard = await screen.findByRole("region", { name: "Resource guard" });
	const groups = within(guard).getAllByRole("group");
	expect(groups.map((group) => group.querySelector("legend")?.textContent)).toEqual([
		"Slow down heavy CPU use",
		"Give full speed back",
		"Keep repeat cases slowed",
		"Flag high memory",
	]);
	const fields = groups.map((group) =>
		within(group)
			.getAllByRole("textbox")
			.map((input) => input.getAttribute("id")),
	);
	expect(fields).toEqual([
		[
			"settings-cpuThresholdPercent",
			"settings-windowMinutes",
			"settings-throttleSharePercent",
		],
		["settings-cpuIdleLiftMinutes", "settings-cpuIdleLiftPercent"],
		["settings-cpuThrottleHoldAfter", "settings-cpuThrottleHoldHours"],
		["settings-memoryThresholdPercent"],
	]);
	// Each group's line is its description, so a screen reader hears it on entry.
	for (const group of groups) {
		const line = document.getElementById(group.getAttribute("aria-describedby") ?? "");
		expect(line?.textContent).toMatch(/\.$/);
	}
	// One Save for the whole section.
	expect(within(guard).getAllByRole("button", { name: "Save" })).toHaveLength(1);
});

test("the grace period and idle stop sit side by side, each with its own Save", async () => {
	stubSettings();
	renderApp("/admin?tab=settings");

	const stop = await screen.findByRole("region", { name: "When workspaces stop" });
	expect(
		within(stop).getByRole("textbox", { name: "Disconnect grace (minutes)" }),
	).toBeDefined();
	expect(
		within(stop).getByRole("textbox", { name: "Idle stop (minutes)" }),
	).toBeDefined();
	expect(within(stop).getAllByRole("button", { name: "Save" })).toHaveLength(2);
	expect(within(stop).getByText("0 means never.")).toBeDefined();
});
