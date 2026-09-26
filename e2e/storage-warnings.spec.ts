/**
 * Storage figures and warnings (SPEC.md §18.3, §19.2, §28): the workspace
 * dialog lists the three classes, the status bar warns at 80% and names the
 * class, and at 95% the dialog says what to do next. The fake agent reports
 * whatever figures a test seeds for its workspace.
 */
import { expect, type Page, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	query,
	seedGit,
	seedStorage,
	workspacePath,
} from "./helpers";
import { FAKE_AGENT_URL } from "./ports";

const GIB = 1024 ** 3;
const percent = (value: number) => ({ usedBytes: value * GIB, totalBytes: 100 * GIB });

/** The WCAG 2 contrast ratio between two rgb() colours. */
function contrast(first: string, second: string): number {
	const luminance = (colour: string) => {
		const [r, g, b] = (colour.match(/[\d.]+/g) ?? []).slice(0, 3).map((part) => {
			const channel = Number(part) / 255;
			return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
		});
		return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
	};
	const [light, dark] = [luminance(first), luminance(second)].sort((a, b) => b - a);
	return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05);
}

/** The warning's text colour against the status bar behind it. */
async function warningContrast(page: Page): Promise<number> {
	const colours = await page.getByTestId("storage-warning").evaluate((node) => ({
		text: getComputedStyle(node).color,
		back: getComputedStyle(node.closest("footer") as Element).backgroundColor,
	}));
	return contrast(colours.text, colours.back);
}

/** The warning's text colour, and what the named status token resolves to beside it. */
async function warningColour(page: Page, token: string) {
	return page.getByTestId("storage-warning").evaluate((node, name) => {
		const probe = document.createElement("span");
		probe.style.color = `var(${name})`;
		node.parentElement?.appendChild(probe);
		const expected = getComputedStyle(probe).color;
		probe.remove();
		return { actual: getComputedStyle(node).color, expected };
	}, token);
}

test("the dialog lists Projects & home, Docker and Recovery", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await seedStorage(student.workspaceId, {
		home: percent(10),
		docker: percent(20),
		recovery: null,
	});
	await page.goto(workspacePath(student.workspaceId));

	await page.getByTestId("workspace-status").click();
	const dialog = page.getByTestId("dialog-workspace-status");
	await expect(dialog.getByTestId("storage-home")).toHaveText("10.0 GB of 100 GB");
	await expect(dialog.getByTestId("storage-docker")).toHaveText("20.0 GB of 100 GB");
	await expect(dialog.getByTestId("storage-recovery")).toHaveText("Not available");
	await expect(dialog).toContainText("Projects & home");
	await expect(page.getByTestId("storage-warning")).toHaveCount(0);
	// One meter per class; the bar is drawn only where there is a figure.
	await expect(dialog.locator(".pk-meter")).toHaveCount(3);
	await expect(dialog.locator(".pk-meter-track")).toHaveCount(2);
});

test("the dialog's actions come first, and the technical details are folded away", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await seedStorage(student.workspaceId, { home: percent(96) });
	await page.goto(workspacePath(student.workspaceId));

	await page.getByTestId("workspace-status").click();
	const dialog = page.getByTestId("dialog-workspace-status");
	await expect(dialog.getByTestId("storage-meter-home")).toHaveClass(/pk-meter--full/);
	await expect(dialog.getByTestId("workspace-restart")).toBeVisible();
	const restart = await dialog.getByTestId("workspace-restart").boundingBox();
	const storage = await dialog.getByRole("heading", { name: "Storage" }).boundingBox();
	expect(restart && storage && restart.y < storage.y).toBe(true);
	await expect(dialog.getByTestId("storage-home")).toHaveText(
		"96.0 GB of 100 GB, nearly full",
	);
	await expect(dialog.getByText("Desired state")).toBeHidden();
	await dialog.getByText("Technical details").click();
	await expect(dialog.getByText("Desired state")).toBeVisible();
});

test("at 80% the status bar names Docker", async ({ page, context }) => {
	const student = await createStudent(context);
	await seedStorage(student.workspaceId, {
		docker: percent(80),
		recovery: percent(10),
	});
	await page.goto(workspacePath(student.workspaceId));

	const warning = page.getByTestId("storage-warning");
	await expect(warning).toHaveText("Docker storage is 80% full", { timeout: 15_000 });
	await expect(warning).toHaveAttribute("data-level", "warning");
	await expect(
		page.getByTestId("status-bar").getByRole("status").first(),
	).toBeAttached();
});

test("at 80% the status bar names Recovery", async ({ page, context }) => {
	const student = await createStudent(context);
	await seedStorage(student.workspaceId, { recovery: percent(84) });
	await page.goto(workspacePath(student.workspaceId));

	await expect(page.getByTestId("storage-warning")).toHaveText(
		"Recovery storage is 84% full",
		{ timeout: 15_000 },
	);
});

test("at 95% Docker is nearly full and the dialog suggests Reset Docker", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await seedStorage(student.workspaceId, { docker: percent(96) });
	await page.goto(workspacePath(student.workspaceId));

	const warning = page.getByTestId("storage-warning");
	await expect(warning).toHaveText("Docker storage is nearly full", {
		timeout: 15_000,
	});
	await expect(warning).toHaveAttribute("data-level", "critical");
	// The warning opens the workspace dialog, from the keyboard too.
	await warning.focus();
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("storage-warning-detail")).toContainText(
		"Reset Docker",
	);
	await page.keyboard.press("Escape");
	await expect(warning).toBeFocused();
});

test("at 95% Recovery is nearly full and the dialog says old points go automatically", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await seedStorage(student.workspaceId, { recovery: percent(99) });
	await page.goto(workspacePath(student.workspaceId));

	const warning = page.getByTestId("storage-warning");
	await expect(warning).toHaveText("Recovery storage is nearly full", {
		timeout: 15_000,
	});
	await warning.click();
	await expect(page.getByTestId("storage-warning-detail")).toContainText(
		"Older recovery points are removed automatically",
	);
});

for (const theme of ["light", "dark"] as const) {
	test(`the warnings pass 4.5:1 contrast in the ${theme} theme`, async ({
		page,
		context,
	}) => {
		await context.addInitScript((value) => {
			localStorage.setItem("pk-theme", value);
		}, theme);
		const student = await createStudent(context);
		await seedStorage(student.workspaceId, { docker: percent(85) });
		await page.goto(workspacePath(student.workspaceId));
		await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
		await expect(page.getByTestId("storage-warning")).toBeVisible({ timeout: 15_000 });
		expect(await warningContrast(page)).toBeGreaterThanOrEqual(4.5);
		// The tone colour wins over the button's own (issue #608 item 3).
		const warning = await warningColour(page, "--status-warning");
		expect(warning.actual).toBe(warning.expected);

		await seedStorage(student.workspaceId, { docker: percent(97) });
		await page.reload();
		await expect(page.getByTestId("storage-warning")).toHaveAttribute(
			"data-level",
			"critical",
			{ timeout: 15_000 },
		);
		expect(await warningContrast(page)).toBeGreaterThanOrEqual(4.5);
		const critical = await warningColour(page, "--status-error");
		expect(critical.actual).toBe(critical.expected);
	});
}

test("the disk meter always shows the home volume and opens the workspace dialog", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	await seedStorage(student.workspaceId, { home: percent(40) });
	await page.goto(workspacePath(student.workspaceId));

	const disk = page.getByTestId("disk-meter");
	await expect(disk).toHaveText("Disk40.0 GB of 100 GB", { timeout: 15_000 });
	await expect(disk).toHaveAttribute("data-level", "ok");
	await expect(disk).toHaveAccessibleName(
		"Disk 40.0 GB of 100 GB. Open workspace storage",
	);
	await expect(page.getByTestId("storage-warning")).toHaveCount(0);
	await disk.click();
	const dialog = page.getByTestId("dialog-workspace-status");
	await expect(dialog).toBeVisible();
	await expect(page.getByTestId("storage-home")).toHaveText("40.0 GB of 100 GB");
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);
	await expect(disk).toBeFocused();
});

test("at the smallest supported width the path and Git line give way, and Running stays whole", async ({
	page,
	context,
}) => {
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
	const entries = Array.from({ length: 3 }, (_, index) => ({
		path: `file-${index}.ts`,
		x: ".",
		y: "M",
		unmerged: false,
	}));
	await seedGit(student.workspaceId, project.slug, {
		status: {
			repo: true,
			branch: "feature/a-branch-name-that-goes-on-for-quite-a-while",
			detached: false,
			upstream: null,
			ahead: 0,
			behind: 0,
			conflicts: 0,
			entries,
			ignored: [],
			truncated: false,
		},
	});
	// A countdown too, the widest the bar gets.
	await query(
		"update workspaces set shutdown_deadline = now() + interval '10 minutes' where id = $1",
		[student.workspaceId],
	);
	// The shell's minimum width (DESIGN.md, "The 1024-wide rail collapse is deferred").
	await page.setViewportSize({ width: 1024, height: 720 });
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(page.getByTestId("disk-meter")).toHaveAttribute("data-level", "full", {
		timeout: 15_000,
	});
	await expect(page.getByTestId("memory-meter")).toHaveAttribute(
		"data-level",
		"warning",
	);
	await expect(page.getByTestId("storage-warning")).toBeVisible();
	const git = page.getByTestId("git-status");
	await expect(git).toContainText("feature/a-branch-name");
	await expect(page.getByTestId("status-bar")).toContainText("Stopping in");

	// The Git line keeps its full text for screen readers and on hover.
	const full = await git.textContent();
	await expect(git).toHaveAttribute("title", full ?? "");
	const layout = await page.getByTestId("status-bar").evaluate((bar) => {
		const edge = bar.getBoundingClientRect().right;
		const buttons = [...bar.querySelectorAll("button")];
		const gitLine = bar.querySelector('[data-testid="git-status"]') as HTMLElement;
		return {
			buttonsWhole: buttons.every(
				(button) =>
					button.getBoundingClientRect().right <= edge &&
					button.scrollWidth <= button.clientWidth,
			),
			gitTruncated: gitLine.scrollWidth > gitLine.clientWidth,
		};
	});
	expect(layout.buttonsWhole).toBe(true);
	expect(layout.gitTruncated).toBe(true);
	const running = page.getByTestId("workspace-status");
	await expect(running).toBeInViewport({ ratio: 1 });
	await running.focus();
	await expect(running).toBeFocused();
});
