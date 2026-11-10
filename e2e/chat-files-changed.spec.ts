import { type BrowserContext, expect, type Page, test } from "@playwright/test";
import { scriptedChat } from "./chat-helpers";
import {
	createProject,
	createStudent,
	expectNoViolations,
	newTerminal,
	query,
	seedFile,
	seedGit,
	terminalIds,
	workspacePath,
	workTabs,
} from "./helpers";

/**
 * Under a finished turn that edited files, one quiet line says how many and
 * their counts; it opens to each path, which opens the file in the editor,
 * or in its diff when the project is a Git repository (SPEC.md §10.8,
 * §25.8). The socket is scripted with the turn's Edit and Write calls.
 */

const SLUG = "files-changed";
const ROOT = `/home/student/projects/${SLUG}`;

/** A chat tab in a new student's project, which is or is not a Git repository. */
async function openChat(
	page: Page,
	context: BrowserContext,
	gitInit: boolean,
	/** One more written file, outside the two the other tests count. */
	extra?: string,
) {
	const student = await createStudent(context);
	const project = await createProject(student.workspaceId, {
		name: "Files Changed",
		slug: SLUG,
		gitInit,
	});
	await seedFile(student.workspaceId, SLUG, "src/app.ts", "b\nc\n");
	await seedFile(student.workspaceId, SLUG, "notes.md", "one\ntwo\n");
	if (gitInit) {
		await seedGit(student.workspaceId, SLUG, {
			status: {
				repo: true,
				branch: "main",
				detached: false,
				upstream: null,
				ahead: 0,
				behind: 0,
				conflicts: 0,
				entries: [
					{ path: "src/app.ts", x: ".", y: "M", unmerged: false },
					{ path: "notes.md", x: "?", y: "?", unmerged: false },
				],
				ignored: [],
				truncated: false,
			},
			diffs: {
				"src/app.ts": {
					status: "M",
					before: "a\n",
					after: "b\nc\n",
					binary: false,
					tooLarge: false,
				},
			},
		});
	}
	await page.goto(workspacePath(student.workspaceId, project.id));
	await expect(workTabs(page)).toBeVisible({ timeout: 15_000 });
	await newTerminal(page);
	await expect
		.poll(async () => (await terminalIds(student.workspaceId, project.id)).length)
		.toBe(1);
	const [id] = await terminalIds(student.workspaceId, project.id);
	if (!id) throw new Error("the terminal row was not created");
	await query(
		"update terminals set kind = 'chat', agent = 'claude', name = 'Claude Code' where id = $1",
		[id],
	);
	await page.routeWebSocket(/\/chat$/, (ws) => {
		const send = scriptedChat(ws, "00000000-0000-4000-8000-000000000000");
		send("snapshot", { cards: [], turnRunning: false, truncated: false });
		send("message", { id: "u1", role: "user", markdown: "Fix the app" });
		send("turn.started", { at: Date.now() - 5_000 });
		send("tool.started", {
			id: "e1",
			name: "Edit",
			title: "Edit",
			input: { file_path: `${ROOT}/src/app.ts`, old_string: "a", new_string: "b" },
		});
		send("tool.finished", { id: "e1", isError: false });
		send("tool.started", {
			id: "w1",
			name: "Write",
			title: "Write",
			input: { file_path: `${ROOT}/notes.md`, content: "one\ntwo\n" },
		});
		send("tool.finished", { id: "w1", isError: false });
		if (extra !== undefined) {
			send("tool.started", {
				id: "w2",
				name: "Write",
				title: "Write",
				input: { file_path: `${ROOT}/${extra}`, content: "x\n" },
			});
			send("tool.finished", { id: "w2", isError: false });
		}
		send("tool.started", {
			id: "e2",
			name: "Edit",
			title: "Edit",
			input: { file_path: `${ROOT}/src/app.ts`, old_string: "x", new_string: "x\nc" },
		});
		send("tool.finished", { id: "e2", isError: false });
		send("message", { id: "a1", role: "assistant", markdown: "Fixed it." });
		send("turn.finished", { at: Date.now(), status: "done" });
		send("settings", {
			agent: "claude",
			model: "default",
			effort: "high",
			mode: "default",
		});
	});
	await page.reload();
	const view = page.getByTestId(`chat-view-${id}`);
	await expect(view.getByText("Fixed it.")).toBeVisible({ timeout: 15_000 });
	return view;
}

for (const colorScheme of ["light", "dark"] as const) {
	test(`a turn's changed files open by keyboard to their diffs (${colorScheme})`, async ({
		page,
		context,
	}) => {
		test.setTimeout(90_000);
		await page.emulateMedia({ colorScheme });
		const view = await openChat(page, context, true);
		const changed = view.getByTestId("chat-files-changed");
		const summary = changed.locator("> summary");
		// One quiet line; the counts are signs to the eye and words to a screen reader.
		await expect(summary).toHaveText(
			"2 files changed+4 −1, 4 lines added, 1 line removed",
		);
		await expect(summary.locator(".sr-only")).toHaveText(
			", 4 lines added, 1 line removed",
		);
		await expect(changed).not.toHaveAttribute("open", "");
		await summary.focus();
		await page.keyboard.press("Enter");
		await expect(changed.getByTestId("chat-changed-file")).toHaveText([
			"src/app.ts+2 −1, 2 lines added, 1 line removed",
			"notes.md+2 −0, 2 lines added, 0 lines removed",
		]);
		await expectNoViolations(page, `[data-testid^="chat-view-"]`);

		await page.keyboard.press("Tab");
		const app = changed.getByRole("button", { name: "src/app.ts" });
		await expect(app).toBeFocused();
		await page.keyboard.press("Enter");
		await expect(page.getByTestId("diff-pane-src/app.ts")).toBeVisible({
			timeout: 15_000,
		});
	});
}

test("outside a Git repository a changed file opens in the editor", async ({
	page,
	context,
}) => {
	test.setTimeout(90_000);
	const view = await openChat(page, context, false);
	const changed = view.getByTestId("chat-files-changed");
	await changed.locator("> summary").click();
	await changed.getByRole("button", { name: "notes.md" }).click();
	await expect(page.getByTestId("editor-notes.md")).toBeVisible({ timeout: 15_000 });
	await expect(page.getByTestId("diff-pane-notes.md")).toHaveCount(0);
});

test("a long path wraps whole in the narrow row instead of being cut off", async ({
	page,
	context,
}) => {
	test.setTimeout(90_000);
	await page.setViewportSize({ width: 420, height: 900 });
	const long = `${"a-very-long-directory-name/".repeat(5)}component-with-a-long-name.tsx`;
	const view = await openChat(page, context, false, long);
	const changed = view.getByTestId("chat-files-changed");
	await changed.locator("> summary").click();
	const path = changed.getByRole("button", { name: long });
	await expect(path).toBeVisible();
	const fit = await path.evaluate((node) => ({
		cut: node.scrollWidth - node.clientWidth,
		lines:
			node.getBoundingClientRect().height /
			Number.parseFloat(getComputedStyle(node).lineHeight),
	}));
	// Nothing hidden to the side, and the path took more than one line.
	expect(fit.cut).toBeLessThanOrEqual(0);
	expect(fit.lines).toBeGreaterThan(1.5);
	const overflow = await page.evaluate(() => {
		const log = document.querySelector<HTMLElement>(".pk-chat-scroll");
		return log ? log.scrollWidth - log.clientWidth : -1;
	});
	expect(overflow).toBeLessThanOrEqual(0);
	await expectNoViolations(page, `[data-testid^="chat-view-"]`);
});
