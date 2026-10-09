/**
 * Comparing one file's working copy with its version in a recovery point
 * (SPEC.md §12.6, §15.8). The fake agent keeps points in memory and answers
 * the point's diff from them.
 */
import { expect, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	pushEvent,
	query,
	seedFile,
	seedGit,
	settledAxe,
	WCAG_TAGS,
	workspacePath,
} from "./helpers";
import { FAKE_AGENT_URL } from "./ports";

const FILE = "notes.txt";

async function failPointDiffs(workspaceId: string, code: string): Promise<void> {
	const response = await fetch(`${FAKE_AGENT_URL}/__test/recovery`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ key: workspaceId, diffFailure: [504, code] }),
	});
	expect(response.ok).toBe(true);
}

test.describe("compare with a recovery point", () => {
	// The diff loads Monaco, which the dev server transforms on first use.
	test.describe.configure({ timeout: 90_000 });

	test("a point is picked by keyboard, its version shown, and a slow read explained", async ({
		page,
		context,
	}) => {
		const student = await createStudent(context);
		const project = await createProject(student.workspaceId, { name: "Point compare" });
		await seedFile(student.workspaceId, project.slug, FILE, "first draft\n");
		await seedGit(student.workspaceId, project.slug, {
			diffs: {
				[FILE]: {
					status: "M",
					before: "committed\n",
					after: "now\n",
					binary: false,
					tooLarge: false,
				},
			},
		});
		await page.goto(workspacePath(student.workspaceId, project.id));

		// Two points: one of the first draft, one after a change.
		await page.getByTestId(`project-menu-${project.id}`).click();
		await page.getByRole("menuitem", { name: "Recovery points…" }).click();
		const dialog = page.getByTestId("dialog-recovery-points");
		await dialog.getByTestId("recovery-create").click();
		await expect(dialog.locator("[data-testid^=recovery-row-]")).toHaveCount(1);
		// Age the first point past the 30-second spacing between manual points.
		await query(
			"update recovery_points set created_at = created_at - interval '1 hour' where project_id = $1",
			[project.id],
		);
		await seedFile(student.workspaceId, project.slug, FILE, "second draft\n");
		await dialog.getByTestId("recovery-create").click();
		await expect(dialog.locator("[data-testid^=recovery-row-]")).toHaveCount(2);
		await page.keyboard.press("Escape");
		await seedFile(student.workspaceId, project.slug, FILE, "now\n");

		await query("update projects set layout = $2 where id = $1", [
			project.id,
			JSON.stringify({
				tabs: [{ id: `diff:${FILE}`, root: { type: "diff", path: FILE } }],
			}),
		]);
		await page.reload();
		const pane = page.getByTestId(`diff-pane-${FILE}`);
		await expect(pane).toBeVisible({ timeout: 15_000 });

		// The whole choice is made from the keyboard.
		await pane.getByLabel("Compare with").selectOption("point");
		const picker = pane.getByLabel("Recovery point");
		await expect(picker.locator("option")).toHaveCount(2);
		await expect(picker.locator("option").first()).toContainText("Made by you");
		// Newest first, so the first draft is the second entry.
		await picker.focus();
		await picker.selectOption({ index: 1 });
		const label = (await picker.locator("option").nth(1).textContent()) ?? "";
		await page.keyboard.press("Tab");
		await expect(pane.getByRole("button", { name: "Compare" })).toBeFocused();
		await page.keyboard.press("Enter");

		await expect(page.getByTestId("diff-sides")).toHaveText(`${label}Your changes`);
		await expect(pane).toContainText(`Diff with recovery point ${label} · ${FILE}`);
		await expect(page.getByTestId(`diff-editor-${FILE}`)).toContainText("first draft", {
			timeout: 60_000,
		});
		// The waits were said in one polite region that is still there, now quiet.
		const region = pane.getByTestId("diff-compare-status");
		await expect(region).toHaveAttribute("role", "status");
		await expect(region).toHaveAttribute("aria-live", "polite");
		await expect(region).toHaveText("");

		// A change on disk refreshes Git but does not read the point again
		// (SPEC.md §15.8): only Compare does.
		let pointReads = 0;
		page.on("request", (request) => {
			if (/\/recovery-points\/[^/]+\/diff\?/.test(request.url())) pointReads += 1;
		});
		const statusAsked = page.waitForRequest(/\/git\/status\?/);
		await expect
			.poll(() =>
				pushEvent(student.workspaceId, project.slug, {
					type: "fs",
					paths: [FILE],
					git: true,
					truncated: false,
				}),
			)
			.toBeGreaterThan(0);
		await statusAsked;
		await page.evaluate(() => window.dispatchEvent(new Event("focus")));
		await page.waitForTimeout(500);
		expect(pointReads).toBe(0);
		await pane.getByRole("button", { name: "Compare" }).click();
		await expect.poll(() => pointReads).toBe(1);

		// SPEC.md §25.8: the picker adds no violation in either theme.
		for (const scheme of ["light", "dark"] as const) {
			await page.emulateMedia({ colorScheme: scheme });
			const results = await (await settledAxe(page))
				.include("[data-testid=diff-compare]")
				.withTags(WCAG_TAGS)
				.analyze();
			expect(results.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
		}

		// A read that runs out of time says so out loud.
		await failPointDiffs(student.workspaceId, "RECOVERY_READ_TIMEOUT");
		await picker.selectOption({ index: 0 });
		await pane.getByRole("button", { name: "Compare" }).click();
		await expect(pane.getByRole("alert")).toHaveText(
			"Reading this file from the recovery point took too long. Try again, or restore the point to see it.",
		);

		// The choice is local: a reload compares with the last commit again.
		await page.reload();
		await page.getByTestId(`file-view-diff-${FILE}`).click();
		await expect(page.getByTestId("diff-sides")).toHaveText("Last commitYour changes");
		await expect(pane.getByLabel("Compare with")).toHaveValue("head");
	});
});
