import { expect, test } from "@playwright/test";
import { MAX_LAYOUT_BYTES_PER_USER } from "../packages/contracts/src/project.ts";
import {
	createProject,
	createStudent,
	newTerminal,
	openFileTab,
	query,
} from "./helpers";

/**
 * A student whose saved layouts have reached the per-user cap is told once
 * that this layout was not saved (SPEC.md §7.5).
 */
test("a layout over the size limit is reported once, not on every save", async ({
	page,
	context,
}) => {
	const student = await createStudent(context);
	// Another project's layout already holds the whole allowance.
	const other = await createProject(student.workspaceId, { name: "Full" });
	await query("update projects set layout = $2 where id = $1", [
		other.id,
		JSON.stringify({ tabs: [], pad: "x".repeat(MAX_LAYOUT_BYTES_PER_USER) }),
	]);

	await openFileTab(page, student, "Over Limit", "notes.txt", "hello\n");
	const message = page.getByText(
		"Your saved tab layouts have reached their size limit",
		{
			exact: false,
		},
	);

	await newTerminal(page);
	await expect(message).toHaveCount(1, { timeout: 10_000 });

	// The next structural change is refused again, but the student was told.
	const refused = page.waitForResponse(
		(response) =>
			response.url().endsWith("/layout") &&
			response.request().method() === "PUT" &&
			response.status() === 413,
	);
	await newTerminal(page);
	await refused;
	await expect(message).toHaveCount(1);
});
