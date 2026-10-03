/**
 * The status bar with everything it can show at once: the path and a long
 * Git line, the stop countdown, a Keep running hold, both meters past their
 * warning, a storage warning, and the workspace state. Nothing overflows the
 * bar at any width; the workspace group wraps under the path, and a button
 * too wide for the bar wraps its own text (SPEC.md §19.2, §25.8).
 */
import { expect, type Page, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	expectNoViolations,
	openAdmin,
	query,
	seedGit,
	seedStorage,
	workspacePath,
} from "./helpers";
import { FAKE_AGENT_URL } from "./ports";

const GIB = 1024 ** 3;
const percent = (value: number) => ({ usedBytes: value * GIB, totalBytes: 100 * GIB });

async function busyBar(page: Page, context: Parameters<typeof createStudent>[0]) {
	const student = await createStudent(context);
	await seedStorage(student.workspaceId, { home: percent(96), docker: percent(97) });
	const memory = await fetch(`${FAKE_AGENT_URL}/__test/memory`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ key: student.workspaceId, ...percent(90) }),
	});
	expect(memory.ok).toBe(true);
	const project = await createProject(student.workspaceId, {
		name: "A project with a rather long folder name",
	});
	await seedGit(student.workspaceId, project.slug, {
		status: {
			repo: true,
			branch: "feature/a-branch-name-that-goes-on-for-quite-a-while",
			detached: false,
			upstream: null,
			ahead: 0,
			behind: 0,
			conflicts: 0,
			entries: [{ path: "a.ts", x: ".", y: "M", unmerged: false }],
			ignored: [],
			truncated: false,
		},
	});
	await query(
		`update workspaces
		    set shutdown_deadline = now() + interval '10 minutes',
		        keep_running_until = now() + interval '3 hours'
		  where id = $1`,
		[student.workspaceId],
	);
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(page.getByTestId("disk-meter")).toHaveAttribute("data-level", "full", {
		timeout: 15_000,
	});
	await expect(page.getByTestId("memory-meter")).toHaveAttribute(
		"data-level",
		"warning",
	);
	await expect(page.getByTestId("keep-running-indicator")).toBeVisible();
	await expect(page.getByTestId("storage-warning")).toBeVisible();
	await expect(page.getByTestId("git-status")).toContainText("feature/a-branch-name");
}

/** Every item sits inside the bar, and no button clips its own text. */
async function expectNothingOverflows(page: Page) {
	const layout = await page.getByTestId("status-bar").evaluate((bar) => {
		const box = bar.getBoundingClientRect();
		const items = [...bar.querySelectorAll<HTMLElement>("button, .pk-statusbar-item")];
		return {
			barScrolls: bar.scrollWidth > bar.clientWidth,
			outside: items
				.filter((item) => {
					const rect = item.getBoundingClientRect();
					return (
						rect.width > 0 &&
						(rect.left < box.left - 0.5 || rect.right > box.right + 0.5)
					);
				})
				.map((item) => item.dataset.testid ?? item.className),
			clipped: [...bar.querySelectorAll<HTMLElement>("button")]
				.filter((button) => button.scrollWidth > button.clientWidth + 0.5)
				.map((button) => button.dataset.testid ?? button.className),
		};
	});
	expect(layout).toEqual({ barScrolls: false, outside: [], clipped: [] });
}

for (const scheme of ["light", "dark"] as const) {
	for (const width of [1440, 1024] as const) {
		test(`at ${width} px every status bar item fits inside the bar (${scheme})`, async ({
			page,
			context,
		}) => {
			await page.emulateMedia({ colorScheme: scheme });
			await page.setViewportSize({ width, height: 720 });
			await busyBar(page, context);
			await expectNothingOverflows(page);
			await page
				.getByTestId("status-bar")
				.screenshot({ path: `screenshots/status-bar-${width}-${scheme}.png` });
			await expectNoViolations(page, '[data-testid="status-bar"]');
		});
	}

	test(`at 1440 px the bar keeps to one 28 px line with every warning showing (${scheme})`, async ({
		page,
		context,
	}) => {
		await page.emulateMedia({ colorScheme: scheme });
		await page.setViewportSize({ width: 1440, height: 720 });
		await busyBar(page, context);
		// The meters show a percentage; the full figure and "nearly full" are in the name.
		await expect(page.getByTestId("memory-meter")).toHaveText("Memory90%");
		await expect(page.getByTestId("memory-meter")).toHaveAccessibleName(
			"Memory 90%, 90.0 GB of 100 GB, nearly full. See what's using memory",
		);
		const bar = page.getByTestId("status-bar");
		const box = await bar.boundingBox();
		expect(box?.height).toBe(28);
		// Both groups sit on the same line: their vertical centres match.
		const centres = await bar.evaluate((node) =>
			[
				...node.querySelectorAll<HTMLElement>(
					".pk-statusbar-where, .pk-statusbar-status",
				),
			].map((group) => {
				const rect = group.getBoundingClientRect();
				return Math.round(rect.top + rect.height / 2);
			}),
		);
		expect(new Set(centres).size).toBe(1);
	});

	test(`in a 360 px container the buttons wrap their own text, Keep running included (${scheme})`, async ({
		page,
		context,
	}) => {
		await page.emulateMedia({ colorScheme: scheme });
		await busyBar(page, context);
		// The shell is never narrower than 1024 px today (DESIGN.md, "The 1024-wide
		// rail collapse is deferred"), so narrow the bar itself, as a pane would.
		const bar = page.getByTestId("status-bar");
		await bar.evaluate((node) => {
			node.style.width = "360px";
		});
		const hold = page.getByTestId("keep-running-indicator");
		await expect(hold).toHaveCSS("white-space", "normal");
		await expectNothingOverflows(page);
		await bar.screenshot({ path: `screenshots/status-bar-360-${scheme}.png` });
		await expectNoViolations(page, '[data-testid="status-bar"]');
	});

	test(`in a 560 px window the workspace page passes axe and the bar keeps everything inside (${scheme})`, async ({
		page,
		context,
	}) => {
		await page.emulateMedia({ colorScheme: scheme });
		await page.setViewportSize({ width: 560, height: 720 });
		await busyBar(page, context);
		await expectNothingOverflows(page);
		await page.screenshot({ path: `screenshots/workspace-560-${scheme}.png` });
		await expectNoViolations(page);
	});

	test(`in a 560 px window the admin page passes axe (${scheme})`, async ({ page }) => {
		await page.emulateMedia({ colorScheme: scheme });
		await page.setViewportSize({ width: 560, height: 720 });
		await openAdmin(page);
		await page.screenshot({ path: `screenshots/admin-560-${scheme}.png` });
		await expectNoViolations(page);
	});
}
