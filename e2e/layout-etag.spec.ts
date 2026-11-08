import { expect, test } from "@playwright/test";
import {
	createProject,
	createStudent,
	expectConnected,
	newTerminal,
	query,
	terminalIds,
	workspacePath,
} from "./helpers";
import { splitPane } from "./split-helpers";

/**
 * Caddy's gzip rewrites the entity tag of a compressed response, so `"5"`
 * arrives as `"5-gzip"`. The saved layout must keep working through it
 * (SPEC.md §7.5, §6.8): a split survives leaving the project and coming back.
 */
test("a layout saved behind a gzip entity tag is still restored", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	const alpha = await createProject(student.workspaceId, { name: "Alpha" });
	const beta = await createProject(student.workspaceId, { name: "Beta" });

	const saves: number[] = [];
	await page.route("**/layout", async (route) => {
		const response = await route.fetch();
		const etag = response.headers().etag;
		const headers = { ...response.headers() };
		if (etag) headers.etag = etag.replace(/"$/, '-gzip"');
		await route.fulfill({ response, headers });
		if (route.request().method() === "PUT") saves.push(response.status());
	});

	await page.goto(workspacePath(student.workspaceId, alpha.id));
	await expect(page.getByTestId("work-tabs")).toBeVisible({ timeout: 15_000 });
	await newTerminal(page);
	await expect
		.poll(async () => (await terminalIds(student.workspaceId, alpha.id)).length)
		.toBe(1);
	const [first] = await terminalIds(student.workspaceId, alpha.id);
	if (!first) throw new Error("the terminal row was not created");
	await expectConnected(page, first);

	// The first save is based on version 0; the split is a second save, which
	// only works when the version in the first save's response was read.
	const savedLayout = async () => {
		const rows = await query<{ layout: unknown }>(
			"select layout from projects where id = $1",
			[alpha.id],
		);
		return JSON.stringify(rows[0]?.layout ?? null);
	};
	await expect
		.poll(async () => (await savedLayout()).includes(first), { timeout: 15_000 })
		.toBe(true);

	await splitPane(page, first, "right");
	await expect
		.poll(async () => (await terminalIds(student.workspaceId, alpha.id)).length)
		.toBe(2);
	const [, second] = await terminalIds(student.workspaceId, alpha.id);

	// Wait for the save that holds the split, so the switch does not race it.
	await expect
		.poll(
			async () => {
				const saved = await savedLayout();
				return (
					saved.includes('"direction":"row"') &&
					saved.includes(first) &&
					saved.includes(second as string)
				);
			},
			{ timeout: 15_000 },
		)
		.toBe(true);

	await page.getByTestId(`project-item-${beta.id}`).click();
	await expect(page).toHaveURL(workspacePath(student.workspaceId, beta.id));
	await page.getByTestId(`project-item-${alpha.id}`).click();

	// Both terminals are still side by side in one tab, and none moved out.
	await expect(page.getByTestId(`terminal-pane-${first}`)).toBeVisible({
		timeout: 15_000,
	});
	await expect(page.getByTestId(`terminal-pane-${second}`)).toBeVisible();
	await expect(page.getByTestId("work-tabs").getByRole("tab")).toHaveCount(1);

	expect(saves.length).toBeGreaterThan(0);
	expect(saves.every((status) => status === 204)).toBe(true);
});
