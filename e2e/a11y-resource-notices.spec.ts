/**
 * Automated accessibility checks (SPEC.md section 25.8) on the student's
 * resource tools (SPEC.md §18.3, §19.2, §19.4): Monitor with the stop
 * dialog open at its Force stop step, both notices, and the status bar's
 * memory and disk meters (at the warning tone), in the light and dark themes.
 */
import { expect, type Page, test } from "@playwright/test";
import {
	contrast,
	createStudent,
	expectNoViolations,
	query,
	seedStorage,
	workspacePath,
} from "./helpers";
import { FAKE_AGENT_URL } from "./ports";

/** Each meter's fill against its track is 3:1, and its value text 4.5:1 on the bar. */
async function expectMeterContrast(page: Page) {
	for (const id of ["memory-meter", "disk-meter"]) {
		const colours = await page.getByTestId(id).evaluate((node) => ({
			fill: getComputedStyle(node.querySelector(".pk-meter-fill") as Element)
				.backgroundColor,
			track: getComputedStyle(node.querySelector(".pk-meter-track") as Element)
				.backgroundColor,
			text: getComputedStyle(node.querySelector(".pk-meter-value") as Element).color,
			back: getComputedStyle(node.closest("footer") as Element).backgroundColor,
		}));
		expect(contrast(colours.fill, colours.track)).toBeGreaterThanOrEqual(3);
		expect(contrast(colours.text, colours.back)).toBeGreaterThanOrEqual(4.5);
	}
}

async function seed(path: string, body: unknown) {
	const response = await fetch(`${FAKE_AGENT_URL}${path}`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!response.ok)
		throw new Error(`the fake agent refused ${path}: ${response.status}`);
}

async function flagBoth(workspaceId: string): Promise<void> {
	await query(
		"update workspaces set cpu_throttle = $2, memory_flag = $3, updated_at = now() where id = $1",
		[
			workspaceId,
			JSON.stringify({
				at: new Date().toISOString(),
				averagePercent: 97,
				thresholdPercent: 80,
				windowMinutes: 30,
				sharePercent: 25,
				allowance: "100ms/100ms",
			}),
			JSON.stringify({
				at: new Date().toISOString(),
				averagePercent: 93,
				thresholdPercent: 90,
				windowMinutes: 10,
			}),
		],
	);
}

for (const scheme of ["light", "dark"] as const) {
	test(`the notices and the status bar meters have no automatic violations (${scheme})`, async ({
		page,
		context,
	}) => {
		await page.emulateMedia({ colorScheme: scheme });
		const student = await createStudent(context);
		await flagBoth(student.workspaceId);
		await seed("/__test/memory", {
			key: student.workspaceId,
			usedBytes: 90 * 1024 ** 3,
			totalBytes: 100 * 1024 ** 3,
		});
		await seedStorage(student.workspaceId, {
			home: { usedBytes: 88 * 1024 ** 3, totalBytes: 100 * 1024 ** 3 },
		});
		await page.goto(workspacePath(student.workspaceId));
		await expect(page.getByTestId("throttle-notice")).toBeVisible({ timeout: 15_000 });
		await expect(page.getByTestId("memory-notice")).toBeVisible();
		await expect(page.getByTestId("memory-meter")).toHaveAttribute(
			"data-level",
			"warning",
		);
		await expect(page.getByTestId("disk-meter")).toHaveAttribute(
			"data-level",
			"warning",
		);
		await expectNoViolations(page);
		await expectMeterContrast(page);
	});

	test(`the meters in the plain tone have no automatic violations (${scheme})`, async ({
		page,
		context,
	}) => {
		await page.emulateMedia({ colorScheme: scheme });
		const student = await createStudent(context);
		await seedStorage(student.workspaceId, {
			home: { usedBytes: 30 * 1024 ** 3, totalBytes: 100 * 1024 ** 3 },
		});
		await page.goto(workspacePath(student.workspaceId));
		await expect(page.getByTestId("disk-meter")).toHaveAttribute("data-level", "ok", {
			timeout: 15_000,
		});
		await expect(page.getByTestId("memory-meter")).toBeVisible();
		await expectMeterContrast(page);
		await expectNoViolations(page);
	});

	test(`Monitor with the Force stop step open has no automatic violations (${scheme})`, async ({
		page,
		context,
	}) => {
		await page.emulateMedia({ colorScheme: scheme });
		const student = await createStudent(context);
		await seed("/__test/processes", {
			key: student.workspaceId,
			processes: [
				{
					pid: 43,
					command: "stubborn",
					cpuPercent: 50,
					residentBytes: 4096,
					startTicks: 600,
					stoppable: true,
					commandLine: "bash stubborn.sh",
					ignoresTerm: true,
				},
				{
					pid: 12,
					command: "tmux: server",
					cpuPercent: 0.1,
					residentBytes: 2048,
					startTicks: 50,
					stoppable: false,
					commandLine: null,
				},
			],
		});
		await page.goto(workspacePath(student.workspaceId));
		await page.getByRole("tab", { name: "Monitor" }).click({ timeout: 15_000 });
		await page
			.getByRole("button", { name: "Show the full command for PID 43" })
			.click();
		await expect(page.getByTestId("monitor-command-43")).toBeVisible();
		await expectNoViolations(page);

		await page.getByRole("button", { name: "Stop stubborn (PID 43)" }).click();
		const dialog = page.getByTestId("dialog-stop-process");
		await dialog.getByRole("button", { name: "Stop" }).click();
		await expect(dialog.getByRole("button", { name: "Force stop" })).toBeVisible();
		await expectNoViolations(page);
	});
}
