/**
 * Automated accessibility checks (SPEC.md section 25.8) on the administrator's
 * process list (SPEC.md §20.1): the table sorted from the keyboard, then the
 * stop dialog at its Force stop step, in the light and dark themes.
 */
import { expect, test } from "@playwright/test";
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
		// The table fits the panel at 1024 px, the Stop column included.
		const fits = await table.evaluate(
			(element) => element.scrollWidth <= (element.parentElement?.clientWidth ?? 0),
		);
		expect(fits).toBe(true);
		await page.screenshot({ path: `screenshots/admin-processes-sorted-${scheme}.png` });
		await expectNoViolations(page);

		await section.getByRole("button", { name: "Stop stubborn (PID 43)" }).click();
		const dialog = page.getByTestId("dialog-admin-stop-process");
		await dialog.getByRole("button", { name: "Stop" }).click();
		await expect(dialog.getByRole("button", { name: "Force stop" })).toBeVisible();
		await expectNoViolations(page);
	});
}
