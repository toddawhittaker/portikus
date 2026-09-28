/**
 * The right pane at the widths students actually get (Epic 25, M1 to M3):
 * the 200 px minimum a 1024 px window leaves it, and the 280 px default at
 * 1440. The switch stays on one line, no Running row paints text over text,
 * every Stop stays inside the pane and can be pressed, and Monitor's table
 * never grows wider than the pane. Axe runs over the pane in both themes.
 */
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	query,
	seedFile,
	seedListening,
	settledAxe,
	WCAG_TAGS,
	workspacePath,
} from "./helpers";
import { FAKE_AGENT_URL } from "./ports";

const LONG_CONTAINER = "todo-database-with-a-rather-long-container-name";

const LISTENING = [
	{
		port: 5173,
		process: { pid: 4242, command: "node", commandLine: "node vite --host" },
	},
	// A denied port with no process: "Program not known", "Can't be previewed".
	{ port: 5432 },
	{ port: 8080, container: { id: "c1", name: LONG_CONTAINER } },
	// Hidden until Show system is on; its presence brings the checkbox.
	{ port: 5355, system: true, process: { pid: 7, command: "systemd-resolve" } },
];

const PROCESSES = [
	{
		pid: 4242,
		cpuPercent: 40,
		residentBytes: 90_000_000,
		// The longest name the agent sends (the kernel's 15-character comm).
		command: "node-dev-server",
		startTicks: 500,
		stoppable: true,
		commandLine: "node vite --host",
	},
	{
		// A seven-digit PID, the widest the kernel hands out.
		pid: 4194301,
		cpuPercent: 1,
		residentBytes: 4096,
		command: "cron",
		startTicks: 50,
		stoppable: false,
		commandLine: null,
	},
];

async function box(locator: Locator) {
	const found = await locator.boundingBox();
	if (!found) throw new Error("element has no box");
	return found;
}

function overlaps(
	a: { x: number; y: number; width: number; height: number },
	b: { x: number; y: number; width: number; height: number },
): boolean {
	return (
		a.x < b.x + b.width &&
		b.x < a.x + a.width &&
		a.y < b.y + b.height &&
		b.y < a.y + a.height
	);
}

async function open(
	page: Page,
	theme: "light" | "dark",
	width: number,
): Promise<{ workspaceId: string }> {
	const student = await createStudent(page.context());
	await query(
		"update users set editor_settings = editor_settings || $1::jsonb where id = $2",
		[JSON.stringify({ appearance: theme }), student.userId],
	);
	await seedListening(student.workspaceId, LISTENING);
	const seeded = await fetch(`${FAKE_AGENT_URL}/__test/processes`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ key: student.workspaceId, processes: PROCESSES }),
	});
	expect(seeded.ok).toBe(true);
	const project = await createProject(student.workspaceId, { name: "Narrow pane" });
	await seedFile(
		student.workspaceId,
		project.slug,
		".portikus/checks.json",
		JSON.stringify({
			checks: [
				{ id: "tests", name: "Tests", command: "npm test" },
				{
					id: "long",
					name: "A check with a long name that cannot fit",
					command: "npm run lint -- --max-warnings=0 --format=stylish",
				},
			],
		}),
	);
	await page.setViewportSize({ width, height: 800 });
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
	await expect(page.getByTestId("right-pane-tab-files")).toBeVisible({
		timeout: 15_000,
	});
	if (width === 1024) {
		// Drag the pane to its narrowest, as a student making room for the editor would.
		const handle = await box(page.getByRole("separator", { name: "Resize file tree" }));
		await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
		await page.mouse.down();
		await page.mouse.move(handle.x + 300, handle.y + handle.height / 2, { steps: 5 });
		await page.mouse.up();
	}
	return { workspaceId: student.workspaceId };
}

async function paneBox(page: Page) {
	return box(page.locator(".pk-right-pane"));
}

async function axe(page: Page): Promise<void> {
	const results = await (await settledAxe(page))
		.withTags(WCAG_TAGS)
		.include(".pk-right-pane")
		.analyze();
	expect(results.violations).toEqual([]);
}

/**
 * Open a toggletip, check it names its subject, fits the window and passes
 * axe while open, then close it with Escape and see focus return.
 */
async function tip(
	page: Page,
	label: string,
	text: string,
	name?: string,
): Promise<void> {
	const button = page.getByRole("button", { name: `About ${label}`, exact: true });
	await button.click();
	const note = page.getByRole("dialog", { name: label });
	await expect(note).toContainText(text);
	const shown = await box(note);
	const viewport = page.viewportSize();
	expect(shown.x).toBeGreaterThanOrEqual(0);
	expect(shown.x + shown.width).toBeLessThanOrEqual(viewport?.width ?? 0);
	const results = await (await settledAxe(page))
		.withTags(WCAG_TAGS)
		.include(".pk-right-pane")
		.include(".pk-toggletip-content")
		.analyze();
	// After axe, so the note has finished fading in.
	if (name) await page.screenshot({ path: name });
	expect(results.violations).toEqual([]);
	await page.keyboard.press("Escape");
	await expect(note).toHaveCount(0);
	await expect(button).toBeFocused();
}

for (const theme of ["light", "dark"] as const) {
	for (const width of [1024, 1440]) {
		test(`the right pane fits at ${width} px${width === 1024 ? ", dragged to its narrowest" : ""} (${theme})`, async ({
			page,
		}) => {
			await open(page, theme, width);
			const pane = await paneBox(page);
			if (width === 1024) expect(pane.width).toBeLessThanOrEqual(210);
			const shot = (name: string) =>
				page.screenshot({
					path: `screenshots/2026-09-27-e25-sa-${name}-${theme}-${width}.png`,
				});

			// The switch: four tabs on one line, whatever the width.
			const tabs = ["files", "checks", "running", "monitor"].map((name) =>
				page.getByTestId(`right-pane-tab-${name}`),
			);
			const tops = await Promise.all(tabs.map(async (tab) => (await box(tab)).y));
			for (const top of tops) expect(top).toBeCloseTo(tops[0] ?? 0, 0);
			const strip = await box(page.locator(".pk-pane-tabs"));
			const tabHeight = (await box(tabs[0] as Locator)).height;
			expect(strip.height).toBeLessThan(tabHeight * 1.5);

			// Running: port and program never share pixels; every action is in the pane.
			await page.getByTestId("right-pane-tab-running").click();
			// A tab chosen off the edge of a scrolled strip comes into view.
			const runningTab = await box(page.getByTestId("right-pane-tab-running"));
			expect(runningTab.x + runningTab.width).toBeLessThanOrEqual(
				pane.x + pane.width + 1,
			);
			for (const port of [5173, 5432, 8080]) {
				const row = page.getByTestId(`running-row-${port}`);
				await expect(row).toBeVisible({ timeout: 20_000 });
				const portCell = await box(row.locator(".pk-portrow-port"));
				const name = await box(row.locator(".pk-portrow-name"));
				expect(overlaps(portCell, name)).toBe(false);
				const stop = await box(page.getByTestId(`running-stop-${port}`));
				expect(overlaps(stop, name)).toBe(false);
				expect(stop.x).toBeGreaterThanOrEqual(pane.x);
				expect(stop.x + stop.width).toBeLessThanOrEqual(pane.x + pane.width);
			}
			await expect(page.getByTestId("running-row-5432")).toContainText(
				"Program not known",
			);
			await expect(page.getByTestId("running-reason-5432")).toHaveText(
				"Can't be previewed",
			);
			await shot("running");
			await tip(
				page,
				"Running",
				"Only you can open your previews",
				`screenshots/2026-09-27-e25-sa-tip-running-${theme}-${width}.png`,
			);
			await tip(page, "Can't be previewed, port 5432", "from 1024 up");
			await tip(page, "Show system", "workspace system rather than by you");
			await axe(page);
			// Stop is reachable, not just drawn: it opens its dialog.
			await page.getByTestId("running-stop-8080").click();
			await expect(page.getByTestId("dialog-stop-listener")).toBeVisible();
			await page.keyboard.press("Escape");
			await expect(page.getByTestId("dialog-stop-listener")).toHaveCount(0);

			// Monitor: Stop stays in the pane and the table is never wider than it.
			await page.getByTestId("right-pane-tab-monitor").click();
			// The last tab, off the edge at 200 px, scrolls fully into view.
			const monitorTab = await box(page.getByTestId("right-pane-tab-monitor"));
			expect(monitorTab.x + monitorTab.width).toBeLessThanOrEqual(
				pane.x + pane.width + 1,
			);
			await expect(page.getByTestId("monitor-process-4242")).toBeVisible({
				timeout: 15_000,
			});
			const table = await box(page.getByTestId("monitor-processes"));
			expect(table.x + table.width).toBeLessThanOrEqual(pane.x + pane.width);
			const stop = await box(page.getByTestId("monitor-stop-4242"));
			expect(stop.x + stop.width).toBeLessThanOrEqual(pane.x + pane.width);
			// PID gives way first, then Memory, so Command, CPU and the actions fit.
			const pidHeader = page.getByRole("columnheader", { name: "PID" });
			const memoryHeader = page.getByRole("columnheader", { name: "Memory" });
			if (width === 1024) {
				await expect(pidHeader).toBeHidden();
				await expect(memoryHeader).toBeHidden();
			} else {
				// The default width keeps every column, even with a seven-digit PID.
				await expect(pidHeader).toBeVisible();
				await expect(memoryHeader).toBeVisible();
			}
			await expect(page.getByRole("columnheader", { name: /^CPU/ })).toBeVisible();
			await expect(page.getByRole("columnheader", { name: "Command" })).toBeVisible();
			// No figure breaks inside itself ("100 B /" then "200 B").
			for (const figure of await page
				.getByTestId("monitor-memory")
				.locator("span")
				.all()) {
				expect((await box(figure)).height).toBeLessThanOrEqual(20);
			}
			await shot("monitor");
			await tip(page, "Processes", "busiest first");
			await axe(page);
			await page.getByTestId("monitor-stop-4242").click();
			await expect(page.getByTestId("dialog-stop-process")).toBeVisible();
			await page.keyboard.press("Escape");

			// Checks: the output names its check and says how to fill it.
			await page.getByTestId("right-pane-tab-checks").click();
			await expect(page.getByTestId("check-output-empty")).toHaveText(
				"Run a check to see its output here.",
			);
			const run = await box(page.getByTestId("check-run-long"));
			expect(run.x + run.width).toBeLessThanOrEqual(pane.x + pane.width);
			// A short name is never cut to "Te…" by the badge beside it.
			const name = page.getByTestId("check-item-tests").locator(".pk-check-name");
			expect(await name.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
			await shot("checks");
			await tip(page, "Checks", ".portikus/checks.json");
			await axe(page);

			// Find in files: the field keeps its name without repeating the head.
			await page.getByTestId("right-pane-tab-files").click();
			await page.getByTestId("search-open").click();
			await expect(page.getByRole("textbox", { name: "Find in files" })).toBeFocused();
			await expect(page.locator(".pk-search-controls .pk-label")).toHaveCSS(
				"position",
				"absolute",
			);
			await shot("search");
		});
	}
}
