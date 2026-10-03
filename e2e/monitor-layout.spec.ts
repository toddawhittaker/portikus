/**
 * Monitor's process list layout and Stop colour (SPEC.md §18.3, §25.8).
 * Every row is the same height, the command
 * disclosure and Stop each keep one column, and Stop is the danger red in
 * both themes, like Running and Checks.
 */
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
	createStudent,
	expectNoViolations,
	query,
	settledAxe,
	workspacePath,
} from "./helpers";
import { FAKE_AGENT_URL } from "./ports";

async function seedProcesses(workspaceId: string, processes: unknown[]): Promise<void> {
	const response = await fetch(`${FAKE_AGENT_URL}/__test/processes`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ key: workspaceId, processes }),
	});
	if (!response.ok)
		throw new Error(`the fake agent refused the processes: ${response.status}`);
}

// Short names, so no command wraps and the heights compare only the actions.
const base = { cpuPercent: 1, residentBytes: 4096 };
const BOTH = {
	...base,
	pid: 42,
	command: "node",
	startTicks: 500,
	stoppable: true,
	commandLine: "node server.js",
	cpuPercent: 40,
};
const CHEVRON_ONLY = {
	...base,
	pid: 43,
	command: "python3",
	startTicks: 501,
	stoppable: false,
	commandLine: "python3 app.py",
	cpuPercent: 30,
};
const STOP_ONLY = {
	...base,
	pid: 44,
	command: "sleep",
	startTicks: 502,
	stoppable: true,
	commandLine: null,
	cpuPercent: 20,
};
const NEITHER = {
	...base,
	pid: 12,
	command: "cron",
	startTicks: 50,
	stoppable: false,
	commandLine: null,
	cpuPercent: 10,
};

async function openMonitor(page: Page, workspaceId: string): Promise<void> {
	await page.goto(workspacePath(workspaceId));
	await page.getByRole("tab", { name: "Monitor" }).click();
	await expect(page.getByTestId("monitor-process-12")).toBeVisible({ timeout: 15_000 });
}

async function chooseTheme(
	page: Page,
	userId: string,
	workspaceId: string,
	theme: "light" | "dark",
): Promise<void> {
	await query(
		"update users set editor_settings = editor_settings || $1::jsonb where id = $2",
		[JSON.stringify({ appearance: theme }), userId],
	);
	await openMonitor(page, workspaceId);
	await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
}

async function box(locator: Locator) {
	const found = await locator.boundingBox();
	if (!found) throw new Error("element has no box");
	return found;
}

async function iconColor(button: Locator): Promise<string> {
	return button.locator("svg").evaluate((element) => {
		const style = getComputedStyle(element);
		const stroke = style.stroke.toLowerCase();
		if (stroke === "" || stroke === "none" || stroke === "currentcolor") {
			return style.color;
		}
		return style.stroke;
	});
}

async function dangerColor(page: Page): Promise<string> {
	return page.evaluate(() => {
		const probe = document.createElement("span");
		probe.style.color = "var(--status-danger)";
		document.body.append(probe);
		const color = getComputedStyle(probe).color;
		probe.remove();
		return color;
	});
}

for (const theme of ["light", "dark"] as const) {
	test(`rows are even, actions keep their columns and Stop is red (${theme})`, async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		await seedProcesses(student.workspaceId, [BOTH, CHEVRON_ONLY, STOP_ONLY, NEITHER]);
		await chooseTheme(page, student.userId, student.workspaceId, theme);

		const heights = await Promise.all(
			[42, 43, 44, 12].map(
				async (pid) => (await box(page.getByTestId(`monitor-process-${pid}`))).height,
			),
		);
		for (const height of heights) expect(height).toBeCloseTo(heights[0] ?? 0, 0);

		const chevronX = await Promise.all(
			[42, 43].map(
				async (pid) => (await box(page.getByTestId(`monitor-show-command-${pid}`))).x,
			),
		);
		expect(chevronX[1]).toBeCloseTo(chevronX[0] ?? 0, 0);
		const stopX = await Promise.all(
			[42, 44].map(
				async (pid) => (await box(page.getByTestId(`monitor-stop-${pid}`))).x,
			),
		);
		expect(stopX[1]).toBeCloseTo(stopX[0] ?? 0, 0);
		expect(stopX[0] ?? 0).toBeGreaterThan(chevronX[0] ?? 0);
		// Targets stay at least 24 px (WCAG 2.5.8).
		const stopBox = await box(page.getByTestId("monitor-stop-42"));
		expect(stopBox.width).toBeGreaterThanOrEqual(24);
		expect(stopBox.height).toBeGreaterThanOrEqual(24);

		const danger = await dangerColor(page);
		const stop = page.getByTestId("monitor-stop-42");
		await page.mouse.move(0, 0);
		await expect.poll(() => iconColor(stop)).toBe(danger);
		await stop.hover();
		await expect.poll(() => iconColor(stop)).toBe(danger);
		await page.mouse.move(0, 0);
		await stop.focus();
		await expect.poll(() => iconColor(stop)).toBe(danger);

		await page.screenshot({ path: `screenshots/monitor-rows-${theme}.png` });
		const results = await (await settledAxe(page))
			.include("[data-testid='monitor']")
			.analyze();
		expect(results.violations).toEqual([]);
	});
}

for (const theme of ["light", "dark"] as const) {
	test(`the keyboard sorts the processes and each sort is announced (${theme})`, async ({
		page,
		context,
	}) => {
		await page.setViewportSize({ width: 1024, height: 768 });
		const student = await createStudent(context);
		await seedProcesses(student.workspaceId, [BOTH, CHEVRON_ONLY, STOP_ONLY, NEITHER]);
		await chooseTheme(page, student.userId, student.workspaceId, theme);
		const table = page.getByTestId("monitor-processes");
		const firstPid = () =>
			table.locator("tbody tr").first().getAttribute("data-testid");
		const spoken = page.getByTestId("monitor-sort-announce");
		await expect(spoken).toHaveAttribute("role", "status");
		await expect(spoken).toHaveText("");
		// Busiest first until a header is pressed.
		await expect(table.getByRole("columnheader", { name: "CPU" })).toHaveAttribute(
			"aria-sort",
			"descending",
		);
		expect(await firstPid()).toBe("monitor-process-42");

		const pid = table.getByRole("button", { name: "PID", exact: true });
		await pid.focus();
		await page.keyboard.press("Enter");
		await expect(spoken).toHaveText("Sorted by PID, ascending");
		await expect.poll(firstPid).toBe("monitor-process-12");
		await page.keyboard.press("Enter");
		await expect(spoken).toHaveText("Sorted by PID, descending");
		await expect.poll(firstPid).toBe("monitor-process-44");

		// Tab moves to CPU, whose first press is highest first again.
		await page.keyboard.press("Tab");
		await expect(table.getByRole("button", { name: "CPU", exact: true })).toBeFocused();
		await page.keyboard.press("Enter");
		await expect(spoken).toHaveText("Sorted by CPU, descending");
		await expect(table.getByRole("columnheader", { name: "PID" })).not.toHaveAttribute(
			"aria-sort",
		);
		await expect.poll(firstPid).toBe("monitor-process-42");

		// The headers fit the pane: nothing scrolls sideways.
		const fits = await page
			.getByTestId("monitor")
			.evaluate((element) => element.scrollWidth <= element.clientWidth);
		expect(fits).toBe(true);
		await page.screenshot({ path: `screenshots/monitor-sorted-${theme}.png` });
		await expectNoViolations(page, "[data-testid='monitor']");
	});
}
