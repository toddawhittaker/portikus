/**
 * Automated accessibility checks (SPEC.md section 25.8) on the administrator's
 * process list (SPEC.md §20.1): the table sorted from the keyboard, then the
 * stop dialog at its Force stop step, in the light and dark themes.
 */
import { expect, type Locator, test } from "@playwright/test";
import { createStudent, expectNoViolations, loginAs, query } from "./helpers";
import { FAKE_AGENT_URL } from "./ports";

const STUBBORN = {
	pid: 43,
	uid: 1000,
	name: "stubborn",
	startTicks: 600,
	cpuPercent: 50,
	residentBytes: 4096,
	protected: false,
};
const AGENT = {
	pid: 9,
	uid: 0,
	name: "portikus-agent",
	startTicks: 10,
	cpuPercent: 0.2,
	residentBytes: 2048,
	protected: true,
};

/** The space between each visible header's label and the next one's, in pixels. */
async function headerGaps(table: Locator): Promise<number[]> {
	return table.locator("thead th").evaluateAll((cells) => {
		const labels = cells
			.filter((cell) => cell.getBoundingClientRect().width > 0)
			.map((cell) => {
				// A sort or help button, or else the header's own text.
				const button = cell.querySelector("button");
				if (button) return button.getBoundingClientRect();
				const range = document.createRange();
				range.selectNodeContents(cell);
				return range.getBoundingClientRect();
			});
		return labels.slice(1).map((next, i) => next.left - (labels[i]?.right ?? 0));
	});
}

/** The unsorted header's hint chevron is drawn, and wholly inside its own cell. */
async function expectHintInCell(header: Locator): Promise<void> {
	const hint = header.locator(".pk-table-sort-hint");
	await expect(hint).toHaveCSS("opacity", "1");
	const cell = await header.boundingBox();
	const drawn = await hint.boundingBox();
	if (!cell || !drawn) throw new Error("the header or its hint has no box");
	expect(drawn.x).toBeGreaterThanOrEqual(cell.x);
	expect(drawn.x + drawn.width).toBeLessThanOrEqual(cell.x + cell.width);
}

for (const scheme of ["light", "dark"] as const) {
	test(`the process list and its stop dialog have no automatic violations (${scheme})`, async ({
		page,
		browser,
	}) => {
		await page.emulateMedia({ colorScheme: scheme });
		// The smallest admin window (SPEC.md §20.1).
		await page.setViewportSize({ width: 1024, height: 768 });
		const studentContext = await browser.newContext();
		const student = await createStudent(studentContext);
		await studentContext.close();
		const name = `A11y procs ${student.userId.slice(0, 8)}`;
		await query("update users set display_name = $2 where id = $1", [
			student.userId,
			name,
		]);
		const seeded = await fetch(`${FAKE_AGENT_URL}/__test/processes`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				key: student.workspaceId,
				processes: [
					{
						...STUBBORN,
						command: STUBBORN.name,
						stoppable: true,
						commandLine: null,
						ignoresTerm: true,
					},
				],
			}),
		});
		expect(seeded.ok).toBe(true);

		await loginAs(page, "carol");
		await page.goto("/admin");
		await expect(page.getByTestId("admin-accounts")).toBeVisible({ timeout: 15_000 });
		await page.getByTestId("admin-filter-text").fill(name);
		await page.getByRole("button", { name: `Show details for ${name}` }).click();
		const section = page
			.getByRole("region", { name })
			.getByRole("region", { name: "Processes" });
		await section.getByRole("button", { name: /Refresh processes/ }).click();
		// Answer the request as the worker would.
		await expect
			.poll(
				async () =>
					(
						await query(
							"select 1 from workspace_process_snapshots where workspace_id = $1 and taken_at is null",
							[student.workspaceId],
						)
					).length,
			)
			.toBe(1);
		await query(
			"update workspace_process_snapshots set taken_at = now(), processes = $2 where workspace_id = $1",
			[student.workspaceId, JSON.stringify([STUBBORN, AGENT])],
		);
		const table = section.getByTestId("processes-table");
		await expect(table).toBeVisible();

		// A keyboard sort is announced politely, and a second press flips it.
		const spoken = section.getByTestId("processes-sort-announce");
		await expect(spoken).toHaveAttribute("role", "status");
		await expect(spoken).toHaveText("");
		await section.getByRole("button", { name: "CPU" }).focus();
		await page.keyboard.press("Tab");
		await expect(section.getByRole("button", { name: "Memory" })).toBeFocused();
		await page.keyboard.press("Enter");
		await expect(spoken).toHaveText("Sorted by Memory, descending");
		const memory = table.getByRole("columnheader", { name: "Memory" });
		await expect(memory).toHaveAttribute("aria-sort", "descending");
		await expect(table.getByRole("columnheader", { name: "CPU" })).not.toHaveAttribute(
			"aria-sort",
		);
		await expect(table.locator("tbody tr").first()).toContainText("stubborn");
		await page.keyboard.press("Enter");
		await expect(spoken).toHaveText("Sorted by Memory, ascending");
		await expect(memory).toHaveAttribute("aria-sort", "ascending");
		await expect(table.locator("tbody tr").first()).toContainText("portikus-agent");

		// The sorted header reads in full ink; the others are muted.
		const color = (name: string) =>
			table
				.getByRole("button", { name, exact: true })
				.evaluate((element) => getComputedStyle(element).color);
		await page.mouse.move(0, 0);
		expect(await color("Memory")).not.toBe(await color("CPU"));

		// CPU's faint hint shows on keyboard focus and on hover, inside its own cell.
		await page.keyboard.press("Shift+Tab");
		await expect(table.getByRole("button", { name: "CPU", exact: true })).toBeFocused();
		await expectHintInCell(table.getByRole("columnheader", { name: "CPU" }));
		await page.screenshot({ path: `screenshots/admin-processes-hint-${scheme}.png` });
		await page.keyboard.press("Tab");
		await table.getByRole("button", { name: "CPU", exact: true }).hover();
		await expectHintInCell(table.getByRole("columnheader", { name: "CPU" }));
		await page.mouse.move(0, 0);
		// The table fits the panel at 1024 px, the Stop column included, and
		// each column keeps at least 8 px from the next.
		const fits = await table.evaluate(
			(element) => element.scrollWidth <= (element.parentElement?.clientWidth ?? 0),
		);
		expect(fits).toBe(true);
		const tableBox = await table.boundingBox();
		const panelBox = await section.boundingBox();
		expect((tableBox?.x ?? 0) + (tableBox?.width ?? 0)).toBeLessThanOrEqual(
			(panelBox?.x ?? 0) + (panelBox?.width ?? 0),
		);
		for (const gap of await headerGaps(table)) expect(gap).toBeGreaterThanOrEqual(8);
		await page.screenshot({ path: `screenshots/admin-processes-sorted-${scheme}.png` });
		await expectNoViolations(page);

		await section.getByRole("button", { name: "Stop stubborn (PID 43)" }).click();
		const dialog = page.getByTestId("dialog-admin-stop-process");
		await dialog.getByRole("button", { name: "Stop" }).click();
		await expect(dialog.getByRole("button", { name: "Force stop" })).toBeVisible();
		await expectNoViolations(page);
	});
}
